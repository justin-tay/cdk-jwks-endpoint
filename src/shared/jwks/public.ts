import { toPublicJwk, type Jwks } from './jwk';
import { MAX_KEY_COUNT } from './validate';

/**
 * The JWKS to serve from the JWKS endpoint: the keys the OpenID Connect
 * server may use, without private members.
 *
 * - `sig`: every key. The retired key stays published so assertions signed
 *   by a server instance with a cached copy still verify.
 * - `enc`: every key except the oldest once there are 3. The oldest is
 *   dropped at the next rotation, so it is unpublished one rotation early
 *   while its private key is kept to decrypt anything still encrypted to it.
 *
 * This is the rule `cdk-jwks-secret` and `cdk-jwks-parameter` document, and
 * `test/shared/jwks/public.test.ts` pins it. Pass a JWKS obtained from
 * `parseJwks`; this function does not re-validate.
 */
export function toPublicJwks(jwks: Jwks): Jwks {
  const { keys } = jwks;
  const published = keys[0]?.use === 'enc' && keys.length === MAX_KEY_COUNT ? keys.slice(1) : keys;
  return { keys: published.map(toPublicJwk) };
}
