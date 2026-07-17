import * as assert from 'assert';
import * as fc from 'fast-check';
import { scValToNative } from '@stellar/stellar-sdk';
import { encodeArg, ScValType, ScValEncodeError } from '../../src/soroban/scval';

/** Round-trip a declarative arg through encode -> native decode. */
function roundTrip(value: unknown, type: ScValType): unknown {
  return scValToNative(encodeArg({ value, type }));
}

describe('property: ScVal integer round-trips (full width, exact)', () => {
  const bigWidths: Array<{ type: ScValType; min: bigint; max: bigint }> = [
    { type: 'u64', min: 0n, max: 2n ** 64n - 1n },
    { type: 'i64', min: -(2n ** 63n), max: 2n ** 63n - 1n },
    { type: 'u128', min: 0n, max: 2n ** 128n - 1n },
    { type: 'i128', min: -(2n ** 127n), max: 2n ** 127n - 1n },
    { type: 'u256', min: 0n, max: 2n ** 256n - 1n },
    { type: 'i256', min: -(2n ** 255n), max: 2n ** 255n - 1n },
  ];

  for (const { type, min, max } of bigWidths) {
    it(`${type} round-trips exactly across its full range (bigint)`, () => {
      fc.assert(
        fc.property(fc.bigInt({ min, max }), (n) => {
          assert.strictEqual(BigInt(roundTrip(n, type) as bigint | number), n);
        }),
      );
    });

    it(`${type} accepts the decimal string form and agrees with the numeric form`, () => {
      fc.assert(
        fc.property(fc.bigInt({ min, max }), (n) => {
          assert.strictEqual(String(roundTrip(n.toString(), type)), n.toString());
        }),
      );
    });
  }

  it('u32 round-trips across its full range', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (n) => {
        assert.strictEqual(Number(roundTrip(n, 'u32')), n);
      }),
    );
  });

  it('i32 round-trips across its full range', () => {
    fc.assert(
      fc.property(fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 }), (n) => {
        assert.strictEqual(Number(roundTrip(n, 'i32')), n);
      }),
    );
  });
});

describe('property: ScVal non-integer round-trips', () => {
  it('bool round-trips', () => {
    fc.assert(fc.property(fc.boolean(), (b) => assert.strictEqual(roundTrip(b, 'bool'), b)));
  });

  it('string round-trips arbitrary text', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        assert.strictEqual(String(roundTrip(s, 'string')), s);
      }),
    );
  });

  it('symbol round-trips valid symbol characters', () => {
    const symbolChar = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split(''));
    fc.assert(
      fc.property(fc.array(symbolChar, { maxLength: 32 }).map((cs) => cs.join('')), (s) => {
        assert.strictEqual(String(roundTrip(s, 'symbol')), s);
      }),
    );
  });

  it('bytes round-trips arbitrary byte buffers through hex', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        const hex = Buffer.from(bytes).toString('hex');
        const decoded = scValToNative(encodeArg({ value: hex, type: 'bytes' })) as Buffer;
        assert.deepStrictEqual(Buffer.from(decoded), Buffer.from(bytes));
      }),
    );
  });

  it('bytes round-trips arbitrary byte arrays', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 64 }), (arr) => {
        const decoded = scValToNative(encodeArg({ value: arr, type: 'bytes' })) as Buffer;
        assert.deepStrictEqual([...decoded], arr);
      }),
    );
  });
});

describe('property: ScVal rejections', () => {
  it('rejects non-integer numbers for every integer type', () => {
    const intType = fc.constantFrom<ScValType>('u32', 'i32', 'u64', 'i64', 'u128', 'i128', 'u256', 'i256');
    fc.assert(
      fc.property(
        intType,
        fc.double({ min: -1e6, max: 1e6, noInteger: true, noNaN: true }),
        (type, x) => {
          assert.throws(() => encodeArg({ value: x, type }), ScValEncodeError);
        },
      ),
    );
  });

  it('rejects odd-length or non-hex strings for bytes', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !/^([0-9a-fA-F]{2})*$/.test(s.startsWith('0x') ? s.slice(2) : s)),
        (s) => {
          assert.throws(() => encodeArg({ value: s, type: 'bytes' }), ScValEncodeError);
        },
      ),
    );
  });

  it('rejects out-of-range 32-bit integers (SDK would silently accept them)', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant<[ScValType, number]>(['u32', -1]),
          fc.constant<[ScValType, number]>(['u32', 2 ** 32]),
          fc.constant<[ScValType, number]>(['i32', 2 ** 31]),
          fc.constant<[ScValType, number]>(['i32', -(2 ** 31) - 1]),
        ),
        ([type, value]) => {
          assert.throws(() => encodeArg({ value, type }), ScValEncodeError);
        },
      ),
    );
  });

  it('rejects out-of-range wide integers (SDK would silently wrap them)', () => {
    const overflows: Array<[ScValType, bigint]> = [
      ['u64', 2n ** 64n],
      ['u64', -1n],
      ['i64', 2n ** 63n],
      ['u128', 2n ** 128n],
      ['i128', 2n ** 127n],
      ['u256', 2n ** 256n],
      ['i256', 2n ** 255n],
    ];
    for (const [type, value] of overflows) {
      assert.throws(() => encodeArg({ value, type }), ScValEncodeError, `${type} ${value} should be rejected`);
    }
  });
});
