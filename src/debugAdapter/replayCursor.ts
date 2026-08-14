/**
 * The stepping engine: every forward and reverse move the debug adapter makes,
 * expressed as a cursor move over a `TraceModel` constrained to a `StopModel`'s
 * stop points (docs/stepping.md, S1–S21).
 *
 * The adapter's DAP handlers do nothing but translate a request into one call
 * here and turn the returned outcome into a `StoppedEvent` or a
 * `TerminatedEvent`. Keeping the rules in a pure module means they can be
 * unit-tested without a DAP client, and means "where does a step land" has one
 * answer shared by every consumer.
 *
 * Pure module (no `vscode` / DAP imports).
 */

import { TraceModel } from './TraceModel';
import { StopModel } from './stopModel';
import { SourceMapper } from '../sourcemap/SourceMapper';

/**
 * Stepping granularity, in the adapter's own vocabulary: `statement` rests on
 * source statements, `instruction` on individual wasm instructions. DAP's
 * `SteppingGranularity` maps onto this at the request boundary.
 */
export type Granularity = 'statement' | 'instruction';

/**
 * The outcome of a forward step. A statement step past the last statement ENDS
 * the session (S20) — the replayed contract has returned from its outermost
 * recorded frame — where every other move comes to rest somewhere.
 */
export type StepOutcome = 'stopped' | 'terminated';

/** Where a run to the next/previous breakpoint came to rest. */
export type RunOutcome = 'breakpoint' | 'clamped';

export class ReplayCursor {
  constructor(
    private readonly model: TraceModel,
    private readonly stops: StopModel,
  ) {}

  /** The trace index the cursor rests on. */
  get index(): number {
    return this.model.cursor;
  }

  /** Call depth of the record at the cursor (docs/stepping.md, Model/depth). */
  get depth(): number {
    return this.stops.depths[this.model.cursor] ?? 0;
  }

  /**
   * S1: seek the entry stop — the trace's first stop point, never one of the
   * invisible/unmapped records at its head.
   */
  toEntry(): void {
    this.model.seek(this.stops.firstStopPoint);
  }

  /**
   * S2/S5/S7/S20: seek the first stop point after the cursor whose depth is
   * `<= maxDepth` (`Infinity` for step-in, the current depth for step-over, one
   * less for step-out). With no such stop ahead, a STATEMENT step terminates
   * (S20) while an INSTRUCTION step — or a wasm-less replay with no statement
   * stops at all — clamps to the last stop point and still reports a stop (S2).
   */
  stepForward(granularity: Granularity, maxDepth: number): StepOutcome {
    const points = this.stopPoints(granularity);
    for (const i of points) {
      if (i > this.model.cursor && this.stops.depths[i] <= maxDepth) {
        this.model.seek(i);
        return 'stopped';
      }
    }
    if (this.hasStatementStops(granularity)) {
      return 'terminated';
    }
    if (points.length > 0) {
      this.model.seek(points[points.length - 1]);
    }
    return 'stopped';
  }

  /**
   * S3/S8: move to the nearest earlier stop point whose depth is `<= maxDepth`.
   * With none behind, clamp to the first stop point (staying put when already
   * there); an empty stop-point list leaves the cursor where it is. Reverse
   * steps always clamp and never terminate — S20 is forward-only.
   */
  stepBackward(granularity: Granularity, maxDepth: number): void {
    const points = this.stopPoints(granularity);
    if (points.length === 0) {
      return;
    }
    for (let k = points.length - 1; k >= 0; k--) {
      const i = points[k];
      if (i < this.model.cursor && this.stops.depths[i] <= maxDepth) {
        this.model.seek(i);
        return;
      }
    }
    this.model.seek(points[0]);
  }

  /**
   * Run forward to the next breakpoint index. S14: with none ahead, settle on
   * the LAST stop point rather than on the trace's trailing invisible records.
   */
  runForward(breakpoints: ReadonlySet<number>): RunOutcome {
    const target = this.model.nextIndexInSet(breakpoints);
    this.model.seek(target ?? this.stops.lastStopPoint);
    return target === null ? 'clamped' : 'breakpoint';
  }

  /** Run backward to the previous breakpoint index; S14 clamps to the first stop. */
  runBackward(breakpoints: ReadonlySet<number>): RunOutcome {
    const target = this.model.prevIndexInSet(breakpoints);
    this.model.seek(target ?? this.stops.firstStopPoint);
    return target === null ? 'clamped' : 'breakpoint';
  }

  /**
   * The stop points of a granularity: the statement stops for statement
   * stepping, the visible records for instruction stepping — and also for
   * statement stepping over a trace where no record maps to a source line.
   */
  private stopPoints(granularity: Granularity): readonly number[] {
    return this.hasStatementStops(granularity) ? this.stops.runStarts : this.stops.visibleIndices;
  }

  private hasStatementStops(granularity: Granularity): boolean {
    return granularity === 'statement' && this.stops.runStarts.length > 0;
  }
}

/**
 * The trace indices the client's breakpoints resolve to.
 *
 * A source breakpoint stops once per EXECUTION of its line (S12): the mapper's
 * per-record resolution is narrowed to the RAW line-run starts, so forward and
 * reverse continue agree on one index per run (S13). The raw starts — not the
 * S17/S18-filtered statement stops — are the right yardstick: breakpoint
 * resolution is unaffected by declaration/brace filtering, so a breakpoint on a
 * filtered line must still fire once per run. Instruction breakpoints stop on
 * every record at their validated address (S15).
 */
export function resolveBreakpoints(
  stops: StopModel,
  source: SourceMapper | undefined,
  sourceBreakpoints: ReadonlyMap<string, readonly { line: number }[]>,
  instructionAddresses: readonly number[],
): Set<number> {
  const indices = new Set<number>();
  if (source) {
    const runStartSet = new Set(stops.rawRunStarts);
    for (const [file, breakpoints] of sourceBreakpoints) {
      for (const bp of breakpoints) {
        for (const i of source.resolveBreakpoint(file, bp.line)?.indices ?? []) {
          if (runStartSet.has(i)) {
            indices.add(i);
          }
        }
      }
    }
  }
  for (const address of instructionAddresses) {
    for (const i of stops.validatedPosToIndices.get(address) ?? []) {
      indices.add(i);
    }
  }
  return indices;
}
