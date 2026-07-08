/**
 * Minimal `.debug_info` compilation-unit scan: walks the unit headers (DWARF
 * v4/v5, 32-bit format) and reads ONLY each unit's root DIE, extracting
 * `DW_AT_stmt_list` (offset of the unit's line program in `.debug_line`),
 * `DW_AT_comp_dir`, and `DW_AT_name`. Every other attribute is skipped by its
 * form; string attributes in forms we cannot resolve offline (strx*, sup) are
 * treated as unavailable rather than errors.
 *
 * Pure module (no `vscode` imports, no external deps).
 */

import { Cursor, DwarfParseError } from './cursor';
import { parseAbbrevTable } from './abbrev';
import * as C from './constants';

/** What the root DIE of one compilation unit told us. */
export interface CompilationUnitInfo {
  /** Offset of the unit's line program in `.debug_line`, when present. */
  stmtListOffset?: number;
  /** Compilation directory (usually absolute), when resolvable. */
  compDir?: string;
  /** Primary source file name (possibly relative to compDir), when resolvable. */
  name?: string;
}

/** The debug sections the scan reads. `str`/`lineStr` back strp/line_strp forms. */
export interface DebugInfoSections {
  info: Uint8Array;
  abbrev: Uint8Array;
  str?: Uint8Array;
  lineStr?: Uint8Array;
}

/**
 * Scans all compilation units of a `.debug_info` section. Throws
 * DwarfParseError on unsupported DWARF versions or malformed data.
 */
export function scanCompilationUnits(sections: DebugInfoSections): CompilationUnitInfo[] {
  const units: CompilationUnitInfo[] = [];
  const cursor = new Cursor(sections.info);
  while (!cursor.atEnd) {
    const unitLength = cursor.initialLength();
    const unit = cursor.sub(unitLength);
    units.push(scanUnit(unit, sections));
  }
  return units;
}

/** Reads one unit's header and root DIE; `unit` is bounded to the unit body. */
function scanUnit(unit: Cursor, sections: DebugInfoSections): CompilationUnitInfo {
  const version = unit.u16();
  let abbrevOffset: number;
  let addressSize: number;
  if (version === 4) {
    abbrevOffset = unit.u32();
    addressSize = unit.u8();
  } else if (version === 5) {
    unit.u8(); // unit_type
    addressSize = unit.u8();
    abbrevOffset = unit.u32();
  } else {
    throw new DwarfParseError(`unsupported .debug_info version ${version} (expected 4 or 5)`);
  }

  const result: CompilationUnitInfo = {};
  const code = unit.uleb();
  if (code === 0) {
    return result; // No root DIE.
  }
  const abbrevs = parseAbbrevTable(sections.abbrev, abbrevOffset);
  const decl = abbrevs.get(code);
  if (!decl) {
    throw new DwarfParseError(`root DIE references unknown abbreviation code ${code}`);
  }

  for (const attr of decl.attrs) {
    if (attr.at === C.DW_AT_stmt_list && (attr.form === C.DW_FORM_sec_offset || attr.form === C.DW_FORM_data4)) {
      result.stmtListOffset = unit.u32();
    } else if (attr.at === C.DW_AT_comp_dir || attr.at === C.DW_AT_name) {
      const value = readStringForm(unit, attr.form, sections);
      if (attr.at === C.DW_AT_comp_dir) {
        result.compDir = value ?? result.compDir;
      } else {
        result.name = value ?? result.name;
      }
    } else {
      skipByForm(unit, attr.form, addressSize);
    }
  }
  return result;
}

/**
 * Reads a string-valued attribute when its form is resolvable offline
 * (string / strp / line_strp); other forms are skipped and yield undefined.
 */
function readStringForm(cursor: Cursor, form: number, sections: DebugInfoSections): string | undefined {
  switch (form) {
    case C.DW_FORM_string:
      return cursor.cstring();
    case C.DW_FORM_strp:
      return stringAt(sections.str, cursor.u32());
    case C.DW_FORM_line_strp:
      return stringAt(sections.lineStr, cursor.u32());
    default:
      skipByForm(cursor, form, 4);
      return undefined;
  }
}

/** NUL-terminated string at `offset` in a string section, if it exists. */
export function stringAt(section: Uint8Array | undefined, offset: number): string | undefined {
  if (!section || offset >= section.length) {
    return undefined;
  }
  const end = section.indexOf(0, offset);
  if (end < 0) {
    return undefined;
  }
  return Buffer.from(section.buffer, section.byteOffset + offset, end - offset).toString('utf8');
}

/**
 * Advances `cursor` past one attribute value of the given form. Complete over
 * the DWARF v4/v5 form set, including `indirect` (form ULEB then recurse) and
 * `implicit_const` (zero bytes — the value lives in the abbrev declaration).
 */
export function skipByForm(cursor: Cursor, form: number, addressSize: number): void {
  switch (form) {
    case C.DW_FORM_addr:
      cursor.skip(addressSize);
      return;
    case C.DW_FORM_data1:
    case C.DW_FORM_ref1:
    case C.DW_FORM_flag:
    case C.DW_FORM_strx1:
    case C.DW_FORM_addrx1:
      cursor.skip(1);
      return;
    case C.DW_FORM_data2:
    case C.DW_FORM_ref2:
    case C.DW_FORM_strx2:
    case C.DW_FORM_addrx2:
      cursor.skip(2);
      return;
    case C.DW_FORM_strx3:
    case C.DW_FORM_addrx3:
      cursor.skip(3);
      return;
    case C.DW_FORM_data4:
    case C.DW_FORM_ref4:
    case C.DW_FORM_strx4:
    case C.DW_FORM_addrx4:
    case C.DW_FORM_sec_offset:
    case C.DW_FORM_strp:
    case C.DW_FORM_line_strp:
    case C.DW_FORM_strp_sup:
    case C.DW_FORM_ref_addr: // 32-bit DWARF
    case C.DW_FORM_ref_sup4:
      cursor.skip(4);
      return;
    case C.DW_FORM_data8:
    case C.DW_FORM_ref8:
    case C.DW_FORM_ref_sig8:
    case C.DW_FORM_ref_sup8:
      cursor.skip(8);
      return;
    case C.DW_FORM_data16:
      cursor.skip(16);
      return;
    case C.DW_FORM_string:
      cursor.cstring();
      return;
    case C.DW_FORM_block1:
      cursor.skip(cursor.u8());
      return;
    case C.DW_FORM_block2:
      cursor.skip(cursor.u16());
      return;
    case C.DW_FORM_block4:
      cursor.skip(cursor.u32());
      return;
    case C.DW_FORM_block:
    case C.DW_FORM_exprloc:
      cursor.skip(cursor.uleb());
      return;
    case C.DW_FORM_sdata:
      cursor.sleb();
      return;
    case C.DW_FORM_udata:
    case C.DW_FORM_ref_udata:
    case C.DW_FORM_strx:
    case C.DW_FORM_addrx:
    case C.DW_FORM_loclistx:
    case C.DW_FORM_rnglistx:
      cursor.uleb();
      return;
    case C.DW_FORM_indirect:
      skipByForm(cursor, cursor.uleb(), addressSize);
      return;
    case C.DW_FORM_flag_present:
    case C.DW_FORM_implicit_const:
      return; // No bytes in the DIE.
    default:
      throw new DwarfParseError(`cannot skip unknown attribute form 0x${form.toString(16)}`);
  }
}
