import * as assert from 'assert';
import * as fc from 'fast-check';
import { Cursor, DwarfParseError } from '../../src/dwarf/cursor';
import { readForm } from '../../src/dwarf/forms';
import { skipByForm } from '../../src/dwarf/info';
import * as C from '../../src/dwarf/constants';

const ADDRESS_SIZE = 4;

function uleb(n: number): number[] {
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
function sleb(n: number): number[] {
  const out: number[] = [];
  let value = n;
  let more = true;
  while (more) {
    let byte = ((value % 128) + 128) % 128;
    value = Math.floor(value / 128);
    if ((value === 0 && (byte & 0x40) === 0) || (value === -1 && (byte & 0x40) !== 0)) more = false;
    else byte |= 0x80;
    out.push(byte);
  }
  return out;
}

const byte = fc.integer({ min: 0, max: 255 });
const bytesN = (n: number): fc.Arbitrary<number[]> => fc.array(byte, { minLength: n, maxLength: n });
const smallLen = fc.integer({ min: 0, max: 8 });

/** For each form, an arbitrary producing a valid on-the-wire payload for it. */
const FORM_CASES: Array<{ form: number; payload: fc.Arbitrary<number[]> }> = [
  { form: C.DW_FORM_addr, payload: bytesN(ADDRESS_SIZE) },
  { form: C.DW_FORM_data1, payload: bytesN(1) },
  { form: C.DW_FORM_data2, payload: bytesN(2) },
  { form: C.DW_FORM_data4, payload: bytesN(4) },
  { form: C.DW_FORM_data8, payload: bytesN(8) },
  { form: C.DW_FORM_data16, payload: bytesN(16) },
  { form: C.DW_FORM_sdata, payload: fc.integer({ min: -100000, max: 100000 }).map(sleb) },
  { form: C.DW_FORM_udata, payload: fc.nat().map(uleb) },
  { form: C.DW_FORM_string, payload: fc.array(fc.integer({ min: 1, max: 255 }), { maxLength: 10 }).map((b) => [...b, 0]) },
  { form: C.DW_FORM_strp, payload: bytesN(4) },
  { form: C.DW_FORM_line_strp, payload: bytesN(4) },
  { form: C.DW_FORM_ref1, payload: bytesN(1) },
  { form: C.DW_FORM_ref2, payload: bytesN(2) },
  { form: C.DW_FORM_ref4, payload: bytesN(4) },
  { form: C.DW_FORM_ref8, payload: bytesN(8) },
  { form: C.DW_FORM_ref_udata, payload: fc.nat().map(uleb) },
  { form: C.DW_FORM_ref_addr, payload: bytesN(4) },
  { form: C.DW_FORM_sec_offset, payload: bytesN(4) },
  { form: C.DW_FORM_exprloc, payload: smallLen.chain((n) => bytesN(n).map((b) => [...uleb(n), ...b])) },
  { form: C.DW_FORM_block, payload: smallLen.chain((n) => bytesN(n).map((b) => [...uleb(n), ...b])) },
  { form: C.DW_FORM_block1, payload: smallLen.chain((n) => bytesN(n).map((b) => [n, ...b])) },
  { form: C.DW_FORM_block2, payload: smallLen.chain((n) => bytesN(n).map((b) => [n, 0, ...b])) },
  { form: C.DW_FORM_block4, payload: smallLen.chain((n) => bytesN(n).map((b) => [n, 0, 0, 0, ...b])) },
  { form: C.DW_FORM_flag, payload: bytesN(1) },
  { form: C.DW_FORM_flag_present, payload: fc.constant<number[]>([]) },
  // Forms unresolvable offline: still consume bytes.
  { form: C.DW_FORM_strx1, payload: bytesN(1) },
  { form: C.DW_FORM_strx2, payload: bytesN(2) },
  { form: C.DW_FORM_strx3, payload: bytesN(3) },
  { form: C.DW_FORM_strx4, payload: bytesN(4) },
  { form: C.DW_FORM_strx, payload: fc.nat().map(uleb) },
  { form: C.DW_FORM_ref_sig8, payload: bytesN(8) },
  { form: C.DW_FORM_loclistx, payload: fc.nat().map(uleb) },
];

describe('property: readForm and skipByForm advance the cursor identically', () => {
  it('holds for every supported form over arbitrary payloads', () => {
    const oneCase = fc.oneof(...FORM_CASES.map((c) => c.payload.map((payload) => ({ form: c.form, payload }))));
    fc.assert(
      fc.property(oneCase, ({ form, payload }) => {
        const bytes = Uint8Array.from(payload);
        const ctx = { addressSize: ADDRESS_SIZE, cuHeaderStart: 0 };

        const readCursor = new Cursor(bytes);
        readForm(readCursor, { at: 0, form }, ctx);

        const skipCursor = new Cursor(bytes);
        skipByForm(skipCursor, form, ADDRESS_SIZE);

        assert.strictEqual(readCursor.pos, skipCursor.pos, `form 0x${form.toString(16)} advanced differently`);
        assert.strictEqual(readCursor.pos, bytes.length, `form 0x${form.toString(16)} did not consume its whole payload`);
      }),
    );
  });

  it('implicit_const consumes zero bytes in both', () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    const rc = new Cursor(bytes);
    readForm(rc, { at: 0, form: C.DW_FORM_implicit_const, implicitConst: -5 }, { addressSize: 4, cuHeaderStart: 0 });
    const sc = new Cursor(bytes);
    skipByForm(sc, C.DW_FORM_implicit_const, 4);
    assert.strictEqual(rc.pos, 0);
    assert.strictEqual(sc.pos, 0);
  });

  it('an unknown form makes both throw DwarfParseError', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0x40, max: 0xff }).filter((f) => !FORM_CASES.some((c) => c.form === f)),
        (form) => {
          const bytes = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0]);
          assert.throws(() => readForm(new Cursor(bytes), { at: 0, form }, { addressSize: 4, cuHeaderStart: 0 }), DwarfParseError);
          assert.throws(() => skipByForm(new Cursor(bytes), form, 4), DwarfParseError);
        },
      ),
    );
  });
});
