/**
 * Unit suite for the stepping engine (src/debugAdapter/replayCursor.ts) — the
 * traversal half of the stepping spec (docs/stepping.md): the depth ceilings,
 * the statement/instruction stop sets, the clamps (S2/S3/S14) and the
 * end-of-trace termination (S20). test/dapStepping.test.ts pins the same rules
 * end-to-end over the DAP adapter; this file pins them at the level where they
 * are decided, over hand-built stop models rather than real traces.
 */

import * as assert from 'assert';
import { TraceModel } from '../src/debugAdapter/TraceModel';
import { StopModel } from '../src/debugAdapter/stopModel';
import { ReplayCursor, resolveBreakpoints } from '../src/debugAdapter/replayCursor';
import { TraceRecord } from '../src/komet/trace';
import { MappedLocation, ResolvedBreakpoint, SourceMapper } from '../src/sourcemap/SourceMapper';

/** `n` minimal instruction records — the cursor only ever reads their count. */
function records(n: number): TraceRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    pos: i,
    instr: ['nop'] as [string, ...unknown[]],
    stack: [],
    locals: {},
  }));
}

/**
 * A stop model over `depths` (one entry per record) with the given stop sets.
 * `runStarts` doubles as `rawRunStarts` unless stated separately.
 */
function stopModel(opts: {
  depths: number[];
  visibleIndices: number[];
  runStarts: number[];
  rawRunStarts?: number[];
  validatedPosToIndices?: Map<number, number[]>;
}): StopModel {
  const { depths, visibleIndices, runStarts } = opts;
  return {
    validatedPosToIndices: opts.validatedPosToIndices ?? new Map(),
    visibleIndices,
    depths,
    rawRunStarts: opts.rawRunStarts ?? runStarts,
    runStarts,
    firstStopPoint: runStarts[0] ?? visibleIndices[0] ?? 0,
    lastStopPoint:
      runStarts[runStarts.length - 1] ??
      visibleIndices[visibleIndices.length - 1] ??
      Math.max(0, depths.length - 1),
  };
}

/**
 * A three-frame shape: statement stops at 1 (depth 0), 3 (depth 1), 5 (depth 0),
 * with every record visible so instruction granularity has finer stops.
 */
function nestedFixture(): { model: TraceModel; cursor: ReplayCursor } {
  const model = new TraceModel(records(7));
  const stops = stopModel({
    depths: [0, 0, 1, 1, 1, 0, 0],
    visibleIndices: [0, 1, 2, 3, 4, 5, 6],
    runStarts: [1, 3, 5],
  });
  return { model, cursor: new ReplayCursor(model, stops) };
}

describe('ReplayCursor', () => {
  describe('entry (S1)', () => {
    it('lands on the first statement stop, not on the head of the trace', () => {
      const { model, cursor } = nestedFixture();
      cursor.toEntry();
      assert.strictEqual(model.cursor, 1);
    });

    it('falls back to the first visible record when nothing maps to source', () => {
      const model = new TraceModel(records(5));
      const cursor = new ReplayCursor(
        model,
        stopModel({ depths: [0, 0, 0, 0, 0], visibleIndices: [2, 3], runStarts: [] }),
      );
      cursor.toEntry();
      assert.strictEqual(model.cursor, 2);
    });
  });

  describe('forward stepping', () => {
    it('step-in takes the next statement stop regardless of depth (S4)', () => {
      const { model, cursor } = nestedFixture();
      cursor.toEntry();
      assert.strictEqual(cursor.stepForward('statement', Infinity), 'stopped');
      assert.strictEqual(model.cursor, 3);
    });

    it('step-over skips a deeper frame (S5)', () => {
      const { model, cursor } = nestedFixture();
      cursor.toEntry();
      assert.strictEqual(cursor.stepForward('statement', cursor.depth), 'stopped');
      assert.strictEqual(model.cursor, 5, 'the depth-1 stop at 3 must be stepped over');
    });

    it('step-out leaves the current frame (S7)', () => {
      const { model, cursor } = nestedFixture();
      model.seek(3);
      assert.strictEqual(cursor.depth, 1);
      assert.strictEqual(cursor.stepForward('statement', cursor.depth - 1), 'stopped');
      assert.strictEqual(model.cursor, 5);
    });

    it('instruction granularity steps one visible record at a time', () => {
      const { model, cursor } = nestedFixture();
      cursor.toEntry();
      cursor.stepForward('instruction', Infinity);
      assert.strictEqual(model.cursor, 2);
    });

    it('terminates a statement step past the last statement (S20)', () => {
      const { model, cursor } = nestedFixture();
      model.seek(5);
      assert.strictEqual(cursor.stepForward('statement', Infinity), 'terminated');
      assert.strictEqual(model.cursor, 5, 'a terminating step must not move the cursor');
    });

    it('clamps an instruction step at the end instead of terminating (S2)', () => {
      const { model, cursor } = nestedFixture();
      model.seek(6);
      assert.strictEqual(cursor.stepForward('instruction', Infinity), 'stopped');
      assert.strictEqual(model.cursor, 6);
    });

    it('clamps rather than terminates when no record maps to source', () => {
      const model = new TraceModel(records(4));
      const cursor = new ReplayCursor(
        model,
        stopModel({ depths: [0, 0, 0, 0], visibleIndices: [1, 2], runStarts: [] }),
      );
      model.seek(2);
      assert.strictEqual(cursor.stepForward('statement', Infinity), 'stopped');
      assert.strictEqual(model.cursor, 2);
    });
  });

  describe('reverse stepping', () => {
    it('takes the previous stop point not in a deeper frame (S8)', () => {
      const { model, cursor } = nestedFixture();
      model.seek(5);
      cursor.stepBackward('statement', cursor.depth);
      assert.strictEqual(model.cursor, 1, 'the depth-1 stop at 3 must be stepped back over');
    });

    it('clamps to the first stop point and never terminates (S3)', () => {
      const { model, cursor } = nestedFixture();
      cursor.toEntry();
      cursor.stepBackward('statement', Infinity);
      assert.strictEqual(model.cursor, 1);
    });

    it('leaves the cursor alone when there are no stop points at all', () => {
      const model = new TraceModel(records(3));
      const cursor = new ReplayCursor(
        model,
        stopModel({ depths: [0, 0, 0], visibleIndices: [], runStarts: [] }),
      );
      model.seek(2);
      cursor.stepBackward('statement', Infinity);
      assert.strictEqual(model.cursor, 2);
    });
  });

  describe('running to a breakpoint', () => {
    it('stops on the next breakpoint index going forward', () => {
      const { model, cursor } = nestedFixture();
      cursor.toEntry();
      assert.strictEqual(cursor.runForward(new Set([4])), 'breakpoint');
      assert.strictEqual(model.cursor, 4);
    });

    it('settles on the last stop point when no breakpoint lies ahead (S14)', () => {
      const { model, cursor } = nestedFixture();
      cursor.toEntry();
      assert.strictEqual(cursor.runForward(new Set()), 'clamped');
      assert.strictEqual(model.cursor, 5);
    });

    it('stops on the previous breakpoint index going backward', () => {
      const { model, cursor } = nestedFixture();
      model.seek(6);
      assert.strictEqual(cursor.runBackward(new Set([2])), 'breakpoint');
      assert.strictEqual(model.cursor, 2);
    });

    it('settles on the first stop point when no breakpoint lies behind (S14)', () => {
      const { model, cursor } = nestedFixture();
      model.seek(6);
      assert.strictEqual(cursor.runBackward(new Set()), 'clamped');
      assert.strictEqual(model.cursor, 1);
    });
  });
});

describe('resolveBreakpoints', () => {
  /** A mapper resolving every request to the fixed index list. */
  function mapperResolving(indices: number[]): SourceMapper {
    return {
      hasLineInfo: () => true,
      locationForIndex: (): MappedLocation | null => null,
      locationForAddress: (): MappedLocation | null => null,
      resolveBreakpoint: (): ResolvedBreakpoint | null => ({ line: 1, indices }),
      executedLines: () => [],
      lineKeyForIndex: () => null,
      sourceTextForIndex: () => null,
    };
  }

  const stops = stopModel({
    depths: [0, 0, 0, 0, 0],
    visibleIndices: [0, 1, 2, 3, 4],
    // The statement stops are filtered (S17/S18) down from the raw run starts,
    // which is what breakpoints must still be narrowed against (S12/S13).
    runStarts: [3],
    rawRunStarts: [1, 3],
    validatedPosToIndices: new Map([[0x2a, [2, 4]]]),
  });

  it('narrows a source breakpoint to the RAW run starts, one index per run', () => {
    const resolved = resolveBreakpoints(
      stops,
      mapperResolving([0, 1, 2, 3]),
      new Map([['/a.rs', [{ line: 7 }]]]),
      [],
    );
    assert.deepStrictEqual([...resolved].sort((a, b) => a - b), [1, 3]);
  });

  it('takes every record at an instruction breakpoint address (S15)', () => {
    const resolved = resolveBreakpoints(stops, undefined, new Map(), [0x2a]);
    assert.deepStrictEqual([...resolved].sort((a, b) => a - b), [2, 4]);
  });

  it('ignores an instruction address that no record validated to', () => {
    assert.strictEqual(resolveBreakpoints(stops, undefined, new Map(), [0x99]).size, 0);
  });

  it('resolves nothing without a source mapper', () => {
    const resolved = resolveBreakpoints(stops, undefined, new Map([['/a.rs', [{ line: 7 }]]]), []);
    assert.strictEqual(resolved.size, 0);
  });
});
