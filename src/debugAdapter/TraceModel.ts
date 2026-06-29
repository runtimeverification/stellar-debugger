/**
 * In-memory model of a komet-node execution trace, plus the cursor that powers
 * time-travel replay. The debug adapter owns one TraceModel per session and
 * translates every DAP stepping request into a cursor move on this model.
 *
 * Pure module (no `vscode` / DAP imports) so the replay logic is unit-testable.
 */

import { TraceRecord, opcode } from '../komet/trace';

/** Opcodes that descend into a callee (increase call depth). */
const CALL_OPCODES = new Set(['call', 'call_indirect', 'return_call', 'return_call_indirect']);
/** Opcodes that return from the current callee (decrease call depth). */
const RETURN_OPCODES = new Set(['return']);

export class TraceModel {
  readonly records: TraceRecord[];
  private _cursor = 0;

  /** Map from wasm byte offset -> indices in the trace that executed at it. */
  readonly posToIndices: Map<number, number[]>;

  /**
   * Best-effort call depth at each trace index, reconstructed from call/return
   * opcodes. Approximate (implicit returns at function end are not always
   * visible at instruction granularity); used for step-over/step-out and call
   * stack reconstruction in later milestones.
   */
  readonly depthAt: number[];

  constructor(records: TraceRecord[]) {
    this.records = records;
    this.posToIndices = new Map();
    this.depthAt = new Array(records.length);

    let depth = 0;
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (rec.pos !== null) {
        const list = this.posToIndices.get(rec.pos);
        if (list) {
          list.push(i);
        } else {
          this.posToIndices.set(rec.pos, [i]);
        }
      }

      // Depth is recorded at instruction entry, so a `return` belongs to the
      // frame it leaves: record current depth, then apply the transition.
      this.depthAt[i] = depth;
      const op = opcode(rec);
      if (CALL_OPCODES.has(op)) {
        depth++;
      } else if (RETURN_OPCODES.has(op) && depth > 0) {
        depth--;
      }
    }
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

  atStart(): boolean {
    return this._cursor <= 0;
  }

  atEnd(): boolean {
    return this._cursor >= this.records.length - 1;
  }

  /** Move the cursor to `index`, clamped to range. Returns the new cursor. */
  seek(index: number): number {
    this._cursor = clamp(index, 0, Math.max(0, this.records.length - 1));
    return this._cursor;
  }

  /** Step one instruction forward. Returns true if the cursor moved. */
  stepForward(): boolean {
    if (this.atEnd()) {
      return false;
    }
    this._cursor++;
    return true;
  }

  /** Step one instruction backward. Returns true if the cursor moved. */
  stepBack(): boolean {
    if (this.atStart()) {
      return false;
    }
    this._cursor--;
    return true;
  }

  /**
   * Step over: advance until we are back at a call depth <= the current one
   * (i.e. skip any callee entered by the instruction at the cursor). Falls back
   * to a single-instruction step when depth info doesn't move us.
   */
  stepOverForward(): boolean {
    const startDepth = this.depthAt[this._cursor];
    if (!this.stepForward()) {
      return false;
    }
    while (!this.atEnd() && this.depthAt[this._cursor] > startDepth) {
      this._cursor++;
    }
    return true;
  }

  /** Reverse step over: symmetric to stepOverForward, moving backward. */
  stepOverBack(): boolean {
    const startDepth = this.depthAt[this._cursor];
    if (!this.stepBack()) {
      return false;
    }
    while (!this.atStart() && this.depthAt[this._cursor] > startDepth) {
      this._cursor--;
    }
    return true;
  }

  /** Step out: advance until call depth drops below the current frame. */
  stepOutForward(): boolean {
    const startDepth = this.depthAt[this._cursor];
    if (!this.stepForward()) {
      return false;
    }
    while (!this.atEnd() && this.depthAt[this._cursor] >= startDepth) {
      this._cursor++;
    }
    return true;
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
