import { GetSecretValueCommand, ResourceNotFoundException } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, ParameterNotFound } from '@aws-sdk/client-ssm';
import {
  createEndpointHandler,
  initialiseEndpointHandler,
  handler as lambdaHandler,
  parseEndpointConfig,
  ENV,
  type EndpointConfig,
  type GatewayEvent,
} from '../../../../src/assets/lambda/handlers/endpoint';
import { SOURCES_ENV, type SourceConfig } from '../../../../src/assets/lambda/sources';
import type { Jwks } from '../../../../src/shared/jwks';
import { ENC, jwksAfter, kidsOf, SIG } from '../../../fixtures';

const SECRET: SourceConfig = {
  type: 'secret',
  id: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:sig-AbCdEf',
};
const PARAMETER: SourceConfig = { type: 'parameter', name: '/app/enc-jwks' };
const PATH = '/.well-known/jwks.json';

type Stored = Record<string, string | Error>;

/** In-memory Secrets Manager and Parameter Store, recording the commands they receive. */
function fakeClients(stored: Stored) {
  const secrets = jest.fn(async (command: unknown) => {
    if (!(command instanceof GetSecretValueCommand)) throw new Error('unexpected command');
    const value = stored[command.input.SecretId!];
    if (value instanceof Error) throw value;
    return { SecretString: value };
  });
  const parameters = jest.fn(async (command: unknown) => {
    if (!(command instanceof GetParameterCommand)) throw new Error('unexpected command');
    expect(command.input.WithDecryption).toBe(true);
    const value = stored[command.input.Name!];
    if (value instanceof Error) throw value;
    return { Parameter: { Value: value } };
  });
  return {
    secrets,
    parameters,
    clients: { secrets: { send: secrets }, parameters: { send: parameters } } as never,
  };
}

const jwksString = (jwks: Jwks) => JSON.stringify(jwks);

const config = (overrides: Partial<EndpointConfig> = {}): EndpointConfig => ({
  sources: [SECRET, PARAMETER],
  path: PATH,
  cacheSeconds: 0,
  logRequests: true,
  logClientDetails: true,
  ...overrides,
});

const v2 = (method = 'GET', rawPath = PATH, extra: Partial<GatewayEvent> = {}): GatewayEvent => ({
  rawPath,
  requestContext: {
    requestId: 'req-1',
    http: { method, sourceIp: '203.0.113.9', userAgent: 'OIDC-Server/1.0' },
  },
  headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' },
  ...extra,
});

const v1 = (httpMethod = 'GET', path = PATH): GatewayEvent => ({
  path,
  httpMethod,
  requestContext: { requestId: 'req-2', identity: { sourceIp: '192.0.2.1', userAgent: 'curl/8' } },
});

let output: string[];

beforeEach(() => {
  output = [];
  jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

const logged = () => output.map((line) => JSON.parse(line) as Record<string, unknown>);

async function twoSources() {
  const sig = await jwksAfter(SIG, 2);
  const enc = await jwksAfter(ENC, 2);
  const stored: Stored = {
    [(SECRET as { id: string }).id]: jwksString(sig),
    [(PARAMETER as { name: string }).name]: jwksString(enc),
  };
  return { sig, enc, stored };
}

describe('serving the JWKS', () => {
  test('serves the public sig and enc keys of both backends in one JWKS, in source order', async () => {
    const { sig, enc, stored } = await twoSources();
    const handler = createEndpointHandler(fakeClients(stored).clients, config());

    const response = await handler(v2());
    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual({ 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    const { keys } = JSON.parse(response.body!) as Jwks;
    // All 3 sig keys, and the enc keys except the oldest of 3.
    expect(keys.map((jwk) => jwk.kid)).toEqual([...kidsOf(sig), ...kidsOf(enc).slice(1)]);
    expect(keys.some((jwk) => 'd' in jwk || 'p' in jwk)).toBe(false);
  });

  test('answers the REST API proxy event shape as well', async () => {
    const { stored } = await twoSources();
    const handler = createEndpointHandler(fakeClients(stored).clients, config());
    const response = await handler(v1());
    expect(response.statusCode).toBe(200);
    expect(logged()[0]).toMatchObject({ 'source.ip': '192.0.2.1', 'user_agent.original': 'curl/8' });
  });

  test('serves a kid that two sources share once', async () => {
    const sig = await jwksAfter(SIG, 1);
    const stored: Stored = {
      [(SECRET as { id: string }).id]: jwksString(sig),
      [(PARAMETER as { name: string }).name]: jwksString(sig),
    };
    const handler = createEndpointHandler(fakeClients(stored).clients, config());
    const { keys } = JSON.parse((await handler(v2())).body!) as Jwks;
    expect(keys).toHaveLength(2);
  });

  test('HEAD has the headers and no body', async () => {
    const { stored } = await twoSources();
    const handler = createEndpointHandler(fakeClients(stored).clients, config());
    const response = await handler(v2('HEAD'));
    expect(response).toMatchObject({ statusCode: 200, body: '' });
  });

  test('serves an uninitialised secret as an empty JWKS, without caching it', async () => {
    const stored: Stored = { [(SECRET as { id: string }).id]: '{"keys":[]}' };
    const clients = fakeClients(stored);
    const handler = createEndpointHandler(clients.clients, config({ sources: [SECRET], cacheSeconds: 300 }));
    const response = await handler(v2());
    expect(JSON.parse(response.body!)).toEqual({ keys: [] });
    expect(response.headers!['Cache-Control']).toBe('no-cache');
    await handler(v2());
    expect(clients.secrets).toHaveBeenCalledTimes(2);
  });
});

describe('caching', () => {
  test('with a TTL of 0 reads every source on every request', async () => {
    const { stored } = await twoSources();
    const clients = fakeClients(stored);
    const handler = createEndpointHandler(clients.clients, config());
    await handler(v2());
    await handler(v2());
    expect(clients.secrets).toHaveBeenCalledTimes(2);
    expect(clients.parameters).toHaveBeenCalledTimes(2);
  });

  test('with a TTL, caches each source, sets max-age and logs the hit', async () => {
    const { stored } = await twoSources();
    const clients = fakeClients(stored);
    let now = 1_000_000;
    const handler = createEndpointHandler(clients.clients, config({ cacheSeconds: 300 }), { now: () => now });

    const first = await handler(v2());
    expect(first.headers!['Cache-Control']).toBe('public, max-age=300');
    now += 299_000;
    await handler(v2());
    expect(clients.secrets).toHaveBeenCalledTimes(1);
    expect(logged().map((record) => record['jwks.cache.hit'])).toEqual([false, true]);

    now += 2_000;
    await handler(v2());
    expect(clients.secrets).toHaveBeenCalledTimes(2);
  });
});

describe('failures', () => {
  test('answers 503 without caching when any source cannot be read, and serves no partial JWKS', async () => {
    const { sig } = await twoSources();
    const stored: Stored = {
      [(SECRET as { id: string }).id]: jwksString(sig),
      [(PARAMETER as { name: string }).name]: new ParameterNotFound({ message: 'gone', $metadata: {} }),
    };
    const handler = createEndpointHandler(fakeClients(stored).clients, config({ cacheSeconds: 300 }));

    const response = await handler(v2());
    expect(response).toEqual({ statusCode: 503, headers: { 'Cache-Control': 'no-store' } });
    expect(logged().at(-1)).toMatchObject({
      'event.action': 'serve_jwks',
      'event.outcome': 'failure',
      'event.type': ['error'],
      'event.reason': 'source_unavailable',
      'http.response.status_code': 503,
      'error.type': 'ParameterNotFound',
      'error.message': 'gone',
    });
  });

  test('a failed source is logged even with request logging off', async () => {
    const stored: Stored = {
      [(SECRET as { id: string }).id]: new ResourceNotFoundException({ message: 'gone', $metadata: {} }),
    };
    const handler = createEndpointHandler(
      fakeClients(stored).clients,
      config({ sources: [SECRET], logRequests: false }),
    );
    expect((await handler(v2())).statusCode).toBe(503);
    expect(logged()).toHaveLength(1);
  });

  test('does not log the message of an error that might echo a value', async () => {
    const stored: Stored = { [(SECRET as { id: string }).id]: new TypeError('d=PRIVATE') };
    const handler = createEndpointHandler(fakeClients(stored).clients, config({ sources: [SECRET] }));
    await handler(v2());
    expect(output.join('')).not.toContain('PRIVATE');
    expect(logged()[0]).toMatchObject({ 'error.type': 'TypeError' });
    expect(logged()[0]).not.toHaveProperty('error.message');
  });

  test('answers 503 for a value that is not a valid JWKS', async () => {
    const stored: Stored = { [(SECRET as { id: string }).id]: 'not json' };
    const handler = createEndpointHandler(fakeClients(stored).clients, config({ sources: [SECRET] }));
    expect((await handler(v2())).statusCode).toBe(503);
    expect(logged()[0]).toMatchObject({ 'error.type': 'JwksValidationError' });
  });

  test('answers 503 for a secret with no string, and a parameter with no value', async () => {
    const secret = createEndpointHandler(
      { secrets: { send: async () => ({}) }, parameters: { send: jest.fn() } },
      config({ sources: [SECRET] }),
    );
    const parameter = createEndpointHandler(
      { secrets: { send: jest.fn() }, parameters: { send: async () => ({}) } },
      config({ sources: [PARAMETER] }),
    );
    expect((await secret(v2())).statusCode).toBe(503);
    expect((await parameter(v2())).statusCode).toBe(503);
  });

  test('answers 405 with Allow for other methods, without reading a source', async () => {
    const clients = fakeClients({});
    const handler = createEndpointHandler(clients.clients, config());
    expect(await handler(v2('POST'))).toEqual({
      statusCode: 405,
      headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' },
    });
    expect(clients.secrets).not.toHaveBeenCalled();
    expect(logged()[0]).toMatchObject({
      'event.outcome': 'failure',
      'event.type': ['access'],
      'event.reason': 'method_not_allowed',
      'http.response.status_code': 405,
    });
  });

  test('answers 404 for any other path', async () => {
    const clients = fakeClients({});
    const handler = createEndpointHandler(clients.clients, config());
    expect((await handler(v2('GET', '/other'))).statusCode).toBe(404);
    expect((await handler({ requestContext: { http: { method: 'GET' } } })).statusCode).toBe(404);
    expect(clients.secrets).not.toHaveBeenCalled();
    expect(logged()[0]).toMatchObject({ 'event.reason': 'not_found', 'url.path': '/other' });
  });

  test('does not log client errors with request logging off', async () => {
    const handler = createEndpointHandler(fakeClients({}).clients, config({ logRequests: false }));
    await handler(v2('POST'));
    await handler(v2('GET', '/other'));
    expect(output).toEqual([]);
  });
});

describe('the access record', () => {
  test('is one ECS web event per request with the standard HTTP and client fields', async () => {
    const { stored } = await twoSources();
    let tick = 0n;
    const handler = createEndpointHandler(fakeClients(stored).clients, config(), {
      hrtime: () => (tick += 4_200_000n),
    });
    await handler(v2());

    expect(output).toHaveLength(1);
    expect(logged()[0]).toMatchObject({
      'ecs.version': '8.11.0',
      'event.category': ['web'],
      'event.type': ['access'],
      'event.action': 'serve_jwks',
      'event.outcome': 'success',
      'event.id': 'req-1',
      'event.duration': 4_200_000,
      'http.request.method': 'GET',
      'url.path': PATH,
      'http.response.status_code': 200,
      'http.response.body.bytes': expect.any(Number),
      'source.ip': '203.0.113.9',
      'network.forwarded_ip': '198.51.100.7',
      'user_agent.original': 'OIDC-Server/1.0',
      'jwks.keys': 5,
      'jwks.sources': 2,
      'jwks.cache.hit': false,
    });
  });

  test('leaves out the client details when asked', async () => {
    const { stored } = await twoSources();
    const handler = createEndpointHandler(fakeClients(stored).clients, config({ logClientDetails: false }));
    await handler(v2());
    const record = logged()[0];
    expect(record).not.toHaveProperty('source.ip');
    expect(record).not.toHaveProperty('user_agent.original');
    expect(record).not.toHaveProperty('network.forwarded_ip');
    expect(record['http.request.method']).toBe('GET');
  });

  test('writes nothing per request when request logging is off', async () => {
    const { stored } = await twoSources();
    const handler = createEndpointHandler(fakeClients(stored).clients, config({ logRequests: false }));
    await handler(v2());
    expect(output).toEqual([]);
  });

  test('keeps a path with line breaks and quotes on one line, and truncates it', async () => {
    const handler = createEndpointHandler(fakeClients({}).clients, config());
    await handler(v2('GET', `/x\r\n{"forged":true}${'a'.repeat(400)}`));
    expect(output).toHaveLength(1);
    const record = logged()[0];
    expect(record).not.toHaveProperty('forged');
    expect(String(record['url.path']).length).toBe(256);
  });

  test('never logs key material', async () => {
    const { sig, stored } = await twoSources();
    const handler = createEndpointHandler(fakeClients(stored).clients, config());
    await handler(v2());
    const secrets = sig.keys.flatMap((jwk) => [(jwk as unknown as Record<string, string>).d]).filter(Boolean);
    expect(secrets.filter((value) => output.join('').includes(value))).toEqual([]);
  });
});

describe('configuration', () => {
  const env = {
    [ENV.path]: PATH,
    [ENV.cacheSeconds]: '300',
    [SOURCES_ENV]: JSON.stringify([
      { type: 'secret', id: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:s' },
      { type: 'parameter', name: '/p' },
    ]),
  };

  test('is read from the environment, with request logging and client details on by default', () => {
    expect(parseEndpointConfig(env)).toEqual({
      sources: [
        { type: 'secret', id: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:s' },
        { type: 'parameter', name: '/p' },
      ],
      path: PATH,
      cacheSeconds: 300,
      logRequests: true,
      logClientDetails: true,
    });
    expect(
      parseEndpointConfig({
        ...env,
        [ENV.logRequests]: 'false',
        [ENV.logClientDetails]: 'false',
        [ENV.cacheSeconds]: undefined,
      }),
    ).toMatchObject({ logRequests: false, logClientDetails: false, cacheSeconds: 0 });
  });

  test.each([
    [{ [ENV.path]: 'jwks.json' }, /must be a path starting with/],
    [{ [ENV.path]: undefined }, /must be a path starting with/],
    [{ [ENV.cacheSeconds]: '-1' }, /non-negative integer/],
    [{ [ENV.cacheSeconds]: '1.5' }, /non-negative integer/],
    [{ [SOURCES_ENV]: undefined }, /is not set/],
    [{ [SOURCES_ENV]: '' }, /is not set/],
    [{ [SOURCES_ENV]: 'nope' }, /not valid JSON/],
    [{ [SOURCES_ENV]: '[]' }, /non-empty array/],
    [{ [SOURCES_ENV]: '{}' }, /non-empty array/],
    [{ [SOURCES_ENV]: '[{"type":"bucket"}]' }, /must be a secret with an id or a parameter with a name/],
    [{ [SOURCES_ENV]: '[null]' }, /must be a secret with an id or a parameter with a name/],
    [{ [SOURCES_ENV]: '[{"type":"parameter","name":""}]' }, /must be a secret/],
  ])('rejects %j', (override, message) => {
    expect(() => parseEndpointConfig({ ...env, ...override })).toThrow(message);
  });

  test('a function with bad configuration logs a failed start and throws', () => {
    expect(() => initialiseEndpointHandler(fakeClients({}).clients, {})).toThrow(
      /must be a path starting with/,
    );
    expect(logged().at(-1)).toMatchObject({
      'event.action': 'start_function',
      'event.outcome': 'failure',
      'event.type': ['error'],
    });
  });

  test('the Lambda entry point configures itself from the environment, once', async () => {
    Object.assign(process.env, env);
    try {
      // No client is reachable in tests, so only the routing is exercised.
      expect((await lambdaHandler(v2('POST'))).statusCode).toBe(405);
      expect((await lambdaHandler(v2('GET', '/other'))).statusCode).toBe(404);
      expect(logged().filter((record) => record['event.action'] === 'start_function')).toHaveLength(1);
      expect(logged()[0]).toMatchObject({ 'jwks.sources': 2, 'jwks.cache.ttl_seconds': 300 });
    } finally {
      for (const name of Object.keys(env)) delete process.env[name];
    }
  });
});
