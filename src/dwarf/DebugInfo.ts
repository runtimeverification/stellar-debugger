/**
 * Facade over the DWARF value-inspection modules: from a wasm binary's debug
 * sections it assembles the parsed DIE tree (`parseDebugInfo`), a `TypeRegistry`
 * over that tree, a `ScopeIndex` for PC → function/variable lookup, and the raw
 * `.debug_loc` bytes needed for location-list resolution.
 *
 * Absent `.debug_info`/`.debug_abbrev` are the `null` case — a stripped module
 * carries no variable info; malformed or unsupported DWARF throws
 * `DwarfParseError` (from `parseDebugInfo`) or `WasmFormatError` (from the
 * section walker), which the caller catches to degrade. Mirrors
 * `DwarfLineTable.fromWasm`.
 *
 * Pure module (no `vscode` imports, no external deps).
 */

import { parseDebugInfo, DebugInfo } from './die';
import { DebugInfoSections } from './info';
import { TypeRegistry } from './TypeRegistry';
import { ScopeIndex } from './ScopeIndex';
import { parseWasmSections } from '../wasm/sections';

export class DwarfDebugInfo {
  readonly info: DebugInfo;
  readonly types: TypeRegistry;
  readonly scopes: ScopeIndex;
  /** The `.debug_loc` section bytes, when present (needed for location lists). */
  readonly debugLoc?: Uint8Array;

  private constructor(info: DebugInfo, types: TypeRegistry, scopes: ScopeIndex, debugLoc?: Uint8Array) {
    this.info = info;
    this.types = types;
    this.scopes = scopes;
    this.debugLoc = debugLoc;
  }

  /**
   * Builds the facade from a wasm binary. Returns null when the module carries
   * no `.debug_info` or no `.debug_abbrev` section; throws `DwarfParseError`
   * (unsupported/malformed DWARF) or `WasmFormatError` (bad wasm) otherwise.
   */
  static fromWasm(bytes: Uint8Array): DwarfDebugInfo | null {
    const parsed = parseWasmSections(bytes);
    const info = parsed.customSection('.debug_info');
    const abbrev = parsed.customSection('.debug_abbrev');
    if (!info || !abbrev) {
      return null;
    }
    const sections: DebugInfoSections = {
      info,
      abbrev,
      str: parsed.customSection('.debug_str'),
      lineStr: parsed.customSection('.debug_line_str'),
    };
    const debugInfo = parseDebugInfo(sections);
    const types = new TypeRegistry(debugInfo.dieByOffset);
    const scopes = new ScopeIndex(debugInfo, parsed.customSection('.debug_ranges'));
    const debugLoc = parsed.customSection('.debug_loc');
    return new DwarfDebugInfo(debugInfo, types, scopes, debugLoc);
  }
}
