/**
 * `.debug_abbrev` table parser: decodes one abbreviation table (the sequence
 * of declarations starting at a given section offset, terminated by code 0)
 * into a map from abbreviation code to its tag, children flag, and attribute
 * specs. `DW_FORM_implicit_const` attribute values live in the declaration
 * itself and are captured here.
 *
 * Pure module (no `vscode` imports, no external deps).
 */

import { Cursor } from './cursor';
import { DW_FORM_implicit_const } from './constants';

/** One attribute spec of an abbreviation declaration. */
export interface AbbrevAttr {
  at: number;
  form: number;
  /** SLEB value stored in the declaration when `form` is DW_FORM_implicit_const. */
  implicitConst?: number;
}

/** One abbreviation declaration. */
export interface AbbrevDecl {
  tag: number;
  hasChildren: boolean;
  attrs: AbbrevAttr[];
}

/**
 * Parses the abbreviation table starting at `offset` in a `.debug_abbrev`
 * section. Stops at the code-0 terminator; bytes past it are ignored.
 */
export function parseAbbrevTable(section: Uint8Array, offset: number): Map<number, AbbrevDecl> {
  const cursor = new Cursor(section.subarray(offset));
  const decls = new Map<number, AbbrevDecl>();
  for (;;) {
    const code = cursor.uleb();
    if (code === 0) {
      return decls;
    }
    const tag = cursor.uleb();
    const hasChildren = cursor.u8() !== 0;
    const attrs: AbbrevAttr[] = [];
    for (;;) {
      const at = cursor.uleb();
      const form = cursor.uleb();
      if (at === 0 && form === 0) {
        break;
      }
      const attr: AbbrevAttr = { at, form };
      if (form === DW_FORM_implicit_const) {
        attr.implicitConst = cursor.sleb();
      }
      attrs.push(attr);
    }
    decls.set(code, { tag, hasChildren, attrs });
  }
}
