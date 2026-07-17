import * as assert from 'assert';
import { Keypair, scValToNative } from '@stellar/stellar-sdk';
import { encodeArg, encodeArgs, decodeScVal, ScValEncodeError, ScValType } from '../src/soroban/scval';

describe('scval encoding', () => {
  it('round-trips small integers', () => {
    for (const type of ['u32', 'i32'] as const) {
      const scval = encodeArg({ value: 7, type });
      assert.strictEqual(Number(scValToNative(scval)), 7);
    }
  });

  it('round-trips large integers via string and number', () => {
    const fromStr = encodeArg({ value: '170141183460469231731687303715884105727', type: 'i128' });
    assert.strictEqual(scValToNative(fromStr).toString(), '170141183460469231731687303715884105727');
    const fromNum = encodeArg({ value: 42, type: 'u64' });
    assert.strictEqual(scValToNative(fromNum).toString(), '42');
  });

  it('round-trips bool, symbol and string', () => {
    assert.strictEqual(scValToNative(encodeArg({ value: true, type: 'bool' })), true);
    assert.strictEqual(scValToNative(encodeArg({ value: 'hello', type: 'symbol' })), 'hello');
    assert.strictEqual(scValToNative(encodeArg({ value: 'world', type: 'string' })), 'world');
  });

  it('encodes bytes from hex', () => {
    const scval = encodeArg({ value: '0xdeadbeef', type: 'bytes' });
    const native = scValToNative(scval) as Buffer;
    assert.strictEqual(Buffer.from(native).toString('hex'), 'deadbeef');
  });

  it('encodes a list of args in order', () => {
    const scvals = encodeArgs([
      { value: 1, type: 'u32' },
      { value: 2, type: 'u32' },
    ]);
    assert.strictEqual(scvals.length, 2);
    assert.strictEqual(Number(scValToNative(scvals[0])), 1);
    assert.strictEqual(Number(scValToNative(scvals[1])), 2);
  });

  it('rejects an unsupported type', () => {
    assert.throws(() => encodeArg({ value: 1, type: 'float' as any }), ScValEncodeError);
  });

  it('rejects non-integer values for integer types', () => {
    assert.throws(() => encodeArg({ value: 1.5, type: 'u64' }), ScValEncodeError);
    // Regression: the 32-bit types used to bypass validation entirely and let
    // the SDK encode a float verbatim.
    assert.throws(() => encodeArg({ value: 1.5, type: 'u32' }), ScValEncodeError);
    assert.throws(() => encodeArg({ value: 1.5, type: 'i32' }), ScValEncodeError);
  });

  it('rejects out-of-range integers instead of wrapping/accepting them', () => {
    // 32-bit: SDK would accept these as-is.
    assert.throws(() => encodeArg({ value: -1, type: 'u32' }), ScValEncodeError);
    assert.throws(() => encodeArg({ value: 2 ** 32, type: 'u32' }), ScValEncodeError);
    assert.throws(() => encodeArg({ value: 2 ** 31, type: 'i32' }), ScValEncodeError);
    // Wide: SDK would silently wrap 2^64 to 0.
    assert.throws(() => encodeArg({ value: 2n ** 64n, type: 'u64' }), ScValEncodeError);
    assert.throws(() => encodeArg({ value: -1n, type: 'u64' }), ScValEncodeError);
    assert.throws(() => encodeArg({ value: 2n ** 255n, type: 'i256' }), ScValEncodeError);
  });

  it('accepts the exact min/max boundary of each integer type', () => {
    // The boundary itself must be ACCEPTED (guards the < / > vs <= / >= edges).
    const cases: Array<[ScValType, bigint, bigint]> = [
      ['u32', 0n, 2n ** 32n - 1n],
      ['i32', -(2n ** 31n), 2n ** 31n - 1n],
      ['u64', 0n, 2n ** 64n - 1n],
      ['i64', -(2n ** 63n), 2n ** 63n - 1n],
      ['u128', 0n, 2n ** 128n - 1n],
      ['i128', -(2n ** 127n), 2n ** 127n - 1n],
      ['u256', 0n, 2n ** 256n - 1n],
      ['i256', -(2n ** 255n), 2n ** 255n - 1n],
    ];
    for (const [type, min, max] of cases) {
      for (const boundary of [min, max]) {
        const native = scValToNative(encodeArg({ value: boundary.toString(), type }));
        assert.strictEqual(BigInt(native as bigint | number), boundary, `${type} boundary ${boundary}`);
      }
    }
  });

  it('rejects a byte array containing a non-number element', () => {
    assert.throws(() => encodeArg({ value: [1, 'x', 2], type: 'bytes' }), ScValEncodeError);
    assert.throws(() => encodeArg({ value: [1, null, 2], type: 'bytes' }), ScValEncodeError);
  });

  it('rejects invalid hex bytes', () => {
    assert.throws(() => encodeArg({ value: 'xyz', type: 'bytes' }), ScValEncodeError);
  });

  it('encodes an address from a G-address string', () => {
    const g = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3)).publicKey();
    const scval = encodeArg({ value: g, type: 'address' });
    assert.strictEqual(scValToNative(scval), g);
  });

  it('accepts a bigint value for wide integer types', () => {
    const scval = encodeArg({ value: 2n ** 100n, type: 'u128' });
    assert.strictEqual(scValToNative(scval).toString(), (2n ** 100n).toString());
  });

  it('encodes bytes from an array of byte values', () => {
    const scval = encodeArg({ value: [0xde, 0xad, 0xbe, 0xef], type: 'bytes' });
    const native = scValToNative(scval) as Buffer;
    assert.strictEqual(Buffer.from(native).toString('hex'), 'deadbeef');
  });

  it('decodeScVal is the inverse of encodeArg', () => {
    assert.strictEqual(decodeScVal(encodeArg({ value: 123, type: 'u32' })), 123);
  });

  it('rejects a non-object argument', () => {
    assert.throws(() => encodeArg(null as any), ScValEncodeError);
    assert.throws(() => encodeArg('nope' as any), ScValEncodeError);
  });

  it('rejects a non-numeric-string integer value', () => {
    assert.throws(() => encodeArg({ value: 'not-a-number', type: 'i128' }), ScValEncodeError);
  });

  it('rejects a bytes value that is neither hex string nor byte array', () => {
    assert.throws(() => encodeArg({ value: { nope: true }, type: 'bytes' }), ScValEncodeError);
  });

  it('rejects a non-number/non-string integer value', () => {
    assert.throws(() => encodeArg({ value: { bad: 1 }, type: 'u64' }), ScValEncodeError);
  });

  it('wraps an SDK encoding failure as ScValEncodeError', () => {
    // A malformed address makes the SDK's Address constructor throw; encodeArg
    // must catch it and surface it as ScValEncodeError (the catch-all re-wrap).
    assert.throws(() => encodeArg({ value: 'not-an-address', type: 'address' }), ScValEncodeError);
  });
});
