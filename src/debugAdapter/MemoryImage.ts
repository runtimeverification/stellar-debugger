/**
 * Reconstructs WASM linear memory at a replay cursor from the FULL sparse
 * snapshots carried by a trace (see src/komet/trace.ts). Each record's `mem`
 * (when present) is the whole module memory at that step; a record with no
 * snapshot (`undefined`) leaves the memory unchanged since the previous one.
 * So the memory at a cursor is simply the latest snapshot at an index <=
 * cursor — no folding across records. Any byte not covered by a run reads as 0
 * (wasm memory is zero-initialized), including before the first snapshot.
 *
 * The index of that latest snapshot is precomputed once per record, so a read
 * (forward or backward) is a direct lookup plus a copy of the overlapping runs.
 *
 * Pure module (no `vscode` / DAP imports).
 */

import { TraceRecord } from '../komet/trace';

export class MemoryImage {
  private readonly records: ReadonlyArray<TraceRecord>;
  /**
   * For each record index i, the greatest index j <= i whose record carries a
   * `mem` snapshot, or -1 when no snapshot exists at or before i.
   */
  private readonly lastSnapshotAt: number[];

  constructor(records: ReadonlyArray<TraceRecord>) {
    this.records = records;
    this.lastSnapshotAt = new Array(records.length);
    let last = -1;
    for (let i = 0; i < records.length; i++) {
      if (records[i].mem !== undefined) {
        last = i;
      }
      this.lastSnapshotAt[i] = last;
    }
  }

  /**
   * The `size` bytes at `[addr, addr+size)` as of the latest snapshot at or
   * before `cursor`. Never-covered bytes (and everything before the first
   * snapshot) read as 0. Returns a fresh `Uint8Array` of length `size`, or
   * `undefined` for `size <= 0` / `addr < 0`.
   */
  readMemory(cursor: number, addr: number, size: number): Uint8Array | undefined {
    if (size <= 0 || addr < 0) {
      return undefined;
    }
    const out = new Uint8Array(size);

    if (this.records.length === 0) {
      return out;
    }
    const clamped = Math.max(0, Math.min(cursor, this.records.length - 1));
    const j = this.lastSnapshotAt[clamped];
    if (j < 0) {
      // No snapshot at or before the cursor: memory is all zeros.
      return out;
    }

    const runs = this.records[j].mem!;
    const end = addr + size;
    for (const run of runs) {
      const runEnd = run.addr + run.bytes.length;
      const from = Math.max(addr, run.addr);
      const to = Math.min(end, runEnd);
      for (let a = from; a < to; a++) {
        out[a - addr] = run.bytes[a - run.addr];
      }
    }
    return out;
  }
}
