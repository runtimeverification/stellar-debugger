/**
 * Facade over the DWARF modules: builds a single code-offset → source-location
 * table from a wasm binary's debug sections. Scans `.debug_info` for each
 * compilation unit's line program and comp dir, parses every referenced line
 * program, resolves file indices to normalized paths (relative directories
 * resolve against the unit's comp dir), and merges all rows sorted by address.
 *
 * Addresses are CODE OFFSETS — relative to the code section's payload — which
 * on this target is the same space as komet-node's `pos` and as the DWARF
 * addresses themselves: no delta (verified by scripts/verify-addresses.mjs).
 *
 * Absent debug sections are the `null` case; malformed DWARF throws
 * DwarfParseError — the caller decides whether to degrade.
 *
 * Pure module (no `vscode` imports, no external deps).
 */

import { posix } from 'path';
import { DwarfParseError } from './cursor';
import { scanCompilationUnits, CompilationUnitInfo } from './info';
import { parseLineProgram, LineProgramUnit } from './line';
import { parseWasmSections } from '../wasm/sections';

/** One line-table entry; `address` is a code offset (code-payload-relative). */
export interface LineEntry {
  address: number;
  path: string;
  line: number;
  column: number;
  isStmt: boolean;
  endSequence: boolean;
}

export class DwarfLineTable {
  /** All entries from all units, sorted by address. */
  readonly entries: readonly LineEntry[];
  /**
   * Per line program (keyed by its `.debug_line` offset, i.e. a CU's
   * DW_AT_stmt_list) the unit's resolved file table, indexable by file index.
   * `.debug_info` states an inlined call site as such an index (docs/callstack.md,
   * C2), and this is the only place the two tables can be joined.
   */
  private readonly filesByProgram: Map<number, string[]>;

  private constructor(entries: LineEntry[], filesByProgram: Map<number, string[]>) {
    this.entries = entries;
    this.filesByProgram = filesByProgram;
  }

  /**
   * The path of `fileIndex` in the line program at `stmtListOffset` — the
   * resolution DWARF's `DW_AT_call_file` needs. Undefined when either index is
   * unknown to the table.
   */
  filePath(stmtListOffset: number, fileIndex: number): string | undefined {
    return this.filesByProgram.get(stmtListOffset)?.[fileIndex];
  }

  /**
   * Builds the table from a wasm binary. Returns null when the module carries
   * no `.debug_line` or no `.debug_info` section; throws DwarfParseError when
   * the sections are present but malformed or unsupported.
   */
  static fromWasm(bytes: Uint8Array): DwarfLineTable | null {
    const parsed = parseWasmSections(bytes);
    const debugLine = parsed.customSection('.debug_line');
    const info = parsed.customSection('.debug_info');
    if (!debugLine || !info) {
      return null;
    }
    const abbrev = parsed.customSection('.debug_abbrev');
    if (!abbrev) {
      throw new DwarfParseError('.debug_info present but .debug_abbrev missing');
    }
    const str = parsed.customSection('.debug_str');
    const lineStr = parsed.customSection('.debug_line_str');

    const entries: LineEntry[] = [];
    const filesByProgram = new Map<number, string[]>();
    const cus = scanCompilationUnits({ info, abbrev, str, lineStr });
    for (const cu of cus) {
      if (cu.stmtListOffset === undefined || filesByProgram.has(cu.stmtListOffset)) {
        continue;
      }
      const unit = parseLineProgram(debugLine, cu.stmtListOffset, { str, lineStr });
      filesByProgram.set(
        cu.stmtListOffset,
        unit.files.map((_, index) => resolveFilePath(unit, cu, index)),
      );
      collectEntries(unit, cu, entries);
    }

    // Sort by address; at equal addresses end_sequence rows come first so a
    // new sequence starting exactly where another ended wins the lookup.
    entries.sort((a, b) => a.address - b.address || Number(b.endSequence) - Number(a.endSequence));
    return new DwarfLineTable(entries, filesByProgram);
  }

  /**
   * The entry covering `codeOffset`: the greatest entry with
   * `address <= codeOffset`. Returns null when there is none, or when that
   * entry is an end_sequence row (offsets past a sequence end are unmapped).
   */
  lookup(codeOffset: number): LineEntry | null {
    // Binary search for the rightmost entry with address <= codeOffset.
    let lo = 0;
    let hi = this.entries.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.entries[mid].address <= codeOffset) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found < 0 || this.entries[found].endSequence) {
      return null;
    }
    return this.entries[found];
  }

  /** Code offsets of all rows exactly matching `path` and `line`. */
  addressesFor(path: string, line: number): number[] {
    return this.entries
      .filter((e) => !e.endSequence && e.path === path && e.line === line)
      .map((e) => e.address);
  }

  /** Unique, sorted paths appearing in the table. */
  files(): string[] {
    const unique = new Set<string>();
    for (const e of this.entries) {
      if (!e.endSequence) {
        unique.add(e.path);
      }
    }
    return Array.from(unique).sort();
  }
}

/** Resolves one unit's rows through its dir/file tables into `out`. */
function collectEntries(unit: LineProgramUnit, cu: CompilationUnitInfo, out: LineEntry[]): void {
  const pathCache = new Map<number, string>();
  const resolve = (fileIndex: number): string => {
    let resolved = pathCache.get(fileIndex);
    if (resolved === undefined) {
      resolved = resolveFilePath(unit, cu, fileIndex);
      pathCache.set(fileIndex, resolved);
    }
    return resolved;
  };
  for (const row of unit.rows) {
    out.push({
      address: row.address,
      path: resolve(row.fileIndex),
      line: row.line,
      column: row.column,
      isStmt: row.isStmt,
      endSequence: row.endSequence,
    });
  }
}

/**
 * Joins a file entry's directory and name into a normalized path (posix
 * semantics). Relative directories — and the v4 reserved directory index 0 —
 * resolve against the unit's comp dir when available.
 */
function resolveFilePath(unit: LineProgramUnit, cu: CompilationUnitInfo, fileIndex: number): string {
  const file = unit.files[fileIndex];
  // The v4 reserved file 0 (empty-name placeholder) is the unit's primary file.
  const name = file !== undefined && file.name !== '' ? file.name : (cu.name ?? '');
  if (posix.isAbsolute(name)) {
    return posix.normalize(name);
  }
  const dir = (file !== undefined ? unit.directories[file.dirIndex] : undefined) ?? '';
  const base = posix.isAbsolute(dir) ? dir : posix.join(cu.compDir ?? '', dir);
  return posix.normalize(posix.join(base, name));
}
