import * as assert from 'assert';
import { selectLocation } from '../src/dwarf/debugLoc';

// DWARF v4 `.debug_loc` location lists. Each list is a sequence of entries; every
// entry begins with two addressSize-wide values (begin, end):
//   (0, 0)                 -> end-of-list terminator
//   (0xffffffff, newBase)  -> base-selection entry: base := newBase (no expr)
//   otherwise              -> location entry: u16 len, then `len` expr bytes,
//                             covering [base+begin, base+end)
// The base address starts at the CU's DW_AT_low_pc (cuLowPc). addressSize is 4.
//
// Every list below is hand-built with byte comments. Helpers emit little-endian
// fixed-width fields so the intent stays readable.

/** Little-endian u32 as a 4-byte array. */
function u32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

/** Little-endian u16 as a 2-byte array. */
function u16(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff];
}

/** A location entry: begin, end (relative to the current base), and expr bytes. */
function locEntry(begin: number, end: number, exprBytes: number[]): number[] {
  return [...u32(begin), ...u32(end), ...u16(exprBytes.length), ...exprBytes];
}

/** A base-selection entry: begin = 0xffffffff, end = the new base address. */
function baseSelect(newBase: number): number[] {
  return [...u32(0xffffffff), ...u32(newBase)];
}

/** The (0, 0) end-of-list terminator. */
const TERMINATOR = [...u32(0), ...u32(0)];

function buf(...groups: number[][]): Uint8Array {
  return Uint8Array.from(groups.flat());
}

/** null | array-of-bytes, so deepStrictEqual works on the returned subarray view. */
function selected(...args: Parameters<typeof selectLocation>): number[] | null {
  const r = selectLocation(...args);
  return r === null ? null : Array.from(r);
}

const CU_LOW_PC = 0x100; // 256 — nonzero, so relative begin/end are observable.

describe('dwarf/debugLoc — selectLocation', () => {
  describe('two location entries, base defaults to cuLowPc', () => {
    // Entry A covers [256+0, 256+16) = [256, 272) -> expr [0xaa, 0xbb]
    // Entry B covers [256+16, 256+32) = [272, 288) -> expr [0x11, 0x22, 0x33]
    // Two leading junk bytes precede the list; the list starts at offset 2.
    const data = buf(
      [0xde, 0xad], // junk before the list
      locEntry(0x00, 0x10, [0xaa, 0xbb]),
      locEntry(0x10, 0x20, [0x11, 0x22, 0x33]),
      TERMINATOR,
    );

    it('returns the FIRST entry expr for a pc inside its range', () => {
      // pc = 260 is in [256, 272) -> entry A
      assert.deepStrictEqual(selected(data, 2, 260, CU_LOW_PC), [0xaa, 0xbb]);
    });

    it('returns the SECOND entry expr for a pc inside its range', () => {
      // pc = 277 is in [272, 288) -> entry B; proves ranges are relative to cuLowPc
      assert.deepStrictEqual(selected(data, 2, 277, CU_LOW_PC), [0x11, 0x22, 0x33]);
    });

    it('a pc at the exclusive end of entry A falls into entry B', () => {
      // pc = 272 = 256+16 is the end of A and the start of B -> entry B
      assert.deepStrictEqual(selected(data, 2, 272, CU_LOW_PC), [0x11, 0x22, 0x33]);
    });
  });

  describe('base-selection entry changes the base for subsequent entries', () => {
    // Entry A covers [256+0, 256+16) = [256, 272)          -> expr [0xaa]
    // Base-select sets base := 0x2000 (8192)
    // Entry B covers [8192+0, 8192+16) = [8192, 8208)       -> expr [0xcc]
    const data = buf(
      locEntry(0x00, 0x10, [0xaa]),
      baseSelect(0x2000),
      locEntry(0x00, 0x10, [0xcc]),
      TERMINATOR,
    );

    it('resolves a pc against the pre-select base (cuLowPc)', () => {
      // pc = 260 in [256, 272) -> entry A
      assert.deepStrictEqual(selected(data, 0, 260, CU_LOW_PC), [0xaa]);
    });

    it('resolves a pc against the NEW base after the base-selection entry', () => {
      // pc = 8200 in [8192, 8208) -> entry B (only reachable via the new base)
      assert.deepStrictEqual(selected(data, 0, 8200, CU_LOW_PC), [0xcc]);
    });

    it('a pc that would only match entry B under the OLD base is not selected', () => {
      // 0x2000+8 under the old base would be 256+? ; pc = 264 must still be entry A
      assert.deepStrictEqual(selected(data, 0, 264, CU_LOW_PC), [0xaa]);
    });
  });

  describe('no covering entry -> null', () => {
    const data = buf(
      locEntry(0x00, 0x10, [0xaa, 0xbb]),
      locEntry(0x10, 0x20, [0x11, 0x22, 0x33]),
      TERMINATOR,
    );

    it('pc below all ranges -> null', () => {
      // pc = 100 < 256 (cuLowPc) -> below entry A
      assert.strictEqual(selected(data, 0, 100, CU_LOW_PC), null);
    });

    it('pc above all ranges -> null (terminator reached)', () => {
      // pc = 1000 > 288 -> above entry B; the (0,0) terminator ends the search
      assert.strictEqual(selected(data, 0, 1000, CU_LOW_PC), null);
    });

    it('an immediate (0,0) terminator -> null', () => {
      assert.strictEqual(selected(buf(TERMINATOR), 0, 260, CU_LOW_PC), null);
    });
  });
});
