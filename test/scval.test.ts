import * as assert from 'assert';
import { scValToNative } from '@stellar/stellar-sdk';
import { encodeArg, encodeArgs, ScValEncodeError } from '../src/soroban/scval';

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
  });

  it('rejects invalid hex bytes', () => {
    assert.throws(() => encodeArg({ value: 'xyz', type: 'bytes' }), ScValEncodeError);
  });
});
