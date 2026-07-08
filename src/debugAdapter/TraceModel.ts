/**
 * In-memory model of a komet-node execution trace, plus the cursor that powers
 * time-travel replay. The debug adapter owns one TraceModel per session and
 * translates every DAP stepping request into a cursor move on this model;
 * which indices are legal stop points is decided by the run/visible/depth
 * computation in stops.ts, not here.
 *
 * Pure module (no `vscode` / DAP imports) so the replay logic is unit-testable.
 */

import { TraceRecord } from '../komet/trace';

export class TraceModel {
  readonly records: TraceRecord[];
  private _cursor = 0;

  constructor(records: TraceRecord[]) {
    this.records = records;
  }

  get length(): number {
    return this.records.length;
  }

  get cursor(): number {
    return this._cursor;
  }

  get current(): TraceRecord {
    return this.records[this._cursor];
  }

  get isEmpty(): boolean {
    return this.records.length === 0;
  }

  /** Move the cursor to `index`, clamped to range. Returns the new cursor. */
  seek(index: number): number {
    this._cursor = clamp(index, 0, Math.max(0, this.records.length - 1));
    return this._cursor;
  }

  /**
   * Find the next trace index strictly after the cursor that is in `indexSet`
   * (the resolved breakpoint indices). Returns null if none (caller typically
   * runs to the end).
   */
  nextIndexInSet(indexSet: ReadonlySet<number>): number | null {
    for (let i = this._cursor + 1; i < this.records.length; i++) {
      if (indexSet.has(i)) {
        return i;
      }
    }
    return null;
  }

  /**
   * Find the previous trace index strictly before the cursor that is in
   * `indexSet`. Returns null if none (caller typically runs to the start).
   */
  prevIndexInSet(indexSet: ReadonlySet<number>): number | null {
    for (let i = this._cursor - 1; i >= 0; i--) {
      if (indexSet.has(i)) {
        return i;
      }
    }
    return null;
  }
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}
