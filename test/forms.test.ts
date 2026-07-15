import * as assert from 'assert';
import { Cursor, DwarfParseError } from '../src/dwarf/cursor';
import { skipByForm } from '../src/dwarf/info';
import { AbbrevAttr } from '../src/dwarf/abbrev';
import { readForm, AttrValue, FormContext } from '../src/dwarf/forms';
import * as C from '../src/dwarf/constants';

// A nonzero CU header start so ref-* (CU-relative) and ref_addr (section-absolute)
// resolution rules are distinguishable.
const CU_START = 0x1000;

/** Default context: 4-byte addresses, no string sections. */
const baseCtx: FormContext = { addressSize: 4, cuHeaderStart: CU_START };

function attr(form: number, implicitConst?: number): AbbrevAttr {
  return implicitConst === undefined ? { at: 0, form } : { at: 0, form, implicitConst };
}

/** Asserts the value's discriminant and returns it narrowed to that variant. */
function expect<K extends AttrValue['kind']>(v: AttrValue, kind: K): Extract<AttrValue, { kind: K }> {
  assert.strictEqual(v.kind, kind, `expected kind '${kind}', got '${v.kind}'`);
  return v as Extract<AttrValue, { kind: K }>;
}

/** Runs readForm over a fresh cursor built from `bytes`. */
function read(bytes: number[], form: number, ctx: FormContext = baseCtx, implicitConst?: number): { value: AttrValue; pos: number } {
  const cursor = new Cursor(Uint8Array.from(bytes));
  const value = readForm(cursor, attr(form, implicitConst), ctx);
  return { value, pos: cursor.pos };
}

describe('dwarf/forms', () => {
  describe('byte-advancement parity with skipByForm', () => {
    // Each case: the exact bytes of one attribute value, its form, and the number
    // of bytes both readForm and skipByForm must consume. addressSize is 4.
    const cases: Array<{ name: string; form: number; bytes: number[]; expected: number; implicitConst?: number }> = [
      // addr: addressSize (4) bytes, little-endian.
      { name: 'addr', form: C.DW_FORM_addr, bytes: [0x78, 0x56, 0x34, 0x12], expected: 4 },
      // data1: one byte.
      { name: 'data1', form: C.DW_FORM_data1, bytes: [0x2a], expected: 1 },
      // data2: two bytes.
      { name: 'data2', form: C.DW_FORM_data2, bytes: [0x34, 0x12], expected: 2 },
      // data4: four bytes.
      { name: 'data4', form: C.DW_FORM_data4, bytes: [0x78, 0x56, 0x34, 0x12], expected: 4 },
      // data8: eight bytes (low u32 = 2, high u32 = 1).
      { name: 'data8', form: C.DW_FORM_data8, bytes: [0x02, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00], expected: 8 },
      // data16: sixteen bytes.
      { name: 'data16', form: C.DW_FORM_data16, bytes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], expected: 16 },
      // sdata: SLEB128 of -624485 -> three bytes.
      { name: 'sdata', form: C.DW_FORM_sdata, bytes: [0x9b, 0xf1, 0x59], expected: 3 },
      // udata: ULEB128 of 624485 -> three bytes.
      { name: 'udata', form: C.DW_FORM_udata, bytes: [0xe5, 0x8e, 0x26], expected: 3 },
      // string: "hi" + NUL -> three bytes.
      { name: 'string', form: C.DW_FORM_string, bytes: [0x68, 0x69, 0x00], expected: 3 },
      // strp: 4-byte offset into .debug_str.
      { name: 'strp', form: C.DW_FORM_strp, bytes: [0x06, 0x00, 0x00, 0x00], expected: 4 },
      // line_strp: 4-byte offset into .debug_line_str.
      { name: 'line_strp', form: C.DW_FORM_line_strp, bytes: [0x00, 0x00, 0x00, 0x00], expected: 4 },
      // ref1: one byte.
      { name: 'ref1', form: C.DW_FORM_ref1, bytes: [0x08], expected: 1 },
      // ref2: two bytes.
      { name: 'ref2', form: C.DW_FORM_ref2, bytes: [0x34, 0x12], expected: 2 },
      // ref4: four bytes.
      { name: 'ref4', form: C.DW_FORM_ref4, bytes: [0x00, 0x10, 0x00, 0x00], expected: 4 },
      // ref8: eight bytes.
      { name: 'ref8', form: C.DW_FORM_ref8, bytes: [0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], expected: 8 },
      // ref_udata: ULEB128 of 128 -> two bytes.
      { name: 'ref_udata', form: C.DW_FORM_ref_udata, bytes: [0x80, 0x01], expected: 2 },
      // ref_addr: four bytes (32-bit DWARF).
      { name: 'ref_addr', form: C.DW_FORM_ref_addr, bytes: [0x00, 0x10, 0x00, 0x00], expected: 4 },
      // sec_offset: four bytes.
      { name: 'sec_offset', form: C.DW_FORM_sec_offset, bytes: [0x78, 0x56, 0x34, 0x12], expected: 4 },
      // exprloc: ULEB len (3) + 3 bytes.
      { name: 'exprloc', form: C.DW_FORM_exprloc, bytes: [0x03, 0xaa, 0xbb, 0xcc], expected: 4 },
      // block: ULEB len (2) + 2 bytes.
      { name: 'block', form: C.DW_FORM_block, bytes: [0x02, 0xde, 0xad], expected: 3 },
      // block1: u8 len (2) + 2 bytes.
      { name: 'block1', form: C.DW_FORM_block1, bytes: [0x02, 0xde, 0xad], expected: 3 },
      // block2: u16 len (2) + 2 bytes.
      { name: 'block2', form: C.DW_FORM_block2, bytes: [0x02, 0x00, 0xde, 0xad], expected: 4 },
      // block4: u32 len (3) + 3 bytes.
      { name: 'block4', form: C.DW_FORM_block4, bytes: [0x03, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03], expected: 7 },
      // flag: one byte.
      { name: 'flag', form: C.DW_FORM_flag, bytes: [0x01], expected: 1 },
      // flag_present: zero bytes.
      { name: 'flag_present', form: C.DW_FORM_flag_present, bytes: [], expected: 0 },
      // implicit_const: zero bytes (value lives in the abbrev).
      { name: 'implicit_const', form: C.DW_FORM_implicit_const, bytes: [], expected: 0, implicitConst: 42 },
      // indirect: ULEB form (data2 = 0x05) + that form's 2 bytes.
      { name: 'indirect', form: C.DW_FORM_indirect, bytes: [0x05, 0x34, 0x12], expected: 3 },
      // Unavailable, fixed-width: strx1..4 (1..4 bytes).
      { name: 'strx1', form: C.DW_FORM_strx1, bytes: [0xaa], expected: 1 },
      { name: 'strx2', form: C.DW_FORM_strx2, bytes: [0xaa, 0xbb], expected: 2 },
      { name: 'strx3', form: C.DW_FORM_strx3, bytes: [0xaa, 0xbb, 0xcc], expected: 3 },
      { name: 'strx4', form: C.DW_FORM_strx4, bytes: [0xaa, 0xbb, 0xcc, 0xdd], expected: 4 },
      // Unavailable, ULEB: loclistx (ULEB of 128 -> 2 bytes).
      { name: 'loclistx', form: C.DW_FORM_loclistx, bytes: [0x80, 0x01], expected: 2 },
      // Unavailable, fixed-width: ref_sig8 (8 bytes).
      { name: 'ref_sig8', form: C.DW_FORM_ref_sig8, bytes: [0, 0, 0, 0, 0, 0, 0, 0], expected: 8 },
    ];

    it('advances each form by exactly the skipByForm byte count', () => {
      for (const c of cases) {
        const rf = new Cursor(Uint8Array.from(c.bytes));
        readForm(rf, attr(c.form, c.implicitConst), baseCtx);
        assert.strictEqual(rf.pos, c.expected, `${c.name}: readForm advanced ${rf.pos}, expected ${c.expected}`);

        const sk = new Cursor(Uint8Array.from(c.bytes));
        skipByForm(sk, c.form, baseCtx.addressSize);
        assert.strictEqual(sk.pos, rf.pos, `${c.name}: skipByForm advanced ${sk.pos}, readForm advanced ${rf.pos}`);
      }
    });
  });

  describe('value correctness', () => {
    it('reads data1/2/4 as uint', () => {
      assert.strictEqual(expect(read([0x2a], C.DW_FORM_data1).value, 'uint').value, 0x2a);
      assert.strictEqual(expect(read([0x34, 0x12], C.DW_FORM_data2).value, 'uint').value, 0x1234);
      assert.strictEqual(expect(read([0x78, 0x56, 0x34, 0x12], C.DW_FORM_data4).value, 'uint').value, 0x12345678);
    });

    it('reads addr (addressSize bytes) as uint', () => {
      assert.strictEqual(expect(read([0x78, 0x56, 0x34, 0x12], C.DW_FORM_addr).value, 'uint').value, 0x12345678);
    });

    it('reads data8 as uint via low + high * 2^32', () => {
      // low u32 = 2, high u32 = 1 -> 2 + 1 * 2^32 = 4294967298.
      const v = expect(read([0x02, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00], C.DW_FORM_data8).value, 'uint');
      assert.strictEqual(v.value, 4294967298);
    });

    it('reads sec_offset as uint', () => {
      assert.strictEqual(expect(read([0x00, 0x10, 0x00, 0x00], C.DW_FORM_sec_offset).value, 'uint').value, 0x1000);
    });

    it('reads a negative sdata as int', () => {
      // SLEB128 0x7e -> -2.
      assert.strictEqual(expect(read([0x7e], C.DW_FORM_sdata).value, 'int').value, -2);
      // SLEB128 of -624485 (three bytes).
      assert.strictEqual(expect(read([0x9b, 0xf1, 0x59], C.DW_FORM_sdata).value, 'int').value, -624485);
    });

    it('reads a multi-byte udata as uint', () => {
      assert.strictEqual(expect(read([0xe5, 0x8e, 0x26], C.DW_FORM_udata).value, 'uint').value, 624485);
    });

    it('reads an inline string', () => {
      // "hi" + NUL.
      assert.strictEqual(expect(read([0x68, 0x69, 0x00], C.DW_FORM_string).value, 'str').value, 'hi');
    });

    it('reads strp against .debug_str', () => {
      // Section: "hello\0world\0". Offset 6 -> "world".
      const str = Uint8Array.from(Buffer.from('hello\0world\0', 'utf8'));
      const ctx: FormContext = { ...baseCtx, str };
      const v = expect(read([0x06, 0x00, 0x00, 0x00], C.DW_FORM_strp, ctx).value, 'str');
      assert.strictEqual(v.value, 'world');
    });

    it('reads line_strp against .debug_line_str', () => {
      // Section: "/home/user\0". Offset 0 -> "/home/user".
      const lineStr = Uint8Array.from(Buffer.from('/home/user\0', 'utf8'));
      const ctx: FormContext = { ...baseCtx, lineStr };
      const v = expect(read([0x00, 0x00, 0x00, 0x00], C.DW_FORM_line_strp, ctx).value, 'str');
      assert.strictEqual(v.value, '/home/user');
    });

    it('reports strp/line_strp as unavailable when the section is missing, still consuming 4 bytes', () => {
      const strp = read([0x06, 0x00, 0x00, 0x00], C.DW_FORM_strp); // no ctx.str
      expect(strp.value, 'unavailable');
      assert.strictEqual(strp.pos, 4);
      const lineStrp = read([0x06, 0x00, 0x00, 0x00], C.DW_FORM_line_strp); // no ctx.lineStr
      expect(lineStrp.value, 'unavailable');
      assert.strictEqual(lineStrp.pos, 4);
    });

    it('reads flag 0 as false and nonzero as true', () => {
      assert.strictEqual(expect(read([0x00], C.DW_FORM_flag).value, 'flag').value, false);
      assert.strictEqual(expect(read([0x01], C.DW_FORM_flag).value, 'flag').value, true);
      assert.strictEqual(expect(read([0xff], C.DW_FORM_flag).value, 'flag').value, true);
    });

    it('reads flag_present as true consuming 0 bytes', () => {
      const r = read([], C.DW_FORM_flag_present);
      assert.strictEqual(expect(r.value, 'flag').value, true);
      assert.strictEqual(r.pos, 0);
    });

    it('reads implicit_const as its abbrev value consuming 0 bytes', () => {
      const r = read([], C.DW_FORM_implicit_const, baseCtx, -5);
      assert.strictEqual(expect(r.value, 'int').value, -5);
      assert.strictEqual(r.pos, 0);
    });

    it('reads exprloc bytes exactly (ULEB len + bytes)', () => {
      // len 3, then 0x91 0x08 0x00.
      const v = expect(read([0x03, 0x91, 0x08, 0x00], C.DW_FORM_exprloc).value, 'block');
      assert.deepStrictEqual(v.value, Uint8Array.from([0x91, 0x08, 0x00]));
    });

    it('reads block/block1/block2/block4 bytes exactly', () => {
      // block: ULEB len 2.
      assert.deepStrictEqual(expect(read([0x02, 0xde, 0xad], C.DW_FORM_block).value, 'block').value, Uint8Array.from([0xde, 0xad]));
      // block1: u8 len 2.
      assert.deepStrictEqual(expect(read([0x02, 0xde, 0xad], C.DW_FORM_block1).value, 'block').value, Uint8Array.from([0xde, 0xad]));
      // block2: u16 len 2.
      assert.deepStrictEqual(expect(read([0x02, 0x00, 0xde, 0xad], C.DW_FORM_block2).value, 'block').value, Uint8Array.from([0xde, 0xad]));
      // block4: u32 len 3.
      assert.deepStrictEqual(
        expect(read([0x03, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03], C.DW_FORM_block4).value, 'block').value,
        Uint8Array.from([0x01, 0x02, 0x03]),
      );
    });

    it('reads data16 as a 16-byte block', () => {
      const bytes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
      const v = expect(read(bytes, C.DW_FORM_data16).value, 'block');
      assert.deepStrictEqual(v.value, Uint8Array.from(bytes));
    });
  });

  describe('reference resolution', () => {
    it('resolves ref1/ref2/ref4/ref8/ref_udata as cuHeaderStart + raw', () => {
      // ref1: 0x1000 + 8.
      assert.strictEqual(expect(read([0x08], C.DW_FORM_ref1).value, 'ref').value, CU_START + 0x08);
      // ref2: 0x1000 + 0x1234.
      assert.strictEqual(expect(read([0x34, 0x12], C.DW_FORM_ref2).value, 'ref').value, CU_START + 0x1234);
      // ref4: 0x1000 + 0x1000.
      assert.strictEqual(expect(read([0x00, 0x10, 0x00, 0x00], C.DW_FORM_ref4).value, 'ref').value, CU_START + 0x1000);
      // ref8: 0x1000 + 8.
      assert.strictEqual(
        expect(read([0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], C.DW_FORM_ref8).value, 'ref').value,
        CU_START + 0x08,
      );
      // ref_udata: ULEB 128 -> 0x1000 + 128.
      assert.strictEqual(expect(read([0x80, 0x01], C.DW_FORM_ref_udata).value, 'ref').value, CU_START + 128);
    });

    it('resolves ref_addr as the raw offset with NO cuHeaderStart', () => {
      // Same raw bytes (0x1000) as the ref4 case, but ref_addr is section-absolute.
      const v = expect(read([0x00, 0x10, 0x00, 0x00], C.DW_FORM_ref_addr).value, 'ref');
      assert.strictEqual(v.value, 0x1000);
      assert.notStrictEqual(v.value, CU_START + 0x1000);
    });
  });

  describe('unavailable forms', () => {
    // Each case: form, its bytes, and the byte count that must still be consumed.
    const cases: Array<{ name: string; form: number; bytes: number[]; expected: number }> = [
      { name: 'strx1', form: C.DW_FORM_strx1, bytes: [0xaa], expected: 1 },
      { name: 'addrx1', form: C.DW_FORM_addrx1, bytes: [0xaa], expected: 1 },
      { name: 'strx2', form: C.DW_FORM_strx2, bytes: [0xaa, 0xbb], expected: 2 },
      { name: 'addrx2', form: C.DW_FORM_addrx2, bytes: [0xaa, 0xbb], expected: 2 },
      { name: 'strx3', form: C.DW_FORM_strx3, bytes: [0xaa, 0xbb, 0xcc], expected: 3 },
      { name: 'addrx3', form: C.DW_FORM_addrx3, bytes: [0xaa, 0xbb, 0xcc], expected: 3 },
      { name: 'strx4', form: C.DW_FORM_strx4, bytes: [0xaa, 0xbb, 0xcc, 0xdd], expected: 4 },
      { name: 'addrx4', form: C.DW_FORM_addrx4, bytes: [0xaa, 0xbb, 0xcc, 0xdd], expected: 4 },
      { name: 'strp_sup', form: C.DW_FORM_strp_sup, bytes: [0x01, 0x02, 0x03, 0x04], expected: 4 },
      { name: 'ref_sup4', form: C.DW_FORM_ref_sup4, bytes: [0x01, 0x02, 0x03, 0x04], expected: 4 },
      { name: 'ref_sup8', form: C.DW_FORM_ref_sup8, bytes: [1, 2, 3, 4, 5, 6, 7, 8], expected: 8 },
      { name: 'ref_sig8', form: C.DW_FORM_ref_sig8, bytes: [1, 2, 3, 4, 5, 6, 7, 8], expected: 8 },
      // ULEB-length forms: ULEB of 128 -> two bytes.
      { name: 'strx', form: C.DW_FORM_strx, bytes: [0x80, 0x01], expected: 2 },
      { name: 'addrx', form: C.DW_FORM_addrx, bytes: [0x80, 0x01], expected: 2 },
      { name: 'loclistx', form: C.DW_FORM_loclistx, bytes: [0x80, 0x01], expected: 2 },
      { name: 'rnglistx', form: C.DW_FORM_rnglistx, bytes: [0x80, 0x01], expected: 2 },
    ];

    it('returns {kind:"unavailable"} and consumes the correct byte count', () => {
      for (const c of cases) {
        const r = read(c.bytes, c.form);
        expect(r.value, 'unavailable');
        assert.strictEqual(r.pos, c.expected, `${c.name}: consumed ${r.pos}, expected ${c.expected}`);
      }
    });
  });

  describe('indirect', () => {
    it('wraps data4 and returns its value with total advancement', () => {
      // ULEB form data4 (0x06), then the 4-byte value.
      const r = read([0x06, 0x78, 0x56, 0x34, 0x12], C.DW_FORM_indirect);
      assert.strictEqual(expect(r.value, 'uint').value, 0x12345678);
      assert.strictEqual(r.pos, 5);
    });

    it('wraps ref4 and applies CU-relative resolution', () => {
      // ULEB form ref4 (0x13), then a 4-byte offset 0x1000.
      const r = read([0x13, 0x00, 0x10, 0x00, 0x00], C.DW_FORM_indirect);
      assert.strictEqual(expect(r.value, 'ref').value, CU_START + 0x1000);
      assert.strictEqual(r.pos, 5);
    });

    it('wraps flag_present (zero payload), consuming only the form ULEB', () => {
      // ULEB form flag_present (0x19), then no bytes.
      const r = read([0x19], C.DW_FORM_indirect);
      assert.strictEqual(expect(r.value, 'flag').value, true);
      assert.strictEqual(r.pos, 1);
    });
  });

  describe('unknown form', () => {
    it('throws DwarfParseError, matching skipByForm', () => {
      // 0x7f is not a defined DWARF form.
      assert.throws(() => read([0x00, 0x01], 0x7f), DwarfParseError);
    });
  });
});
