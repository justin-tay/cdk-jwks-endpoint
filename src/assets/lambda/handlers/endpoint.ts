import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SSMClient } from '@aws-sdk/client-ssm';
import { toPublicJwks, type Jwk, type Jwks } from '../../../shared/jwks';
import { errorFields, logEvent, type EventReason, type LogFields } from '../logger';
import {
  parseSources,
  readJwks,
  SOURCES_ENV,
  sourceKey,
  type SourceClients,
  type SourceConfig,
} from '../sources';

/** Environment variables through which the construct configures the Lambda. */
export const ENV = {
  path: 'JWKS_PATH',
  cacheSeconds: 'JWKS_CACHE_SECONDS',
  logRequests: 'JWKS_LOG_REQUESTS',
  logClientDetails: 'JWKS_LOG_CLIENT_DETAILS',
} as const;

/**
 * The event of a Function URL or an HTTP API (payload format 2.0), or of a
 * REST API Lambda proxy integration. Only the members the handler reads.
 */
export interface GatewayEvent {
  // Payload format 2.0 (Function URL, HTTP API)
  readonly rawPath?: string;
  // REST API proxy integration
  readonly path?: string;
  readonly httpMethod?: string;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly requestContext?: {
    readonly requestId?: string;
    readonly http?: { readonly method?: string; readonly sourceIp?: string; readonly userAgent?: string };
    readonly identity?: { readonly sourceIp?: string; readonly userAgent?: string };
  };
}

export interface GatewayResult {
  readonly statusCode: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

export interface EndpointConfig {
  readonly sources: readonly SourceConfig[];
  readonly path: string;
  /** How long a source is cached, and the `Cache-Control` max-age. 0 disables caching. */
  readonly cacheSeconds: number;
  /** Log every request; failures of the sources are logged regardless. */
  readonly logRequests: boolean;
  /** Include `source.ip` and `user_agent.original`. */
  readonly logClientDetails: boolean;
}

export interface EndpointDependencies {
  readonly now?: () => number;
  readonly hrtime?: () => bigint;
}

const MAX_LOGGED_PATH_LENGTH = 256;

interface Cached {
  readonly jwks: Jwks;
  readonly expiresAt: number;
}

export function parseEndpointConfig(env: NodeJS.ProcessEnv): EndpointConfig {
  const path = env[ENV.path];
  if (!path?.startsWith('/')) {
    throw new Error(`${ENV.path} must be a path starting with /`);
  }
  const cacheSeconds = Number(env[ENV.cacheSeconds] ?? '0');
  if (!Number.isInteger(cacheSeconds) || cacheSeconds < 0) {
    throw new Error(`${ENV.cacheSeconds} must be a non-negative integer`);
  }
  return {
    sources: parseSources(env[SOURCES_ENV]),
    path,
    cacheSeconds,
    logRequests: env[ENV.logRequests] !== 'false',
    logClientDetails: env[ENV.logClientDetails] !== 'false',
  };
}

/** Removes later keys whose `kid` an earlier key already has. */
function uniqueByKid(keys: readonly Jwk[]): Jwk[] {
  const seen = new Set<string>();
  return keys.filter((key) => {
    if (seen.has(key.kid)) {
      return false;
    }
    seen.add(key.kid);
    return true;
  });
}

export function createEndpointHandler(
  clients: SourceClients,
  config: EndpointConfig,
  dependencies: EndpointDependencies = {},
): (event: GatewayEvent) => Promise<GatewayResult> {
  const now = dependencies.now ?? Date.now;
  const hrtime = dependencies.hrtime ?? (() => process.hrtime.bigint());
  const cache = new Map<string, Cached>();

  /** Reads a source through the cache; an empty JWKS is not cached, so initialisation shows up at once. */
  async function getJwks(source: SourceConfig): Promise<{ jwks: Jwks; hit: boolean }> {
    const key = sourceKey(source);
    const cached = cache.get(key);
    if (cached && now() < cached.expiresAt) {
      return { jwks: cached.jwks, hit: true };
    }
    const jwks = await readJwks(clients, source);
    if (config.cacheSeconds > 0 && jwks.keys.length > 0) {
      cache.set(key, { jwks, expiresAt: now() + config.cacheSeconds * 1000 });
    } else {
      cache.delete(key);
    }
    return { jwks, hit: false };
  }

  function accessFields(event: GatewayEvent, method: string, path: string): LogFields {
    const http = event.requestContext?.http;
    const identity = event.requestContext?.identity;
    const forwardedFor = event.headers?.['x-forwarded-for']?.split(',')[0]?.trim();
    return {
      'event.id': event.requestContext?.requestId,
      'http.request.method': method,
      'url.path': path.slice(0, MAX_LOGGED_PATH_LENGTH),
      ...(config.logClientDetails && {
        'source.ip': http?.sourceIp ?? identity?.sourceIp,
        'network.forwarded_ip': forwardedFor || undefined,
        'user_agent.original': http?.userAgent ?? identity?.userAgent,
      }),
    };
  }

  return async (event) => {
    const started = hrtime();
    const method = (event.requestContext?.http?.method ?? event.httpMethod ?? '').toUpperCase();
    const path = event.rawPath ?? event.path ?? '';
    const base = accessFields(event, method, path);
    const duration = () => ({ 'event.duration': Number(hrtime() - started) });

    /** A response without a body from the JWKS: a client error, logged as an access that failed. */
    function clientError(statusCode: number, reason: EventReason, headers: Record<string, string>) {
      if (config.logRequests) {
        logEvent('serve_jwks', 'failure', `${statusCode} ${reason}`, {
          ...base,
          ...duration(),
          'event.type': ['access'],
          'event.reason': reason,
          'http.response.status_code': statusCode,
        });
      }
      return { statusCode, headers };
    }

    if (path !== config.path) {
      return clientError(404, 'not_found', { 'Cache-Control': 'no-store' });
    }
    if (method !== 'GET' && method !== 'HEAD') {
      return clientError(405, 'method_not_allowed', { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
    }

    let results: { jwks: Jwks; hit: boolean }[];
    try {
      results = await Promise.all(config.sources.map(getJwks));
    } catch (error) {
      // All or nothing: a partial JWKS could be cached without a key, e.g. the enc key.
      logEvent('serve_jwks', 'failure', 'a source could not be read', {
        ...base,
        ...duration(),
        ...errorFields(error),
        'event.reason': 'source_unavailable',
        'http.response.status_code': 503,
      });
      return { statusCode: 503, headers: { 'Cache-Control': 'no-store' } };
    }

    // toPublicJwks applies the publishing rule of each source's use (sig or enc).
    const keys = uniqueByKid(results.flatMap(({ jwks }) => toPublicJwks(jwks).keys));
    const cacheable = config.cacheSeconds > 0 && results.every(({ jwks }) => jwks.keys.length > 0);
    const body = JSON.stringify({ keys });
    const cacheControl = cacheable ? `public, max-age=${config.cacheSeconds}` : 'no-cache';

    if (config.logRequests) {
      logEvent('serve_jwks', 'success', 'served the JWKS', {
        ...base,
        ...duration(),
        'http.response.status_code': 200,
        'http.response.body.bytes': Buffer.byteLength(body),
        'jwks.keys': keys.length,
        'jwks.sources': config.sources.length,
        'jwks.cache.hit': results.every(({ hit }) => hit),
      });
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': cacheControl },
      body: method === 'HEAD' ? '' : body,
    };
  };
}

let endpointHandler: ReturnType<typeof createEndpointHandler> | undefined;

export function initialiseEndpointHandler(
  clients: SourceClients = { secrets: new SecretsManagerClient({}), parameters: new SSMClient({}) },
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof createEndpointHandler> {
  try {
    const config = parseEndpointConfig(env);
    const created = createEndpointHandler(clients, config);
    logEvent('start_function', 'success', 'endpoint function started', {
      'jwks.sources': config.sources.length,
      'jwks.cache.ttl_seconds': config.cacheSeconds,
      'url.path': config.path,
    });
    return created;
  } catch (error) {
    logEvent('start_function', 'failure', 'endpoint function failed to start', errorFields(error));
    throw error;
  }
}

export async function handler(event: GatewayEvent): Promise<GatewayResult> {
  endpointHandler ??= initialiseEndpointHandler();
  return endpointHandler(event);
}
