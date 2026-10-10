import { GetSecretValueCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, type SSMClient } from '@aws-sdk/client-ssm';
import { JwksValidationError, parseJwks, type Jwks } from '../../shared/jwks';

/** Environment variable through which the construct passes the sources to the Lambda. */
export const SOURCES_ENV = 'JWKS_SOURCES';

/** A place a JWKS is stored: a Secrets Manager secret (by ARN) or an SSM parameter (by name). */
export type SourceConfig =
  | { readonly type: 'secret'; readonly id: string }
  | { readonly type: 'parameter'; readonly name: string };

/** The identifier of a source, for the cache. */
export function sourceKey(source: SourceConfig): string {
  return source.type === 'secret' ? `secret:${source.id}` : `parameter:${source.name}`;
}

/** Parses the sources the construct serialised into the Lambda's environment. */
export function parseSources(json: string | undefined): SourceConfig[] {
  if (json === undefined || json === '') {
    throw new Error(`${SOURCES_ENV} is not set`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`${SOURCES_ENV} is not valid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${SOURCES_ENV} must be a non-empty array`);
  }
  return parsed.map((entry: unknown, index) => {
    const source = entry as Record<string, unknown>;
    if (source?.type === 'secret' && typeof source.id === 'string' && source.id !== '') {
      return { type: 'secret', id: source.id };
    }
    if (source?.type === 'parameter' && typeof source.name === 'string' && source.name !== '') {
      return { type: 'parameter', name: source.name };
    }
    throw new Error(`${SOURCES_ENV}[${index}] must be a secret with an id or a parameter with a name`);
  });
}

export interface SourceClients {
  readonly secrets: Pick<SecretsManagerClient, 'send'>;
  readonly parameters: Pick<SSMClient, 'send'>;
}

/** Reads and validates the JWKS a source holds. */
export async function readJwks(clients: SourceClients, source: SourceConfig): Promise<Jwks> {
  if (source.type === 'secret') {
    const { SecretString } = await clients.secrets.send(new GetSecretValueCommand({ SecretId: source.id }));
    if (SecretString === undefined) {
      throw new JwksValidationError('the secret has no secret string');
    }
    return parseJwks(SecretString);
  }
  const { Parameter } = await clients.parameters.send(
    new GetParameterCommand({ Name: source.name, WithDecryption: true }),
  );
  if (Parameter?.Value === undefined) {
    throw new JwksValidationError('the parameter has no value');
  }
  return parseJwks(Parameter.Value);
}
