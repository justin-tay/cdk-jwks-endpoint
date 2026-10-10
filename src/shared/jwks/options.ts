export type JwkPublicKeyUse = 'sig' | 'enc';

export type JwkKeyType = 'RSA' | 'EC';

export type JwkEcCurve = 'P-256' | 'P-384' | 'P-521';

export type JwkAlgorithm =
  | 'RS256'
  | 'RS384'
  | 'RS512'
  | 'PS256'
  | 'PS384'
  | 'PS512'
  | 'ES256'
  | 'ES384'
  | 'ES512'
  | 'RSA-OAEP-256'
  | 'ECDH-ES'
  | 'ECDH-ES+A128KW'
  | 'ECDH-ES+A192KW'
  | 'ECDH-ES+A256KW';

interface AlgorithmSpec {
  readonly use: JwkPublicKeyUse;
  readonly keyType: JwkKeyType;
  /** Curve implied by the algorithm (the default when the curve is configurable). */
  readonly curve?: JwkEcCurve;
  /** Whether the curve may be chosen, i.e. the algorithm does not pin it. */
  readonly curveConfigurable?: boolean;
}

const ALGORITHMS: Readonly<Record<JwkAlgorithm, AlgorithmSpec>> = {
  RS256: { use: 'sig', keyType: 'RSA' },
  RS384: { use: 'sig', keyType: 'RSA' },
  RS512: { use: 'sig', keyType: 'RSA' },
  PS256: { use: 'sig', keyType: 'RSA' },
  PS384: { use: 'sig', keyType: 'RSA' },
  PS512: { use: 'sig', keyType: 'RSA' },
  ES256: { use: 'sig', keyType: 'EC', curve: 'P-256' },
  ES384: { use: 'sig', keyType: 'EC', curve: 'P-384' },
  ES512: { use: 'sig', keyType: 'EC', curve: 'P-521' },
  'RSA-OAEP-256': { use: 'enc', keyType: 'RSA' },
  'ECDH-ES': { use: 'enc', keyType: 'EC', curve: 'P-256', curveConfigurable: true },
  'ECDH-ES+A128KW': { use: 'enc', keyType: 'EC', curve: 'P-256', curveConfigurable: true },
  'ECDH-ES+A192KW': { use: 'enc', keyType: 'EC', curve: 'P-256', curveConfigurable: true },
  'ECDH-ES+A256KW': { use: 'enc', keyType: 'EC', curve: 'P-256', curveConfigurable: true },
};

export const SUPPORTED_EC_CURVES: readonly JwkEcCurve[] = ['P-256', 'P-384', 'P-521'];

export const MIN_RSA_MODULUS_LENGTH = 2048;

export function isSupportedAlgorithm(value: unknown): value is JwkAlgorithm {
  return typeof value === 'string' && Object.hasOwn(ALGORITHMS, value);
}

export function isSupportedCurve(value: unknown): value is JwkEcCurve {
  return SUPPORTED_EC_CURVES.includes(value as JwkEcCurve);
}

/** The public key use and key type implied by an algorithm. */
export function algorithmSpec(algorithm: JwkAlgorithm): {
  readonly use: JwkPublicKeyUse;
  readonly keyType: JwkKeyType;
  readonly curve?: JwkEcCurve;
  readonly curveConfigurable: boolean;
} {
  const spec = ALGORITHMS[algorithm];
  return { ...spec, curveConfigurable: spec.curveConfigurable ?? false };
}
