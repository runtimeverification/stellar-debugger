/**
 * Reader for DWARF v4 `.debug_loc` location lists. A variable whose location
 * changes across its lifetime carries a `DW_FORM_sec_offset` into this section;
 * the list there maps program-counter ranges to the location expression valid
 * over each range.
 *
 * Each entry is two addressSize-wide values (`begin`, `end`):
 *   - `(0, 0)`                    end-of-list terminator
 *   - `(0xffffffff, newBase)`     base-selection entry: the running base becomes
 *                                 `newBase` for subsequent entries (no expression)
 *   - otherwise                   a location entry covering the half-open range
 *                                 `[base + begin, base + end)`, followed by a
 *                                 `u16` length and that many expression bytes
 *
 * The running base starts at the CU's `DW_AT_low_pc`. Addresses are 4 bytes
 * (this target's WASM address size).
 *
 * Pure module (no `vscode` imports, no external deps).
 */

import { Cursor } from './cursor';

/**
 * Returns the location-expression bytes for `pc` from the list starting at
 * `offset` in `data`, or `null` when no entry covers `pc`. `cuLowPc` seeds the
 * running base address. The returned array is a view into `data`.
 */
export function selectLocation(
  data: Uint8Array,
  offset: number,
  pc: number,
  cuLowPc: number,
): Uint8Array | null {
  const cursor = new Cursor(data);
  cursor.skip(offset);

  let base = cuLowPc;
  while (!cursor.atEnd) {
    const begin = cursor.u32();
    const end = cursor.u32();

    if (begin === 0 && end === 0) {
      return null; // End-of-list terminator.
    }
    if (begin === 0xffffffff) {
      base = end; // Base-selection entry: no expression follows.
      continue;
    }

    const exprBytes = cursor.bytes(cursor.u16());
    if (pc >= base + begin && pc < base + end) {
      return exprBytes;
    }
  }
  return null;
}
