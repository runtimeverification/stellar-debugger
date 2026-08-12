/**
 * In-memory model of a komet-node execution trace, plus the cursor that powers
 * time-travel replay. The debug adapter owns one TraceModel per session and
 * translates every DAP stepping request into a cursor move on this model;
 * which indices are legal stop points is decided by the run/visible/depth
 * computation in stops.ts, not here.
 *
 * The model also owns the two whole-trace state reconstructions — the folded
 * linear memory (`memory`) and the Stellar ledger (`ledger`). Both are pure
 * functions of the same records, and both cost a full scan to build, so they
 * are built lazily on first use and cached here: every consumer (the DAP
 * session, the CLI projection, the artifact builder) reads one instance per
 * trace instead of each constructing its own.
 *
 * Pure module (no `vscode` / DAP imports) so the replay logic is unit-testable.
 */

import { TraceRecord } from '../komet/trace';
import { MemoryImage } from './MemoryImage';
import { LedgerImage } from './LedgerImage';
import { renderScVal } from '../soroban/scvalJson';

export class TraceModel {
  readonly records: TraceRecord[];
  private _cursor = 0;
  private _memory?: MemoryImage;
  private _ledger?: LedgerImage;

  constructor(records: TraceRecord[]) {
    this.records = records;
  }

  /** The folded linear-memory view over these records (built once, cached). */
  get memory(): MemoryImage {
    return (this._memory ??= new MemoryImage(this.records));
  }

  /** The Stellar ledger reconstruction over these records (built once, cached). */
  get ledger(): LedgerImage {
    return (this._ledger ??= new LedgerImage(this.records));
  }

  /**
   * The traced invocation's outcome, rendered for display, or undefined for a
   * trace that carries no call boundaries at all. The root call closes last, so
   * the final `endWasm` record is the invocation's own result; a call that
   * trapped says so rather than reporting a value it never returned.
   */
  get returnValue(): string | undefined {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const event = this.records[i].event;
      if (event?.kind !== 'endWasm') {
        continue;
      }
      const value = event.result === null ? 'void' : renderScVal(event.result).display;
      return event.success ? value : `trapped (${value})`;
    }
    return undefined;
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
