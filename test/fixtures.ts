import { resolveJwkOptions, rotateJwks, type JwkOptions, type Jwks } from 'cdk-jwks-secret/jwks';

/**
 * JWKS as `cdk-jwks-secret` and `cdk-jwks-parameter` store them, made by the
 * published package so the tests do not check this package against itself.
 * `rotations` is how many rotations the JWKS has been through, the first of
 * which initialises it (2 keys).
 */
export async function jwksAfter(options: JwkOptions, rotations: number): Promise<Jwks> {
  const resolved = resolveJwkOptions(options);
  let jwks: Jwks = { keys: [] };
  for (let index = 0; index < rotations; index++) {
    jwks = await rotateJwks(jwks, resolved);
  }
  return jwks;
}

export const SIG: JwkOptions = { use: 'sig' };

export const ENC: JwkOptions = { use: 'enc' };

export const kidsOf = (jwks: Jwks): string[] => jwks.keys.map((jwk) => jwk.kid);
