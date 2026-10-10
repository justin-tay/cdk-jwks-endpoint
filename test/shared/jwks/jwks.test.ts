import { parseJwks, toPublicJwks } from '../../../src/shared/jwks';
import { ENC, jwksAfter, kidsOf, SIG } from '../../fixtures';

const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'];

const hasPrivateMember = (jwks: { keys: readonly object[] }) =>
  jwks.keys.some((jwk) => PRIVATE_MEMBERS.some((member) => member in jwk));

describe('the publish rule, which the rotating constructs document', () => {
  test.each([[1], [2], [3], [4]])(
    'sig after %d rotations publishes every key, public members only',
    async (rotations) => {
      const jwks = await jwksAfter(SIG, rotations);
      const published = toPublicJwks(jwks);
      expect(kidsOf(published)).toEqual(kidsOf(jwks));
      expect(hasPrivateMember(published)).toBe(false);
    },
  );

  test('enc with 2 keys publishes both', async () => {
    const jwks = await jwksAfter(ENC, 1);
    expect(jwks.keys).toHaveLength(2);
    expect(kidsOf(toPublicJwks(jwks))).toEqual(kidsOf(jwks));
  });

  test.each([[2], [3], [4]])(
    'enc with 3 keys (after %d rotations) withholds the oldest',
    async (rotations) => {
      const jwks = await jwksAfter(ENC, rotations);
      expect(jwks.keys).toHaveLength(3);
      const published = toPublicJwks(jwks);
      expect(kidsOf(published)).toEqual(kidsOf(jwks).slice(1));
      expect(hasPrivateMember(published)).toBe(false);
    },
  );

  test('an empty JWKS publishes nothing', () => {
    expect(toPublicJwks({ keys: [] })).toEqual({ keys: [] });
  });
});

describe('parseJwks', () => {
  test('accepts what the rotating constructs write, for every use and key type', async () => {
    for (const options of [
      SIG,
      ENC,
      { algorithm: 'RS256' },
      { algorithm: 'PS384' },
      { algorithm: 'RSA-OAEP-256' },
      { algorithm: 'ES512' },
      { algorithm: 'ECDH-ES', curve: 'P-521' },
    ] as const) {
      for (const rotations of [1, 2]) {
        const jwks = await jwksAfter(options, rotations);
        expect(parseJwks(JSON.stringify(jwks))).toEqual(jwks);
      }
    }
  });

  test('accepts the empty JWKS written before the first rotation', () => {
    expect(parseJwks('{"keys":[]}')).toEqual({ keys: [] });
  });

  test.each([
    ['not JSON', 'nope', /not valid JSON/],
    ['an array', '[]', /must be an object/],
    ['no keys member', '{}', /must have a keys array/],
    ['one key', '{"keys":[{}]}', /0 or 2 to 3 keys/],
  ])('rejects %s', (_name, value, message) => {
    expect(() => parseJwks(value)).toThrow(message);
  });

  test('rejects a key whose kid is not its thumbprint', async () => {
    const jwks = await jwksAfter(SIG, 1);
    const tampered = { keys: [{ ...jwks.keys[0], kid: 'x' }, jwks.keys[1]] };
    expect(() => parseJwks(JSON.stringify(tampered))).toThrow(/kid does not match/);
  });

  test('rejects a public-only key that still carries a private member', async () => {
    const jwks = await jwksAfter(SIG, 2);
    const { d: _d, ...withoutD } = jwks.keys[0] as unknown as Record<string, unknown>;
    const tampered = { keys: [{ ...withoutD, p: 'leak' }, jwks.keys[1], jwks.keys[2]] };
    expect(() => parseJwks(JSON.stringify(tampered))).toThrow(/must not have private members/);
  });

  test('rejects mixed uses and duplicate kids', async () => {
    const sig = await jwksAfter(SIG, 1);
    const enc = await jwksAfter(ENC, 1);
    expect(() => parseJwks(JSON.stringify({ keys: [sig.keys[0], enc.keys[0]] }))).toThrow(/same use/);
    expect(() => parseJwks(JSON.stringify({ keys: [sig.keys[0], sig.keys[0]] }))).toThrow(/unique/);
  });

  test('rejects 3 sig keys whose oldest still has its private part', async () => {
    const first = await jwksAfter(SIG, 1);
    const second = await jwksAfter(SIG, 1);
    const allPrivate = { keys: [first.keys[0], first.keys[1], second.keys[0]] };
    expect(() => parseJwks(JSON.stringify(allPrivate))).toThrow(/keys\[0\]: expected a public-only key/);
  });

  test.each([
    ['an unsupported algorithm', { alg: 'HS256' }, /unsupported alg/],
    ['a use that does not match the algorithm', { use: 'enc' }, /does not match alg/],
    ['a key type that does not match the algorithm', { kty: 'RSA' }, /kty "RSA" does not match/],
    ['an unsupported use', { use: 'other' }, /use must be/],
  ])('rejects %s', async (_name, change, message) => {
    const jwks = await jwksAfter(SIG, 1);
    expect(() => parseJwks(JSON.stringify({ keys: [{ ...jwks.keys[0], ...change }, jwks.keys[1]] }))).toThrow(
      message,
    );
  });
});
