import {
  computeThumbprint,
  isPrivateJwk,
  PRIVATE_MEMBERS,
  rsaModulusLength,
  type Jwk,
  type Jwks,
} from './jwk';
import { algorithmSpec, isSupportedAlgorithm, isSupportedCurve, MIN_RSA_MODULUS_LENGTH } from './options';

/** Number of keys created when a JWKS is initialised. */
export const INITIAL_KEY_COUNT = 2;

/** Maximum number of keys a JWKS holds. */
export const MAX_KEY_COUNT = 3;

export class JwksValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwksValidationError';
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function assertJwk(value: unknown, index: number): asserts value is Jwk {
  const fail = (reason: string): never => {
    throw new JwksValidationError(`keys[${index}]: ${reason}`);
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('must be an object');
  }
  const jwk = value as Record<string, unknown>;
  if (!isNonEmptyString(jwk.kid)) fail('kid must be a non-empty string');
  if (jwk.use !== 'sig' && jwk.use !== 'enc') fail('use must be "sig" or "enc"');
  if (!isSupportedAlgorithm(jwk.alg)) fail(`unsupported alg "${String(jwk.alg)}"`);
  if (jwk.kty !== 'RSA' && jwk.kty !== 'EC') fail('kty must be "RSA" or "EC"');

  const spec = algorithmSpec(jwk.alg as Jwk['alg']);
  if (jwk.use !== spec.use) fail(`use "${String(jwk.use)}" does not match alg ${String(jwk.alg)}`);
  if (jwk.kty !== spec.keyType) fail(`kty "${String(jwk.kty)}" does not match alg ${String(jwk.alg)}`);

  if (jwk.kty === 'RSA') {
    if (!isNonEmptyString(jwk.n) || !isNonEmptyString(jwk.e)) fail('RSA key must have n and e');
    const modulusLength = rsaModulusLength(jwk);
    if (modulusLength < MIN_RSA_MODULUS_LENGTH) {
      fail(`RSA modulus is ${modulusLength} bits, less than ${MIN_RSA_MODULUS_LENGTH}`);
    }
  } else {
    if (!isSupportedCurve(jwk.crv)) fail(`unsupported crv "${String(jwk.crv)}"`);
    if (!spec.curveConfigurable && jwk.crv !== spec.curve) {
      fail(`crv "${String(jwk.crv)}" does not match alg ${String(jwk.alg)}`);
    }
    if (!isNonEmptyString(jwk.x) || !isNonEmptyString(jwk.y)) fail('EC key must have x and y');
  }
  if (jwk.d !== undefined && !isNonEmptyString(jwk.d)) fail('d must be a non-empty string when present');
  if (jwk.d === undefined) {
    // Without d, any other private member (e.g. RSA p and q) would still reveal the private key.
    const leaked = PRIVATE_MEMBERS.filter((member) => jwk[member] !== undefined);
    if (leaked.length > 0) fail(`public-only key must not have private members ${leaked.join(', ')}`);
  }

  if (jwk.kid !== computeThumbprint(jwk as unknown as Jwk)) {
    fail('kid does not match the RFC 7638 thumbprint of the key');
  }
}

/**
 * Asserts that a value is a well-formed JWKS as the rotating constructs store
 * it:
 * - 0 keys (not yet initialised), or 2 to 3 valid keys
 * - unique kids, each the RFC 7638 thumbprint of its key
 * - a single `use` across all keys
 * - with 3 `sig` keys, only index 0 is public-only; otherwise every key is private
 */
export function assertJwks(value: unknown): asserts value is Jwks {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new JwksValidationError('JWKS must be an object');
  }
  const keys = (value as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) {
    throw new JwksValidationError('JWKS must have a keys array');
  }
  if (keys.length === 0) {
    return;
  }
  if (keys.length < INITIAL_KEY_COUNT || keys.length > MAX_KEY_COUNT) {
    throw new JwksValidationError(
      `JWKS must have 0 or ${INITIAL_KEY_COUNT} to ${MAX_KEY_COUNT} keys, got ${keys.length}`,
    );
  }
  keys.forEach(assertJwk);
  const jwks = keys as Jwk[];

  const kids = new Set(jwks.map((jwk) => jwk.kid));
  if (kids.size !== jwks.length) {
    throw new JwksValidationError('kids must be unique');
  }
  const use = jwks[0].use;
  if (jwks.some((jwk) => jwk.use !== use)) {
    throw new JwksValidationError('all keys must have the same use');
  }
  jwks.forEach((jwk, index) => {
    const expectPrivate = !(use === 'sig' && jwks.length === MAX_KEY_COUNT && index === 0);
    if (isPrivateJwk(jwk) !== expectPrivate) {
      throw new JwksValidationError(
        `keys[${index}]: expected a ${expectPrivate ? 'private' : 'public-only'} key`,
      );
    }
  });
}

/** Parses and validates a secret or parameter value holding a JWKS. */
export function parseJwks(value: string): Jwks {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new JwksValidationError('value is not valid JSON');
  }
  assertJwks(parsed);
  return parsed;
}
