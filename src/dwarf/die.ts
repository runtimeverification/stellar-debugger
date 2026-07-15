/**
 * Full DIE-tree parse of `.debug_info` (DWARF v4/v5, 32-bit, little-endian).
 * Walks every compilation unit into a tree of `Die` nodes and builds one
 * **global** `dieByOffset` map keyed by absolute section offset.
 *
 * The whole section is read through a single `Cursor` whose position is
 * absolute, so a DIE's `secOffset` is just `cursor.pos` before its abbrev code.
 * Because `readForm` resolves CU-relative refs as `cuHeaderStart + R` (the same
 * base DWARF measures them from), a resolved `ref` value equals the absolute
 * `secOffset` of its target — so both CU-relative and cross-CU (`ref_addr`)
 * references resolve by a single `dieByOffset` lookup.
 *
 * Attribute decoding is delegated entirely to `readForm` (M1); this module only
 * walks the tree structure. Pure module (no `vscode` imports, no external deps).
 */

import { Cursor, DwarfParseError } from './cursor';
import { parseAbbrevTable, AbbrevDecl } from './abbrev';
import { readForm, AttrValue, FormContext } from './forms';
import { DebugInfoSections } from './info';
import * as C from './constants';

/** One Debugging Information Entry. */
export interface Die {
  /** Absolute offset in `.debug_info`. */
  secOffset: number;
  /** DW_TAG_* tag from the abbreviation declaration. */
  tag: number;
  /** DW_AT_* -> decoded value (from `readForm`). */
  attrs: Map<number, AttrValue>;
  children: Die[];
}

/** One compilation unit: its header metadata plus its root DIE. */
export interface CompUnit {
  version: number;
  addressSize: number;
  /** Absolute offset of the CU's `unit_length` field (== cuHeaderStart). */
  headerStart: number;
  /** The root DIE (DW_TAG_compile_unit). */
  die: Die;
}

/** The parsed section: every CU plus a global absolute-offset -> DIE map. */
export interface DebugInfo {
  units: CompUnit[];
  /** Spans ALL CUs; keyed by absolute `secOffset`. */
  dieByOffset: Map<number, Die>;
}

/**
 * Parses every compilation unit in a `.debug_info` section into a DIE tree.
 * Throws DwarfParseError on unsupported versions, 64-bit DWARF, or malformed
 * data (e.g. an unknown abbreviation code).
 */
export function parseDebugInfo(sections: DebugInfoSections): DebugInfo {
  const cursor = new Cursor(sections.info); // pos is absolute.
  const units: CompUnit[] = [];
  const dieByOffset = new Map<number, Die>();

  while (!cursor.atEnd) {
    const headerStart = cursor.pos;
    const unitLength = cursor.initialLength(); // 4 bytes; throws on 64-bit DWARF.
    const unitEnd = cursor.pos + unitLength;

    const version = cursor.u16();
    let abbrevOffset: number;
    let addressSize: number;
    if (version === 4) {
      abbrevOffset = cursor.u32();
      addressSize = cursor.u8();
    } else if (version === 5) {
      cursor.u8(); // unit_type
      addressSize = cursor.u8();
      abbrevOffset = cursor.u32();
    } else {
      throw new DwarfParseError(`unsupported .debug_info version ${version} (expected 4 or 5)`);
    }

    const abbrevs = parseAbbrevTable(sections.abbrev, abbrevOffset);
    const ctx: FormContext = {
      addressSize,
      cuHeaderStart: headerStart,
      str: sections.str,
      lineStr: sections.lineStr,
    };

    const root = readDie(cursor, abbrevs, ctx, dieByOffset);
    if (root) {
      units.push({ version, addressSize, headerStart, die: root });
    }

    // Defensive: skip any trailing padding to the unit boundary.
    if (cursor.pos < unitEnd) {
      cursor.skip(unitEnd - cursor.pos);
    }
  }

  return { units, dieByOffset };
}

/**
 * Reads one DIE and its whole subtree from `cursor`, registering each in
 * `dieByOffset` by absolute offset. Returns `null` for a null entry (abbrev
 * code 0), which terminates a sibling list.
 */
function readDie(
  cursor: Cursor,
  abbrevs: Map<number, AbbrevDecl>,
  ctx: FormContext,
  dieByOffset: Map<number, Die>,
): Die | null {
  const secOffset = cursor.pos;
  const code = cursor.uleb();
  if (code === 0) {
    return null; // Null entry: ends a sibling list.
  }
  const decl = abbrevs.get(code);
  if (!decl) {
    throw new DwarfParseError(`unknown abbreviation code ${code}`);
  }

  const attrs = new Map<number, AttrValue>();
  for (const attr of decl.attrs) {
    attrs.set(attr.at, readForm(cursor, attr, ctx));
  }

  const die: Die = { secOffset, tag: decl.tag, attrs, children: [] };
  dieByOffset.set(secOffset, die);

  if (decl.hasChildren) {
    for (;;) {
      const child = readDie(cursor, abbrevs, ctx, dieByOffset);
      if (child === null) {
        break;
      }
      die.children.push(child);
    }
  }
  return die;
}

/** The DIE's DW_AT_name, when present as a string attribute. */
export function dieName(die: Die): string | undefined {
  const value = die.attrs.get(C.DW_AT_name);
  return value && value.kind === 'str' ? value.value : undefined;
}

/** The DIE's `at` attribute as a number, when present as a uint/int value. */
export function dieUint(die: Die, at: number): number | undefined {
  const value = die.attrs.get(at);
  return value && (value.kind === 'uint' || value.kind === 'int') ? value.value : undefined;
}

/** The DIE's `at` attribute as a resolved reference offset, when it is a ref. */
export function dieRef(die: Die, at: number): number | undefined {
  const value = die.attrs.get(at);
  return value && value.kind === 'ref' ? value.value : undefined;
}
