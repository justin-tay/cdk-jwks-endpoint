/**
 * End-to-end test against a real AWS account: deploys the example app with one
 * public exposure, checks what the endpoint serves once the secret and the
 * parameter hold keys, checks that its log group holds bare ECS access records
 * and no key material, then destroys the stack.
 *
 * Uses the AWS credentials and region of the current environment, and costs a
 * few cents. Run with `npm run test:aws`. Options:
 *
 *   --exposure=functionUrl|cloudFront|httpApi|restApi   (default functionUrl)
 *   --sig-source=parameter|secret                       (default parameter, which is free)
 *   --keep                                              skip the destroy
 *
 * The private REST API is not tested here: calling it needs a client inside
 * the VPC. CloudFront takes several minutes to deploy.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const STACK = 'JwksEndpointExampleApp';
const PUBLIC_EXPOSURES = ['functionUrl', 'cloudFront', 'httpApi', 'restApi'] as const;
const TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 5000;
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi'];

interface PublicJwk {
  readonly kid: string;
  readonly use: 'sig' | 'enc';
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function cdk(...args: string[]): void {
  const result = spawnSync('npx', ['cdk', ...args], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(`cdk ${args[0]} failed with exit code ${result.status}`);
  }
}

function check(condition: boolean, description: string): void {
  if (!condition) {
    throw new Error(`Failed: ${description}`);
  }
  console.log(`✓ ${description}`);
}

async function fetchKeys(url: string): Promise<PublicJwk[]> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} returned ${response.status}`);
  }
  const { keys } = (await response.json()) as { keys: Record<string, unknown>[] };
  const leaked = keys.filter((jwk) => PRIVATE_MEMBERS.some((member) => member in jwk));
  if (leaked.length > 0) {
    throw new Error(
      `The endpoint serves private members of: ${leaked.map((jwk) => String(jwk.kid)).join(', ')}`,
    );
  }
  return keys as unknown as PublicJwk[];
}

/** Polls until the secret's first rotation and the parameter's creation are both visible. */
async function waitForKeys(url: string): Promise<PublicJwk[]> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    try {
      const keys = await fetchKeys(url);
      const sig = keys.filter((jwk) => jwk.use === 'sig');
      const enc = keys.filter((jwk) => jwk.use === 'enc');
      if (sig.length === 2 && enc.length === 2) {
        return keys;
      }
    } catch (error) {
      // A new distribution or API takes a while to answer.
      if (Date.now() > deadline) throw error;
    }
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for 2 sig and 2 enc keys');
    }
    await sleep(POLL_MS);
  }
}

async function main(): Promise<void> {
  const keep = process.argv.includes('--keep');
  const exposure =
    process.argv.find((arg) => arg.startsWith('--exposure='))?.slice('--exposure='.length) ?? 'functionUrl';
  if (!(PUBLIC_EXPOSURES as readonly string[]).includes(exposure)) {
    throw new Error(`--exposure must be one of ${PUBLIC_EXPOSURES.join(', ')}`);
  }
  const sigSource =
    process.argv.find((arg) => arg.startsWith('--sig-source='))?.slice('--sig-source='.length) ?? 'parameter';
  if (sigSource !== 'parameter' && sigSource !== 'secret') {
    throw new Error('--sig-source must be parameter or secret');
  }
  const context = ['-c', `exposure=${exposure}`, '-c', `sigSource=${sigSource}`];
  const outDir = mkdtempSync(path.join(tmpdir(), 'jwks-endpoint-test-aws-'));
  const outputsFile = path.join(outDir, 'outputs.json');
  const logs = new CloudWatchLogsClient({});
  try {
    cdk('deploy', STACK, ...context, '--require-approval', 'never', '--outputs-file', outputsFile);
    const outputs = JSON.parse(readFileSync(outputsFile, 'utf8'))[STACK] as Record<string, string>;
    const url = outputs.JwksUrl;
    console.log(`Endpoint: ${url}`);

    const keys = await waitForKeys(url);
    check(
      keys.length === 4,
      `the endpoint serves 2 sig keys (${sigSource}) and 2 enc keys (parameter) over ${exposure}`,
    );

    const response = await fetch(url);
    check(response.status === 200, 'GET answers 200');
    check(
      (response.headers.get('content-type') ?? '').startsWith('application/json'),
      'the response is application/json',
    );
    check(
      /max-age=\d+|no-cache/.test(response.headers.get('cache-control') ?? ''),
      'the response carries a Cache-Control',
    );

    // The gateways route GET only, so only a Function URL and CloudFront answer HEAD.
    const head = await fetch(url, { method: 'HEAD' });
    if (exposure === 'functionUrl' || exposure === 'cloudFront') {
      check(head.status === 200, 'HEAD answers 200');
    } else {
      check(
        head.status >= 400 && head.status < 500,
        `HEAD is refused by the gateway, which routes GET only (${head.status})`,
      );
    }

    const post = await fetch(url, { method: 'POST' });
    const other = await fetch(new URL('/other', url));
    if (exposure === 'functionUrl') {
      check(post.status === 405, 'POST is answered 405 by the Lambda');
      check(other.status === 404, 'another path is answered 404 by the Lambda');
    } else {
      check(post.status >= 400 && post.status < 500, `POST is refused by the front door (${post.status})`);
      check(other.status >= 400 && other.status < 500, `another path is refused (${other.status})`);
    }

    // The stored values are not served: compare the kids with the sources themselves.
    const secrets = new SecretsManagerClient({});
    const parameters = new SSMClient({});
    const readParameter = async (name: string) => {
      const { Parameter } = await parameters.send(
        new GetParameterCommand({ Name: name, WithDecryption: true }),
      );
      return (JSON.parse(Parameter?.Value ?? '{}') as { keys: Record<string, string>[] }).keys;
    };
    const readSecret = async (secretId: string) => {
      const { SecretString } = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
      return (JSON.parse(SecretString ?? '{}') as { keys: Record<string, string>[] }).keys;
    };
    const sigKeys =
      sigSource === 'secret'
        ? await readSecret(outputs.SigSecretArn)
        : await readParameter(outputs.SigParameterName);
    const stored = [...sigKeys, ...(await readParameter(outputs.EncParameterName))];
    check(
      JSON.stringify(keys.map((jwk) => jwk.kid)) === JSON.stringify(stored.map((jwk) => jwk.kid)),
      'the served kids are the kids in the sources themselves, in order',
    );

    // Access records: one ECS event per request, bare JSON lines, no key material.
    const deadline = Date.now() + TIMEOUT_MS;
    let records: Record<string, unknown>[] = [];
    let messages: string[] = [];
    do {
      const page = await logs.send(new FilterLogEventsCommand({ logGroupName: outputs.EndpointLogGroup }));
      messages = (page.events ?? []).map((event) => (event.message ?? '').trimEnd());
      const lines = messages.filter(
        (message) => message !== '' && !/^(INIT_START|START|END|REPORT|XRAY)\b/.test(message),
      );
      records = lines.map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          throw new Error(`A log line is not a bare JSON record: ${line}`);
        }
      });
      if (records.some((record) => record['event.action'] === 'serve_jwks')) break;
      await sleep(POLL_MS);
    } while (Date.now() < deadline);

    check(
      records.every((record) => 'ecs.version' in record),
      'every log line is an ECS record',
    );
    check(
      records.some(
        (record) => record['event.action'] === 'start_function' && record['event.outcome'] === 'success',
      ),
      'the cold start was logged',
    );
    const access = records.find(
      (record) => record['event.action'] === 'serve_jwks' && record['http.response.status_code'] === 200,
    );
    check(
      access !== undefined &&
        access['http.request.method'] !== undefined &&
        access['url.path'] !== undefined &&
        typeof access['event.duration'] === 'number' &&
        access['jwks.keys'] === 4,
      'a request was logged with the standard ECS HTTP fields',
    );
    const output = messages.join('\n');
    const leaked = stored.some((jwk) =>
      PRIVATE_MEMBERS.some((member) => jwk[member] && output.includes(jwk[member])),
    );
    check(!leaked, 'no private key member was logged');

    console.log('All checks passed.');
  } finally {
    if (keep) {
      console.log(`--keep: not destroying ${STACK}.`);
    } else {
      cdk('destroy', STACK, '--force', ...context);
    }
    rmSync(outDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
