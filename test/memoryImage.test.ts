import * as assert from 'assert';
import { TraceRecord, MemRun } from '../src/komet/trace';
import { MemoryImage } from '../src/debugAdapter/MemoryImage';

// A minimal TraceRecord carrying only the mem snapshot we care about; the other
// fields are placeholders. `mem` undefined means "no snapshot at this record".
function rec(mem?: MemRun[]): TraceRecord {
  return { pos: null, instr: ['nop'], stack: [], locals: {}, mem };
}

// One snapshot run: a byte range starting at `addr`.
function run(addr: number, bytes: number[]): MemRun {
  return { addr, bytes: Uint8Array.from(bytes) };
}

describe('MemoryImage (snapshot-latest)', () => {
  it('uses the latest snapshot at or before the cursor; snapshots are whole memory', () => {
    // index 0: full snapshot [1,2,3,4] @0
    // index 1: no snapshot (null / unchanged)
    // index 2: no snapshot
    // index 3: full snapshot [9,9] @2 — this is the WHOLE memory, so bytes 0..1
    //          are back to 0; the index-0 snapshot is NOT merged in.
    const records: TraceRecord[] = [
      rec([run(0, [1, 2, 3, 4])]),
      rec(),
      rec(),
      rec([run(2, [9, 9])]),
    ];
    const img = new MemoryImage(records);

    // At cursor 0 the snapshot at 0 applies.
    assert.deepStrictEqual(Array.from(img.readMemory(0, 0, 4)!), [1, 2, 3, 4]);
    // At cursor 1 there is no newer snapshot, so snapshot 0 is reused verbatim.
    assert.deepStrictEqual(Array.from(img.readMemory(1, 0, 4)!), [1, 2, 3, 4]);
    // At cursor 3 the snapshot at 3 is the whole memory: [0,0,9,9], NOT merged
    // with the earlier snapshot.
    assert.deepStrictEqual(Array.from(img.readMemory(3, 0, 4)!), [0, 0, 9, 9]);
  });

  it('returns all zeros when no snapshot exists at or before the cursor', () => {
    // index 0 has no snapshot; the first snapshot is at index 1. Reading at
    // cursor 0 (lastSnapshotAt == -1) yields zero-filled memory.
    const records: TraceRecord[] = [rec(), rec([run(0, [1, 2, 3, 4])])];
    const img = new MemoryImage(records);
    assert.deepStrictEqual(Array.from(img.readMemory(0, 0, 4)!), [0, 0, 0, 0]);
    // And once a snapshot is in scope, it applies.
    assert.deepStrictEqual(Array.from(img.readMemory(1, 0, 4)!), [1, 2, 3, 4]);
  });

  it('zero-fills gaps between and around runs within a snapshot', () => {
    // A snapshot with two disjoint runs: [1,2] @0 and [7] @8. Everything not
    // covered by a run reads as 0.
    const img = new MemoryImage([rec([run(0, [1, 2]), run(8, [7])])]);
    assert.deepStrictEqual(
      Array.from(img.readMemory(0, 0, 10)!),
      [1, 2, 0, 0, 0, 0, 0, 0, 7, 0],
    );
  });

  it('zero-fills a read that starts entirely inside a gap', () => {
    const img = new MemoryImage([rec([run(0, [1, 2]), run(8, [7])])]);
    // addresses 3..5 are not covered by any run.
    assert.deepStrictEqual(Array.from(img.readMemory(0, 3, 3)!), [0, 0, 0]);
  });

  it('copies only the overlap when a read spans a run partially', () => {
    // Run [5,6,7,8] @4. Read [addr 2, size 4) covers addrs 2,3,4,5: only 4,5
    // intersect the run (its first two bytes 5,6), the rest zero-fill.
    const img = new MemoryImage([rec([run(4, [5, 6, 7, 8])])]);
    assert.deepStrictEqual(Array.from(img.readMemory(0, 2, 4)!), [0, 0, 5, 6]);
    // Read [addr 6, size 4) covers addrs 6,7,8,9: only 6,7 intersect the run
    // (its last two bytes 7,8), the tail zero-fills.
    assert.deepStrictEqual(Array.from(img.readMemory(0, 6, 4)!), [7, 8, 0, 0]);
  });

  it('returns a fresh Uint8Array of exactly the requested length', () => {
    const img = new MemoryImage([rec([run(0, [1, 2, 3, 4])])]);
    const a = img.readMemory(0, 0, 4)!;
    const b = img.readMemory(0, 0, 4)!;
    assert.strictEqual(a.length, 4);
    assert.notStrictEqual(a, b, 'each read must return a fresh array');
    a[0] = 99;
    // Mutating a returned array must not corrupt the backing snapshot.
    assert.deepStrictEqual(Array.from(img.readMemory(0, 0, 4)!), [1, 2, 3, 4]);
  });

  it('selects the correct earlier snapshot on a backward cursor move', () => {
    // Distinct snapshots at indices 0, 2 and 4; indices 1 and 3 unchanged.
    const records: TraceRecord[] = [
      rec([run(0, [10])]),
      rec(),
      rec([run(0, [20])]),
      rec(),
      rec([run(0, [30])]),
    ];
    const img = new MemoryImage(records);

    // Forward to the last snapshot, then move backward.
    assert.deepStrictEqual(Array.from(img.readMemory(4, 0, 1)!), [30]);
    assert.deepStrictEqual(Array.from(img.readMemory(3, 0, 1)!), [20]); // reuses snapshot @2
    assert.deepStrictEqual(Array.from(img.readMemory(2, 0, 1)!), [20]);
    assert.deepStrictEqual(Array.from(img.readMemory(1, 0, 1)!), [10]); // reuses snapshot @0
    assert.deepStrictEqual(Array.from(img.readMemory(0, 0, 1)!), [10]);
  });

  it('clamps an out-of-range cursor into the trace', () => {
    const records: TraceRecord[] = [rec([run(0, [1, 2, 3, 4])]), rec([run(0, [5, 6, 7, 8])])];
    const img = new MemoryImage(records);
    // Cursor beyond the end clamps to the last record's snapshot.
    assert.deepStrictEqual(Array.from(img.readMemory(99, 0, 4)!), [5, 6, 7, 8]);
  });

  it('returns undefined for size <= 0 or addr < 0', () => {
    const img = new MemoryImage([rec([run(0, [1, 2, 3, 4])])]);
    assert.strictEqual(img.readMemory(0, 0, 0), undefined);
    assert.strictEqual(img.readMemory(0, 0, -1), undefined);
    assert.strictEqual(img.readMemory(0, -1, 4), undefined);
  });
});
