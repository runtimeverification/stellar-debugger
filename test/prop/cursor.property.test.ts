import * as assert from 'assert';
import * as fc from 'fast-check';
import { Cursor, DwarfParseError } from '../../src/dwarf/cursor';

// Reference LEB128 encoders (independent of the production decoders) used to
// generate round-trip inputs.
function encodeUleb(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return out;
}

function encodeSleb(n: number): number[] {
  const out: number[] = [];
  let value = n;
  let more = true;
  while (more) {
    let byte = ((value % 128) + 128) % 128; // low 7 bits, always non-negative
    value = Math.floor(value / 128);
    if ((value === 0 && (byte & 0x40) === 0) || (value === -1 && (byte & 0x40) !== 0)) {
      more = false;
    } else {
      byte |= 0x80;
    }
    out.push(byte);
  }
  return out;
}

describe('property: Cursor LEB128 round-trips', () => {
  it('uleb decodes exactly what a reference encoder produced', () => {
    fc.assert(
      fc.property(fc.nat(), (n) => {
        const bytes = Uint8Array.from(encodeUleb(n));
        const c = new Cursor(bytes);
        assert.strictEqual(c.uleb(), n);
        // Consumed length matches the encoding exactly.
        assert.strictEqual(c.pos, bytes.length);
      }),
    );
  });

  it('uleb round-trips large safe integers (boundaries around 2^7 multiples)', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: 0, max: 0x7fffffff }),
          fc.constantFrom(0, 127, 128, 16383, 16384, 2 ** 31, 2 ** 32 - 1, Number.MAX_SAFE_INTEGER),
        ),
        (n) => {
          const c = new Cursor(Uint8Array.from(encodeUleb(n)));
          assert.strictEqual(c.uleb(), n);
        },
      ),
    );
  });

  it('sleb round-trips signed integers including negatives', () => {
    fc.assert(
      fc.property(fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 }), (n) => {
        const c = new Cursor(Uint8Array.from(encodeSleb(n)));
        assert.strictEqual(c.sleb(), n);
      }),
    );
  });
});

describe('property: Cursor fixed-width round-trips', () => {
  it('u16 round-trips little-endian', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffff }), (n) => {
        const c = new Cursor(Uint8Array.from([n & 0xff, (n >> 8) & 0xff]));
        assert.strictEqual(c.u16(), n);
      }),
    );
  });

  it('u32 round-trips little-endian', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (n) => {
        const c = new Cursor(Uint8Array.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]));
        assert.strictEqual(c.u32(), n);
      }),
    );
  });

  it('cstring round-trips any UTF-8 string without an embedded NUL', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 50 }).filter((s) => !s.includes(String.fromCharCode(0))),
        (s) => {
          const payload = Buffer.from(s, 'utf8');
          const c = new Cursor(Uint8Array.from([...payload, 0]));
          assert.strictEqual(c.cstring(), s);
          assert.strictEqual(c.pos, payload.length + 1);
        },
      ),
    );
  });
});

describe('property: Cursor never corrupts on arbitrary bytes', () => {
  type Op = 'u8' | 'u16' | 'u32' | 'uleb' | 'sleb' | 'cstring' | 'initialLength' | 'bytes3' | 'skip2';

  it('any op sequence over arbitrary bytes only ever throws DwarfParseError and never advances past the end', () => {
    const op = fc.constantFrom<Op>('u8', 'u16', 'u32', 'uleb', 'sleb', 'cstring', 'initialLength', 'bytes3', 'skip2');
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), fc.array(op, { maxLength: 30 }), (data, ops) => {
        const c = new Cursor(data);
        for (const o of ops) {
          try {
            switch (o) {
              case 'u8': c.u8(); break;
              case 'u16': c.u16(); break;
              case 'u32': c.u32(); break;
              case 'uleb': c.uleb(); break;
              case 'sleb': c.sleb(); break;
              case 'cstring': c.cstring(); break;
              case 'initialLength': c.initialLength(); break;
              case 'bytes3': c.bytes(3); break;
              case 'skip2': c.skip(2); break;
            }
          } catch (e) {
            // The single documented failure mode.
            assert.ok(
              e instanceof DwarfParseError,
              `unexpected error type: ${(e as Error).constructor.name}: ${(e as Error).message}`,
            );
          }
          // Invariant: the cursor never reports a position past the buffer.
          assert.ok(c.pos >= 0 && c.pos <= data.length, `pos ${c.pos} out of range for length ${data.length}`);
          assert.strictEqual(c.remaining, data.length - c.pos);
        }
      }),
    );
  });

  it('initialLength throws for exactly the reserved 64-bit escape range', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (n) => {
        const bytes = Uint8Array.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
        const c = new Cursor(bytes);
        if (n >= 0xfffffff0) {
          assert.throws(() => c.initialLength(), DwarfParseError);
        } else {
          assert.strictEqual(c.initialLength(), n);
        }
      }),
    );
  });
});
