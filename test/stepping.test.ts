/**
 * Systematic unit suite for the stepping spec (docs/stepping.md) at the pure
 * model level: the visible/depth/run computations that every stepping decision
 * derives from, plus the function-body ranges Disassembly must expose to power
 * them. test/dapStepping.test.ts pins the same rules end-to-end over the DAP
 * adapter; this file pins them at the lowest level that exhibits them.
 *
 * Pinned M8 API (implementation to be written against these tests):
 *
 *   src/debugAdapter/stops.ts (pure, vscode-free):
 *     computeDepths(records, positions, functionRanges?): number[]
 *       Call depth per record (spec "Model/depth"). With function-body ranges:
 *       depth follows the function membership of consecutive VISIBLE records —
 *       entering a different function's body right after a call-class record
 *       pushes a frame; a transition back to the caller pops it, whether or
 *       not a `return` record was emitted (komet-node emits none for implicit
 *       returns — defect I1). Without ranges (undefined or empty — wasm-less
 *       replay), the opcode-based call/return reconstruction is the fallback.
 *     computeRunStarts(positions, depths, lineKey): number[]
 *       Sorted indices of the line-run starts (spec "Model/run") — the
 *       statement-granularity stop points. A mapped record starts a new run
 *       iff its key differs, its depth differs, or it RE-EXECUTES an offset
 *       the current run already covered (defect I8); new offsets under the
 *       same key extend the run; invisible records, unmapped visible records,
 *       and whole deeper frames are glue inside the enclosing run.
 *
 *   src/wasm/Disassembly.ts:
 *     Disassembly.functionRanges: readonly { start; end }[]
 *       Function bodies in code-offset space ({start} inclusive, {end}
 *       exclusive), sorted and disjoint, from wasmparser's
 *       functionBodyOffsets; empty for trace-derived disassemblies.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { computeDepths, computeRunStarts } from '../src/debugAdapter/stops';
import { Disassembly } from '../src/wasm/Disassembly';
import { TraceModel } from '../src/debugAdapter/TraceModel';
import { buildDebugArtifacts } from '../src/debugAdapter/artifacts';
import { SourceMapper } from '../src/sourcemap/SourceMapper';
import { parseTraceJsonl, TraceRecord } from '../src/komet/trace';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');

interface Fixture {
  model: TraceModel;
  source: SourceMapper;
  disassembly: Disassembly;
  positions: (number | null)[];
}

const fixtureCache = new Map<string, Fixture>();

/** Load a committed wasm+trace fixture pair and build the debug artifacts. */
function fixture(name: string): Fixture {
  let f = fixtureCache.get(name);
  if (!f) {
    const jsonl = fs.readFileSync(path.join(FIXTURES, `${name}.trace.jsonl`), 'utf8');
    const wasm = fs.readFileSync(path.join(FIXTURES, `${name}.wasm`));
    const model = new TraceModel(parseTraceJsonl(jsonl));
    const { source, disassembly, positions } = buildDebugArtifacts(wasm, model, () => {});
    f = { model, source, disassembly, positions };
    fixtureCache.set(name, f);
  }
  return f;
}

/** Synthetic records: op names only (pos irrelevant — positions are passed separately). */
function recs(...ops: string[]): TraceRecord[] {
  return ops.map((op): TraceRecord => ({ pos: null, instr: [op], stack: [], locals: {} }));
}

/** Synthetic line-key function backed by a fixed array (null = unmapped). */
function keysOf(...keys: (string | null)[]): (index: number) => string | null {
  return (index) => keys[index] ?? null;
}

/** n zeros — flat depth for run tests that do not involve calls. */
function flat(n: number): number[] {
  return new Array<number>(n).fill(0);
}

describe('stops: computeDepths (spec Model/depth)', () => {
  // Two synthetic function bodies in code-offset space.
  const CALLEE = { start: 0, end: 50 };
  const CALLER = { start: 100, end: 200 };
  const RANGES = [CALLEE, CALLER];

  describe('with function-body ranges', () => {
    it('I1: pops the frame on an IMPLICIT return (no return record)', () => {
      // caller -> call -> callee body (falls off its end) -> caller again.
      const records = recs('nop', 'call', 'nop', 'nop', 'nop', 'nop');
      const positions = [100, 110, 0, 10, 120, 130];
      assert.deepStrictEqual(computeDepths(records, positions, RANGES), [0, 0, 1, 1, 0, 0]);
    });

    it('pops the frame on an explicit return record too', () => {
      const records = recs('nop', 'call', 'nop', 'return', 'nop');
      const positions = [100, 110, 0, 10, 120];
      assert.deepStrictEqual(computeDepths(records, positions, RANGES), [0, 0, 1, 1, 0]);
    });

    it('I1: nested implicit returns pop one frame per transition', () => {
      const A = { start: 100, end: 200 };
      const B = { start: 50, end: 80 };
      const C = { start: 0, end: 20 };
      const records = recs('nop', 'call', 'nop', 'call', 'nop', 'nop', 'nop', 'nop');
      const positions = [100, 110, 50, 55, 0, 10, 60, 120];
      assert.deepStrictEqual(
        computeDepths(records, positions, [C, B, A]),
        [0, 0, 1, 1, 2, 2, 1, 0],
      );
    });

    it('I1: an implicit return whose callee ended on a call is still a return', () => {
      // A -> call -> B; B's LAST visible instruction is itself a call (e.g. a
      // tail host import, whose records are invisible), then B implicitly
      // returns to A. The transition back to A must POP, not be mistaken for a
      // fresh entry just because the previous visible record was a call.
      const A = { start: 100, end: 200 };
      const B = { start: 50, end: 80 };
      const records = recs('nop', 'call', 'nop', 'call', 'nop', 'nop');
      const positions = [100, 110, 50, 60, null, 120];
      assert.deepStrictEqual(computeDepths(records, positions, [B, A]), [0, 0, 1, 1, 1, 0]);
    });

    it('I1: one visible transition pops MULTIPLE frames (matching-call semantics)', () => {
      // A -> call -> B -> call -> C; C and B both implicitly return straight to
      // A in a single visible transition. Landing back in A must unwind to A's
      // frame (pop two), not pop exactly one frame per transition.
      const A = { start: 100, end: 200 };
      const B = { start: 50, end: 100 };
      const C = { start: 0, end: 50 };
      const records = recs('nop', 'call', 'nop', 'call', 'nop', 'nop', 'nop');
      const positions = [100, 110, 50, 60, 0, 10, 120];
      assert.deepStrictEqual(
        computeDepths(records, positions, [C, B, A]),
        [0, 0, 1, 1, 2, 2, 0],
      );
    });

    it('landing on a body start without a preceding call is NOT an entry', () => {
      // A body's first instruction is only reachable from outside via a call.
      // A transition that lands there WITHOUT a preceding call-class record is
      // therefore not an entry (it cannot happen for real wasm, but the guard
      // must hold): it replaces/unwinds rather than pushing a phantom frame.
      const A = { start: 100, end: 200 };
      const B = { start: 50, end: 80 };
      const records = recs('nop', 'nop');
      const positions = [100, 50];
      assert.deepStrictEqual(computeDepths(records, positions, [B, A]), [0, 0]);
    });

    it('invisible records carry the depth of the surrounding visible context', () => {
      const records = recs('nop', 'nop', 'call', 'nop', 'nop', 'nop', 'nop');
      const positions = [null, 100, 110, 0, null, 10, 120];
      assert.deepStrictEqual(computeDepths(records, positions, RANGES), [0, 0, 0, 1, 1, 1, 0]);
    });

    it('a call that never enters another traced body (host call) pushes nothing', () => {
      const records = recs('nop', 'call', 'nop');
      const positions = [100, 110, 112];
      assert.deepStrictEqual(computeDepths(records, positions, RANGES), [0, 0, 0]);
    });

    it('a backward jump inside one function is not a call', () => {
      const records = recs('nop', 'nop', 'nop', 'nop', 'nop');
      const positions = [100, 110, 120, 110, 120];
      assert.deepStrictEqual(computeDepths(records, positions, RANGES), [0, 0, 0, 0, 0]);
    });
  });

  describe('fallback without ranges (wasm-less replay)', () => {
    it('reconstructs depth from call/return opcodes', () => {
      const records = recs('nop', 'call', 'nop', 'return', 'nop');
      const positions = [1, 2, 3, 4, 5];
      assert.deepStrictEqual(computeDepths(records, positions), [0, 0, 1, 1, 0]);
    });

    it('treats an EMPTY range list like an absent one', () => {
      const records = recs('nop', 'call', 'nop', 'return', 'nop');
      const positions = [1, 2, 3, 4, 5];
      assert.deepStrictEqual(computeDepths(records, positions, []), [0, 0, 1, 1, 0]);
    });

    it('a return at depth 0 does not go negative', () => {
      const records = recs('return', 'nop');
      assert.deepStrictEqual(computeDepths(records, [1, 2]), [0, 0]);
    });
  });

  describe('fixtures', () => {
    it('I1: stepper — depth 1 exactly for the three executions of triple, ending at 0', () => {
      const f = fixture('stepper-debug');
      const depths = computeDepths(f.model.records, f.positions, f.disassembly.functionRanges);
      const d1 = new Set<number>();
      for (const [from, to] of [
        [29, 31],
        [46, 48],
        [63, 65],
      ]) {
        for (let i = from; i <= to; i++) {
          d1.add(i);
        }
      }
      const expected = f.model.records.map((_, i) => (d1.has(i) ? 1 : 0));
      assert.deepStrictEqual(depths, expected);
      // The regression that motivated I1: the opcode fallback only ever climbs
      // (comet emits no record for triple's implicit returns) and ends at 3.
      assert.strictEqual(depths[depths.length - 1], 0);
    });

    it('adder — a call-free trace is flat at depth 0', () => {
      const f = fixture('adder-debug');
      assert.deepStrictEqual(
        computeDepths(f.model.records, f.positions, f.disassembly.functionRanges),
        flat(f.model.length),
      );
    });
  });
});

describe('stops: computeRunStarts (spec Model/run)', () => {
  it('a key change starts a new run', () => {
    const starts = computeRunStarts([1, 2, 3], flat(3), keysOf('A', 'A', 'B'));
    assert.deepStrictEqual(starts, [0, 2]);
  });

  it('unmapped VISIBLE records are glue inside a run', () => {
    const starts = computeRunStarts([1, 2, 3, 5], flat(4), keysOf('A', null, 'A', 'B'));
    assert.deepStrictEqual(starts, [0, 3]);
  });

  it('INVISIBLE records are glue inside a run', () => {
    const starts = computeRunStarts([1, null, 3, 5], flat(4), keysOf('A', null, 'A', 'B'));
    assert.deepStrictEqual(starts, [0, 3]);
  });

  it('new offsets extend a run: one line spans disjoint address ranges', () => {
    // The stepper fixture's run [39..43]: the loop's back-edge `br` and the
    // next condition test are both the `while` line — ONE stop per iteration.
    const starts = computeRunStarts(
      [0x49, 0x2e, 0x30, 0x32, 0x33],
      flat(5),
      keysOf('L25', 'L25', 'L25', 'L25', 'L25'),
    );
    assert.deepStrictEqual(starts, [0]);
  });

  it('I8/S6: a re-executed offset splits a run even across unmapped records', () => {
    // Two loop iterations separated only by an unmapped (but visible) record:
    // offsets 46/48 run again, so the second iteration is a NEW run.
    const starts = computeRunStarts(
      [46, 48, 999, 46, 48],
      flat(5),
      keysOf('L', 'L', null, 'L', 'L'),
    );
    assert.deepStrictEqual(starts, [0, 3]);
  });

  it('I8: an immediately re-executed offset splits a run', () => {
    const starts = computeRunStarts([10, 12, 10, 12], flat(4), keysOf('L', 'L', 'L', 'L'));
    assert.deepStrictEqual(starts, [0, 2]);
  });

  it('a depth change starts a new run (the callee first line is a stop)', () => {
    const starts = computeRunStarts([10, 12, 3], [0, 0, 1], keysOf('A', 'A', 'B'));
    assert.deepStrictEqual(starts, [0, 2]);
  });

  it('the same key at a different depth is a new run', () => {
    const starts = computeRunStarts([10, 3], [0, 1], keysOf('A', 'A'));
    assert.deepStrictEqual(starts, [0, 1]);
  });

  it('S5: a whole deeper frame is glue — the caller line does not restart after the call', () => {
    // Line A calls into line B and continues at a NEW offset afterwards: one
    // run of A (else `next` would stop on the same source line twice).
    const starts = computeRunStarts(
      [10, 12, 3, 5, 20],
      [0, 0, 1, 1, 0],
      keysOf('A', 'A', 'B', 'B', 'A'),
    );
    assert.deepStrictEqual(starts, [0, 2]);
  });

  it('S12/S6: returning to a shallower frame ABANDONS the deeper run', () => {
    // Two calls into a callee line that executes only FRESH offsets the second
    // time (e.g. a different branch): the intervening depth-0 record must kill
    // the depth-1 run, else a breakpoint on that line hits once for two calls.
    const starts = computeRunStarts([10, 3, 12, 5], [0, 1, 0, 1], keysOf('A', 'B', 'A', 'B'));
    assert.deepStrictEqual(starts, [0, 1, 3]);
  });

  it('after the callee returns, re-executing a covered offset starts a new run', () => {
    const starts = computeRunStarts(
      [10, 12, 3, 10],
      [0, 0, 1, 0],
      keysOf('A', 'A', 'B', 'A'),
    );
    assert.deepStrictEqual(starts, [0, 2, 3]);
  });

  it('S1: leading invisible and unmapped records precede the first run', () => {
    const starts = computeRunStarts([null, 7, 9, 11], flat(4), keysOf(null, null, 'A', 'A'));
    assert.deepStrictEqual(starts, [2]);
  });

  it('no mapped records, no runs', () => {
    assert.deepStrictEqual(computeRunStarts([1, 2], flat(2), keysOf(null, null)), []);
  });

  describe('fixtures', () => {
    /** Depths + run starts for a fixture, chained through the pinned API. */
    function runStartsOf(f: Fixture): number[] {
      const depths = computeDepths(f.model.records, f.positions, f.disassembly.functionRanges);
      return computeRunStarts(f.positions, depths, (i) => f.source.lineKeyForIndex(i));
    }

    it('stepper — exactly the ground-truth run starts', () => {
      const f = fixture('stepper-debug');
      assert.deepStrictEqual(runStartsOf(f), [5, 21, 27, 29, 39, 44, 46, 56, 61, 63, 73, 84]);
    });

    it('S6/I8: stepper line 25 has four runs — loop entry plus one per re-test', () => {
      const f = fixture('stepper-debug');
      const line25 = runStartsOf(f).filter((i) => f.source.lineKeyForIndex(i)?.endsWith('lib.rs:25'));
      assert.deepStrictEqual(line25, [21, 39, 56, 73]);
    });

    it('S12: stepper line 15 has one run per triple call', () => {
      const f = fixture('stepper-debug');
      const line15 = runStartsOf(f).filter((i) => f.source.lineKeyForIndex(i)?.endsWith('lib.rs:15'));
      assert.deepStrictEqual(line15, [29, 46, 63]);
    });

    it('I4: adder line 16 is ONE run despite five mapped records', () => {
      const f = fixture('adder-debug');
      const starts = runStartsOf(f);
      assert.deepStrictEqual(starts, [6, 29, 40]);
      const line16 = starts.filter((i) => f.source.lineKeyForIndex(i)?.endsWith('lib.rs:16'));
      assert.deepStrictEqual(line16, [29]);
    });

    it('visibility ground truth: exactly the head records are invisible', () => {
      const invisible = (f: Fixture) =>
        f.positions.map((p, i) => (p === null ? i : -1)).filter((i) => i >= 0);
      assert.deepStrictEqual(invisible(fixture('adder-debug')), [0, 1, 2, 3, 4, 5]);
      assert.deepStrictEqual(invisible(fixture('stepper-debug')), [0, 1, 2, 3, 4]);
    });
  });
});

describe('Disassembly.functionRanges', () => {
  function contains(range: { start: number; end: number }, addr: number): boolean {
    return addr >= range.start && addr < range.end;
  }

  it('stepper wasm: sorted disjoint bodies in code-offset space', () => {
    const ranges = fixture('stepper-debug').disassembly.functionRanges;
    assert.strictEqual(ranges.length, 3);
    for (const range of ranges) {
      assert.ok(range.end > range.start, `empty range ${range.start}..${range.end}`);
    }
    for (let i = 1; i < ranges.length; i++) {
      assert.ok(ranges[i].start >= ranges[i - 1].end, `ranges overlap or are unsorted at ${i}`);
    }
    // triple's body starts at 0x3 and holds its three executed instructions.
    assert.strictEqual(ranges[0].start, 0x3);
    for (const addr of [0x3, 0x5, 0x7]) {
      assert.ok(contains(ranges[0], addr), `0x${addr.toString(16)} not in triple's body`);
    }
    // sum_triples starts at 0xd and holds the epilogue `return` at 0x56.
    assert.strictEqual(ranges[1].start, 0xd);
    assert.ok(contains(ranges[1], 0x56));
    assert.ok(!contains(ranges[0], 0xd));
  });

  it('adder wasm: every validated trace position falls inside exactly one body', () => {
    const f = fixture('adder-debug');
    const ranges = f.disassembly.functionRanges;
    assert.ok(ranges.length > 0, 'expected function-body ranges from a real wasm');
    for (const pos of f.positions) {
      if (pos === null) {
        continue;
      }
      const hits = ranges.filter((r) => contains(r, pos)).length;
      assert.strictEqual(hits, 1, `position 0x${pos.toString(16)} is in ${hits} bodies`);
    }
  });

  it('a trace-derived disassembly exposes no function ranges (wasm-less fallback)', () => {
    const derived = Disassembly.fromTrace(fixture('adder-debug').model);
    assert.deepStrictEqual([...derived.functionRanges], []);
  });
});
