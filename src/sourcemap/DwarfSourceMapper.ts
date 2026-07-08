/**
 * DWARF-backed SourceMapper: joins a trace with a wasm binary's line table to
 * answer every mapping question the debug adapter asks.
 *
 * Per-record locations are precomputed at construction from the caller's
 * validated positions (see debugAdapter/artifacts.ts — a record whose `pos`
 * lives in another section's address space arrives as null). A line-table hit
 * only counts as a location when it is not an end_sequence marker, its line is
 * not 0 (DWARF line 0 = compiler-generated code with no source line), and its
 * file exists on disk — DWARF routinely names /rustc/... and unresolved
 * crates.io registry paths that the user cannot open. Existence is checked
 * once per unique (normalized) path and cached.
 *
 * Breakpoints resolve against the EXECUTED lines only, sliding forward to the
 * nearest executed line >= the requested one (native-debugger style; with
 * opt-level=z many lines carry no code at all).
 *
 * Pure module (uses fs/path, no `vscode` imports).
 */

import * as fs from 'fs';
import * as path from 'path';
import { TraceModel } from '../debugAdapter/TraceModel';
import { DwarfLineTable, LineEntry } from '../dwarf/LineTable';
import { MappedLocation, ResolvedBreakpoint, SourceMapper } from './SourceMapper';

/** Per-file index of the executed mapped lines. */
interface FileLines {
  /** Sorted unique executed lines. */
  lines: number[];
  /** line -> all trace indices located exactly there. */
  indices: Map<number, number[]>;
}

export class DwarfSourceMapper implements SourceMapper {
  private readonly lineTable: DwarfLineTable;
  private readonly fileExists: (p: string) => boolean;
  private readonly existsCache = new Map<string, boolean>();
  /** Precomputed location per trace index (null = unmapped). */
  private readonly locations: (MappedLocation | null)[];
  /** Executed mapped lines, grouped by normalized file path. */
  private readonly executedByFile = new Map<string, FileLines>();

  constructor(
    model: TraceModel,
    lineTable: DwarfLineTable,
    validPos: (number | null)[],
    fileExists: (p: string) => boolean = fs.existsSync,
  ) {
    this.lineTable = lineTable;
    this.fileExists = fileExists;

    this.locations = validPos.map((pos) => (pos === null ? null : this.mapEntry(lineTable.lookup(pos))));

    for (let i = 0; i < this.locations.length && i < model.length; i++) {
      const loc = this.locations[i];
      if (loc === null) {
        continue;
      }
      let file = this.executedByFile.get(loc.path);
      if (!file) {
        file = { lines: [], indices: new Map() };
        this.executedByFile.set(loc.path, file);
      }
      const atLine = file.indices.get(loc.line);
      if (atLine) {
        atLine.push(i);
      } else {
        file.indices.set(loc.line, [i]);
      }
    }
    for (const file of this.executedByFile.values()) {
      file.lines = [...file.indices.keys()].sort((a, b) => a - b);
    }
  }

  hasLineInfo(): boolean {
    return this.locations.some((loc) => loc !== null);
  }

  locationForIndex(index: number): MappedLocation | null {
    return this.locations[index] ?? null;
  }

  locationForAddress(codeOffset: number): MappedLocation | null {
    return this.mapEntry(this.lineTable.lookup(codeOffset));
  }

  resolveBreakpoint(requestedPath: string, line: number): ResolvedBreakpoint | null {
    const file = this.executedByFile.get(path.normalize(requestedPath));
    if (!file) {
      return null;
    }
    const chosen = file.lines.find((l) => l >= line);
    if (chosen === undefined) {
      return null;
    }
    return { line: chosen, indices: [...(file.indices.get(chosen) ?? [])] };
  }

  executedLines(requestedPath: string, fromLine: number, toLine: number): number[] {
    const file = this.executedByFile.get(path.normalize(requestedPath));
    if (!file) {
      return [];
    }
    return file.lines.filter((l) => l >= fromLine && l <= toLine);
  }

  lineKeyForIndex(index: number): string | null {
    const loc = this.locations[index] ?? null;
    return loc === null ? null : `${loc.path}:${loc.line}`;
  }

  /** Filter and normalize a line-table entry into a displayable location. */
  private mapEntry(entry: LineEntry | null): MappedLocation | null {
    if (entry === null || entry.endSequence || entry.line === 0) {
      return null;
    }
    const normalized = path.normalize(entry.path);
    if (!this.cachedExists(normalized)) {
      return null;
    }
    const loc: MappedLocation = { path: normalized, line: entry.line };
    if (entry.column > 0) {
      loc.column = entry.column;
    }
    return loc;
  }

  private cachedExists(p: string): boolean {
    let exists = this.existsCache.get(p);
    if (exists === undefined) {
      exists = this.fileExists(p);
      this.existsCache.set(p, exists);
    }
    return exists;
  }
}
