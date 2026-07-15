/**
 * The value-returning mirror of `skipByForm` (in `info.ts`): `readForm` advances
 * the cursor by *exactly* the same number of bytes as `skipByForm` for every
 * form, but returns the decoded value instead of discarding it. This
 * byte-for-byte parity is the module's core invariant — DIE parsing relies on it
 * to stay aligned after every attribute, whether the value is usable or not. The
 * parity holds for this target's 4-byte address size; `readForm` supports only
 * 1/2/4-byte fixed integers, so a hypothetical 8-byte-address CU would be rejected
 * by `readUint` (whereas `skipByForm` would skip it) — out of scope for M1/M2.
 *
 * Forms that cannot be resolved offline (strx*, addrx*, sup, ref_sig8, the
 * indexed x-forms) still consume their bytes and return `{ kind: 'unavailable' }`.
 * Those cases delegate to `skipByForm` so their advancement can never drift.
 *
 * Pure module (no `vscode` imports, no external deps).
 */

import { Cursor, DwarfParseError } from './cursor';
import { AbbrevAttr } from './abbrev';
import { skipByForm, stringAt } from './info';
import * as C from './constants';

/** A decoded attribute value, tagged by how it should be interpreted. */
export type AttrValue =
  | { kind: 'uint'; value: number } // addr, data1/2/4/8, udata, sec_offset
  | { kind: 'int'; value: number } // sdata, implicit_const
  | { kind: 'str'; value: string } // string, strp, line_strp
  | { kind: 'flag'; value: boolean } // flag, flag_present
  | { kind: 'ref'; value: number } // ref1/2/4/8, ref_udata (CU-relative), ref_addr (absolute)
  | { kind: 'block'; value: Uint8Array } // exprloc, block, block1/2/4, data16
  | { kind: 'unavailable' }; // forms not resolvable offline (still consumes bytes!)

/** The CU-level context needed to decode reference and string forms. */
export interface FormContext {
  /** Address size from the CU header (4 on this target). */
  addressSize: number;
  /** Absolute offset in `.debug_info` of the CU's `unit_length` field. */
  cuHeaderStart: number;
  /** `.debug_str` (backs DW_FORM_strp). */
  str?: Uint8Array;
  /** `.debug_line_str` (backs DW_FORM_line_strp). */
  lineStr?: Uint8Array;
}

/**
 * Reads one attribute value of `attr.form`, advancing `cursor` by the same byte
 * count as `skipByForm`. `attr` carries the form and, for `implicit_const`, the
 * value stored in the abbreviation declaration. Throws DwarfParseError on an
 * unknown form (matching `skipByForm`).
 */
export function readForm(cursor: Cursor, attr: AbbrevAttr, ctx: FormContext): AttrValue {
  const form = attr.form;
  switch (form) {
    case C.DW_FORM_addr:
      return { kind: 'uint', value: readUint(cursor, ctx.addressSize) };
    case C.DW_FORM_data1:
      return { kind: 'uint', value: cursor.u8() };
    case C.DW_FORM_data2:
      return { kind: 'uint', value: cursor.u16() };
    case C.DW_FORM_data4:
      return { kind: 'uint', value: cursor.u32() };
    case C.DW_FORM_data8:
      return { kind: 'uint', value: readU64AsNumber(cursor) };
    case C.DW_FORM_data16:
      return { kind: 'block', value: cursor.bytes(16) };
    case C.DW_FORM_sdata:
      return { kind: 'int', value: cursor.sleb() };
    case C.DW_FORM_udata:
      return { kind: 'uint', value: cursor.uleb() };
    case C.DW_FORM_string:
      return { kind: 'str', value: cursor.cstring() };
    case C.DW_FORM_strp:
      return resolveString(stringAt(ctx.str, cursor.u32()));
    case C.DW_FORM_line_strp:
      return resolveString(stringAt(ctx.lineStr, cursor.u32()));
    case C.DW_FORM_ref1:
      return { kind: 'ref', value: ctx.cuHeaderStart + cursor.u8() };
    case C.DW_FORM_ref2:
      return { kind: 'ref', value: ctx.cuHeaderStart + cursor.u16() };
    case C.DW_FORM_ref4:
      return { kind: 'ref', value: ctx.cuHeaderStart + cursor.u32() };
    case C.DW_FORM_ref8:
      return { kind: 'ref', value: ctx.cuHeaderStart + readU64AsNumber(cursor) };
    case C.DW_FORM_ref_udata:
      return { kind: 'ref', value: ctx.cuHeaderStart + cursor.uleb() };
    case C.DW_FORM_ref_addr:
      return { kind: 'ref', value: cursor.u32() }; // section-absolute, no cuHeaderStart.
    case C.DW_FORM_sec_offset:
      return { kind: 'uint', value: cursor.u32() };
    case C.DW_FORM_exprloc:
    case C.DW_FORM_block:
      return { kind: 'block', value: cursor.bytes(cursor.uleb()) };
    case C.DW_FORM_block1:
      return { kind: 'block', value: cursor.bytes(cursor.u8()) };
    case C.DW_FORM_block2:
      return { kind: 'block', value: cursor.bytes(cursor.u16()) };
    case C.DW_FORM_block4:
      return { kind: 'block', value: cursor.bytes(cursor.u32()) };
    case C.DW_FORM_flag:
      return { kind: 'flag', value: cursor.u8() !== 0 };
    case C.DW_FORM_flag_present:
      return { kind: 'flag', value: true }; // No bytes in the DIE.
    case C.DW_FORM_implicit_const:
      return { kind: 'int', value: attr.implicitConst ?? 0 }; // No bytes in the DIE.
    case C.DW_FORM_indirect:
      return readForm(cursor, { at: attr.at, form: cursor.uleb() }, ctx);
    // Forms unresolvable offline: consume their bytes via skipByForm and report
    // unavailable, so advancement can never drift from skipByForm.
    case C.DW_FORM_strx:
    case C.DW_FORM_strx1:
    case C.DW_FORM_strx2:
    case C.DW_FORM_strx3:
    case C.DW_FORM_strx4:
    case C.DW_FORM_addrx:
    case C.DW_FORM_addrx1:
    case C.DW_FORM_addrx2:
    case C.DW_FORM_addrx3:
    case C.DW_FORM_addrx4:
    case C.DW_FORM_strp_sup:
    case C.DW_FORM_ref_sup4:
    case C.DW_FORM_ref_sup8:
    case C.DW_FORM_ref_sig8:
    case C.DW_FORM_loclistx:
    case C.DW_FORM_rnglistx:
      skipByForm(cursor, form, ctx.addressSize);
      return { kind: 'unavailable' };
    default:
      throw new DwarfParseError(`cannot read unknown attribute form 0x${form.toString(16)}`);
  }
}

/** Little-endian fixed-width unsigned integer of `size` (1, 2, or 4) bytes. */
function readUint(cursor: Cursor, size: number): number {
  switch (size) {
    case 1:
      return cursor.u8();
    case 2:
      return cursor.u16();
    case 4:
      return cursor.u32();
    default:
      throw new DwarfParseError(`unsupported address/data size ${size}`);
  }
}

/**
 * Reads an 8-byte little-endian value as `low + high * 2^32`. Values above
 * 2^53 lose precision; acceptable for M1, where 8-byte attributes are rare.
 */
function readU64AsNumber(cursor: Cursor): number {
  const low = cursor.u32();
  const high = cursor.u32();
  return low + high * 2 ** 32;
}

/** A resolved string becomes `str`; a missing section/offset becomes `unavailable`. */
function resolveString(value: string | undefined): AttrValue {
  return value === undefined ? { kind: 'unavailable' } : { kind: 'str', value };
}
