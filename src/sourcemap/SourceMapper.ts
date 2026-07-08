/**
 * The seam between an execution trace and what the user sees in the editor.
 *
 * komet-node traces carry only a code offset (`pos`) per instruction — no
 * source line. A SourceMapper translates between the debug adapter's two
 * address vocabularies and Rust source locations on disk:
 *
 *   - trace indices (the replay cursor) -> file:line, for stack frames and
 *     line-granularity stepping;
 *   - code offsets (static disassembly addresses) -> file:line, for
 *     annotating disassembly rows;
 *   - file:line -> trace indices, for source breakpoints.
 *
 * The debug adapter only ever talks to this interface; how a position becomes
 * a line is the mapper's business (DWARF for DwarfSourceMapper, nothing for
 * NullSourceMapper), so swapping mappers never touches the adapter.
 *
 * Pure module (no `vscode` imports).
 */

/** A source location resolved to an absolute path on disk. */
export interface MappedLocation {
  /** Absolute path of the source file. */
  path: string;
  /** 1-based line number. */
  line: number;
  /** Optional 1-based column. */
  column?: number;
}

/** A source breakpoint resolved against the executed trace. */
export interface ResolvedBreakpoint {
  /** The verified line — possibly adjusted forward from the requested one. */
  line: number;
  /** All trace indices whose location is exactly that file:line. */
  indices: number[];
}

export interface SourceMapper {
  /** Whether at least one trace record maps to an existing source location. */
  hasLineInfo(): boolean;
  /** Rust location for the record at `index`, or null when unmapped. */
  locationForIndex(index: number): MappedLocation | null;
  /** Rust location for a static code offset (disassembly rows), or null. */
  locationForAddress(codeOffset: number): MappedLocation | null;
  /** Resolve a breakpoint request to an executed line, or null when none. */
  resolveBreakpoint(path: string, line: number): ResolvedBreakpoint | null;
  /** Distinct executed lines in `path` within [fromLine, toLine], ascending. */
  executedLines(path: string, fromLine: number, toLine: number): number[];
  /** Stable '<path>:<line>' equality key for line stepping, or null. */
  lineKeyForIndex(index: number): string | null;
  /** Raw source text of the line the record at `index` maps to, or null. */
  sourceTextForIndex(index: number): string | null;
}
