import * as assert from 'assert';
import * as fc from 'fast-check';
import { Cursor } from '../../src/dwarf/cursor';
import { readUleb as wasmReadUleb } from '../../src/wasm/sections';

// The project historically carried three separate ULEB128 decoders (DWARF
// Cursor, wasm sections, TypeRegistry). TypeRegistry now reuses Cursor, leaving
// two: the DWARF Cursor and the wasm reader. This property pins that the two
// surviving decoders agree, so they cannot silently drift apart.

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

describe('property: LEB128 decoders agree', () => {
  it('Cursor.uleb and wasm readUleb decode identical values and consumed lengths', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (n) => {
        const bytes = Uint8Array.from(encodeUleb(n));
        const cursor = new Cursor(bytes);
        const cursorValue = cursor.uleb();
        const [wasmValue, wasmNext] = wasmReadUleb(bytes, 0);

        assert.strictEqual(cursorValue, n, 'Cursor.uleb value');
        assert.strictEqual(wasmValue, n, 'wasm readUleb value');
        assert.strictEqual(cursor.pos, bytes.length, 'Cursor consumed length');
        assert.strictEqual(wasmNext, bytes.length, 'wasm consumed length');
      }),
    );
  });

  it('both agree on the canonical multi-byte example (624485)', () => {
    const bytes = Uint8Array.from([0xe5, 0x8e, 0x26]);
    assert.strictEqual(new Cursor(bytes).uleb(), 624485);
    assert.strictEqual(wasmReadUleb(bytes, 0)[0], 624485);
  });
});
