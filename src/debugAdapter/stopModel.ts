/**
 * The shared headless stop model (docs/trace-cli-internal.md, "Shared headless core").
 *
 * `buildStopModel` is the single source of truth for a trace's stop points, so
 * the IDE (SorobanDebugSession) and the CLI can never disagree about where a
 * "stop" is. From a resolved trace it derives the validated-position → indices
 * map, the visible record indices, the per-record call depths, the raw line-run
 * starts, the statement-granularity run starts (post S17/S18), and the
 * first/last stop points. `replayCursor.ts` then does all its stepping within it.
 *
 * `pcAtIndex` is the current-PC rule the session uses: the validated code
 * offset at `index`, or the nearest EARLIER record that has one, else null.
 *
 * Pure module (no `vscode`, no DAP imports).
 */

import {
  FunctionRange,
  WasmFrame,
  classifyLineRole,
  computeFrames,
  computeRunStarts,
  myCodeStops,
  statementStops,
} from './stops';
import { ResolvedTrace } from './types';

export interface StopModel {
  /** Validated code offset → trace indices (never raw pos; global-init excluded). */
  validatedPosToIndices: Map<number, number[]>;
  /** Visible (validated-position) record indices, ascending. */
  visibleIndices: number[];
  /**
   * Innermost wasm frame per record, from `computeFrames` — the call stack the
   * Callstack view is built from (docs/callstack.md, C1). Depth-only consumers
   * read `depths`, which is this projected.
   */
  frames: (WasmFrame | null)[];
  /** The function ranges `WasmFrame.fn` indexes, sorted by start. */
  ranges: readonly FunctionRange[];
  /** Call depth per record (parallel to records). */
  depths: number[];
  /** Raw line-run starts, pre-S17/S18 (for breakpoint narrowing). */
  rawRunStarts: number[];
  /** Statement-granularity stop points, post-S17/S18 (the source stops). */
  runStarts: number[];
  /** runStarts[0] ?? visibleIndices[0] ?? 0. */
  firstStopPoint: number;
  /** runStarts[last] ?? visibleIndices[last] ?? max(0, records.length-1). */
  lastStopPoint: number;
}

/**
 * Derive the trace's stop model from a resolved trace.
 *
 * `opts.justMyCode` (default true, S21) restricts the statement-granularity
 * stop set to workspace source, dropping stops that rest in Rust toolchain or
 * crates.io dependency sources. Instruction granularity, depths, raw run
 * starts, and the position map are unaffected.
 */
export function buildStopModel(
  resolved: ResolvedTrace,
  opts?: { justMyCode?: boolean },
): StopModel {
  const { model, source, disassembly, positions } = resolved;
  const justMyCode = opts?.justMyCode ?? true;

  const validatedPosToIndices = new Map<number, number[]>();
  const visibleIndices: number[] = [];
  positions.forEach((pos, i) => {
    if (pos !== null) {
      visibleIndices.push(i);
      const list = validatedPosToIndices.get(pos);
      if (list) {
        list.push(i);
      } else {
        validatedPosToIndices.set(pos, [i]);
      }
    }
  });

  const { frames, ranges } = computeFrames(model.records, positions, disassembly.functionRanges);
  const depths = frames.map((frame) => frame?.depth ?? 0);
  const rawRunStarts = computeRunStarts(positions, depths, (i) => source.lineKeyForIndex(i));
  const stmtStops = statementStops(rawRunStarts, depths, (i) =>
    classifyLineRole(source.sourceTextForIndex(i)),
  );
  // S21: after S17/S18, restrict source stops to the user's own workspace code.
  const runStarts = justMyCode
    ? myCodeStops(stmtStops, (i) => source.locationForIndex(i)?.path ?? null)
    : stmtStops;

  const firstStopPoint = runStarts[0] ?? visibleIndices[0] ?? 0;
  const lastStopPoint =
    runStarts[runStarts.length - 1] ??
    visibleIndices[visibleIndices.length - 1] ??
    Math.max(0, model.records.length - 1);

  return {
    validatedPosToIndices,
    visibleIndices,
    frames,
    ranges,
    depths,
    rawRunStarts,
    runStarts,
    firstStopPoint,
    lastStopPoint,
  };
}

/**
 * The current-PC rule: the validated code offset at `index`, or the nearest
 * EARLIER record that has one, else null.
 */
export function pcAtIndex(positions: readonly (number | null)[], index: number): number | null {
  for (let i = index; i >= 0; i--) {
    const pos = positions[i];
    if (pos !== null && pos !== undefined) {
      return pos;
    }
  }
  return null;
}
