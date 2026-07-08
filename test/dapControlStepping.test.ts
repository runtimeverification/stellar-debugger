/**
 * Characterization suite for per-construct SOURCE stepping at the DAP level
 * (mirrors test/dapStepping.test.ts). One opt-0 wasm — control-debug.wasm from
 * examples/control/src/lib.rs — is replayed by RawTraceBackend under five
 * traces, each isolating a Rust control-flow construct. These cases drive the
 * real adapter and pin how a debugger USER steps across each construct, citing
 * the S-rules in docs/stepping.md. They are expected to PASS against the
 * current engine; they lock the behavior against regression.
 *
 * Frame/depth note: control's #[contractimpl] export shim runs at depth 0 then
 * 1 (both lib.rs:20), the function body at depth 2, a called `bump` at depth 3.
 * Because `next` (step-over) only lands on stop points at depth <= the current
 * one, descending from the depth-0 entry into the body uses `stepIn` (which
 * lands on the next run start regardless of depth); `stepIn` therefore also
 * enumerates every statement stop in trace order, one per press.
 */

import * as assert from 'assert';
import * as path from 'path';
import { DebugClient } from '@vscode/debugadapter-testsupport';
import { DebugProtocol } from '@vscode/debugprotocol';

const ADAPTER = path.join(__dirname, 'support', 'adapterEntry.js');
const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');

const CONTROL_WASM = path.join(FIXTURES, 'control-debug.wasm');
const CONTROL_LIB_SUFFIX = 'examples/control/src/lib.rs';

/** Launch args for one control construct's trace, replayed with symbols. */
function control(fn: string): { rawTrace: string; wasmPath: string; function: string } {
  return { rawTrace: path.join(FIXTURES, `control-${fn}.trace.jsonl`), wasmPath: CONTROL_WASM, function: fn };
}

const THREAD = { threadId: 1 };
const STMT = { ...THREAD, granularity: 'statement' as const };

interface Stop {
  index: number;
  line: number;
  path?: string;
}

describe('Control-flow stepping (docs/stepping.md, DAP level)', () => {
  let dc: DebugClient;

  beforeEach(async () => {
    dc = new DebugClient('node', ADAPTER, 'soroban');
    await dc.start();
  });

  afterEach(async () => {
    await dc.stop();
  });

  async function top(): Promise<Stop> {
    const res = await dc.stackTraceRequest(THREAD);
    assert.ok(res.body.stackFrames.length >= 1, 'expected at least one stack frame');
    const frame = res.body.stackFrames[0];
    const probe = /\[(\d+)\/\d+\]$/.exec(frame.name);
    assert.ok(probe, `frame name carries no trace-index probe: ${frame.name}`);
    return { index: Number(probe[1]), line: frame.line, path: frame.source?.path };
  }

  async function stopAfter(request: Promise<unknown>, reason = 'step'): Promise<Stop> {
    const [, stopped] = await Promise.all([request, dc.waitForEvent('stopped')]);
    assert.strictEqual((stopped as DebugProtocol.StoppedEvent).body.reason, reason);
    return top();
  }

  function expect(stop: Stop, expected: { index: number; line?: number; file?: string }): void {
    assert.strictEqual(stop.index, expected.index, `stopped at trace index ${stop.index}, expected ${expected.index}`);
    if (expected.line !== undefined) {
      assert.strictEqual(stop.line, expected.line, `stopped at line ${stop.line}, expected ${expected.line}`);
    }
    if (expected.file !== undefined) {
      assert.ok(stop.path?.endsWith(expected.file), `unexpected source: ${stop.path}`);
    }
  }

  async function launchAndStop(launchArgs: object): Promise<Stop> {
    const [, , stopped] = await Promise.all([
      dc.configurationSequence(),
      dc.launch(launchArgs as any),
      dc.waitForEvent('stopped'),
    ]);
    assert.strictEqual((stopped as DebugProtocol.StoppedEvent).body.reason, 'entry');
    return top();
  }

  /** stepIn `times` times, returning the last stop. */
  async function stmtStepIn(times: number): Promise<Stop> {
    let stop!: Stop;
    for (let i = 0; i < times; i++) {
      stop = await stopAfter(dc.stepInRequest(STMT));
    }
    return stop;
  }

  /**
   * Walk statement `stepIn` (the next run start regardless of depth) from the
   * entry stop until the cursor stops advancing, returning every distinct stop
   * in trace order — the DAP-visible enumeration of the statement stop points.
   */
  async function walkStepIn(launchArgs: object): Promise<Stop[]> {
    const stops: Stop[] = [await launchAndStop(launchArgs)];
    for (;;) {
      const next = await stopAfter(dc.stepInRequest(STMT));
      if (next.index === stops[stops.length - 1].index) {
        break; // S2: clamped on the last stop point.
      }
      stops.push(next);
    }
    return stops;
  }

  const asPairs = (stops: Stop[]): [number, number][] => stops.map((s) => [s.index, s.line]);

  describe('seq — straight-line sequence', () => {
    it('S1/S16: entry lands on the export shim (lib.rs:20) with source', async () => {
      const entry = await launchAndStop(control('seq'));
      expect(entry, { index: 6, line: 20, file: CONTROL_LIB_SUFFIX });
    });

    it('S4/S5: statement stops are shim, three assignments, return — strictly increasing in the body', async () => {
      const stops = await walkStepIn(control('seq'));
      assert.deepStrictEqual(asPairs(stops), [
        [6, 20],
        [21, 20],
        [219, 23],
        [236, 24],
        [249, 25],
        [262, 26],
        [265, 28],
      ]);
      // The function body's own lines strictly increase (23,24,25,26,28): a
      // pure sequence stops once per statement, never re-visiting a line.
      const bodyLines = stops.filter((s) => s.index >= 219).map((s) => s.line);
      for (let i = 1; i < bodyLines.length; i++) {
        assert.ok(bodyLines[i] > bodyLines[i - 1], `line ${bodyLines[i]} did not increase past ${bodyLines[i - 1]}`);
      }
    });
  });

  describe('branch — if/else, only the taken arm', () => {
    it('S4/S5: the else arm (:36) is a stop and the then arm (:34) NEVER appears', async () => {
      const stops = await walkStepIn(control('branch'));
      assert.deepStrictEqual(asPairs(stops), [
        [6, 20],
        [21, 20],
        [219, 31],
        [226, 33],
        [244, 36],
        [245, 33],
        [246, 38],
        [248, 39],
      ]);
      const lines = stops.map((s) => s.line);
      assert.ok(lines.includes(36), 'expected the taken else arm (:36) to be a stop');
      assert.ok(!lines.includes(34), 'the un-taken then arm (:34) must never be a stop');
    });
  });

  describe('count — `for` loop, body once per iteration (S6/S12)', () => {
    it('S6: the loop body line :44 is a fresh statement stop each iteration (>=3 times)', async () => {
      const stops = await walkStepIn(control('count'));
      assert.deepStrictEqual(asPairs(stops), [
        [6, 20],
        [21, 20],
        [219, 42],
        [228, 43],
        [233, 44],
        [400, 45],
        [414, 44],
        [547, 45],
        [561, 44],
        [694, 45],
        [708, 44],
        [805, 47],
        [808, 48],
      ]);
      const body = stops.filter((s) => s.line === 44);
      assert.ok(body.length >= 3, `expected >=3 per-iteration stops on :44, got ${body.length}`);
      // Each body stop is a distinct trace index — a genuinely separate stop.
      assert.strictEqual(new Set(body.map((s) => s.index)).size, body.length);
    });
  });

  describe('while_call — `while` with a real `bump` call', () => {
    // Statement stops (index=line@depth): ... 243=56@2 249=15@3 266=16@3
    // 278=18@3 291=57@2 ... The call line :56 sits at depth 2; bump's body
    // (:15/:16/:18) at depth 3.

    it('S4/S5/S6/S8: stepIn enumerates every stop, descending into bump each iteration', async () => {
      const stops = await walkStepIn(control('while_call'));
      assert.deepStrictEqual(asPairs(stops), [
        [6, 20],
        [21, 20],
        [219, 52],
        [228, 53],
        [231, 54],
        [234, 55],
        [243, 56],
        [249, 15],
        [266, 16],
        [278, 18],
        [291, 57],
        [305, 55],
        [314, 56],
        [320, 15],
        [337, 16],
        [349, 18],
        [362, 57],
        [376, 55],
        [385, 56],
        [391, 15],
        [408, 16],
        [420, 18],
        [433, 57],
        [447, 55],
        [456, 59],
        [459, 60],
      ]);
      // bump's entry line :15 is visited exactly once per loop iteration (3x).
      assert.strictEqual(stops.filter((s) => s.line === 15).length, 3);
    });

    it('S4: stepIn at the call line :56 descends into bump body :15', async () => {
      await launchAndStop(control('while_call'));
      // stepIn six times to reach the first call line (:56, index 243).
      expect(await stmtStepIn(6), { index: 243, line: 56 });
      const stop = await stopAfter(dc.stepInRequest(STMT));
      expect(stop, { index: 249, line: 15, file: CONTROL_LIB_SUFFIX });
    });

    it('S5/I1: next at the call line :56 steps OVER bump to :57 in one press', async () => {
      await launchAndStop(control('while_call'));
      expect(await stmtStepIn(6), { index: 243, line: 56 });
      // bump's records (:15/:16/:18) are one frame deeper and its return is
      // implicit (no return record); one `next` must skip the whole call.
      const stop = await stopAfter(dc.nextRequest(STMT));
      expect(stop, { index: 291, line: 57, file: CONTROL_LIB_SUFFIX });
    });

    it('S7/S8: stepOut from inside bump returns to the caller line :57 (implicit return)', async () => {
      await launchAndStop(control('while_call'));
      expect(await stmtStepIn(6), { index: 243, line: 56 });
      expect(await stopAfter(dc.stepInRequest(STMT)), { index: 249, line: 15 });
      // Despite no `return` record, stepOut unwinds the deeper bump frame and
      // lands on the next shallower run start (:57).
      const stop = await stopAfter(dc.stepOutRequest(STMT));
      expect(stop, { index: 291, line: 57 });
    });
  });

  describe('choose — `match`, only the taken arm', () => {
    it('S4/S5: only the taken arm (:66) stops; arms :65 and :67 NEVER appear', async () => {
      const stops = await walkStepIn(control('choose'));
      assert.deepStrictEqual(asPairs(stops), [
        [6, 20],
        [21, 20],
        [219, 63],
        [228, 64],
        [240, 66],
        [243, 69],
        [245, 70],
      ]);
      const lines = stops.map((s) => s.line);
      assert.ok(lines.includes(66), 'expected the taken match arm (:66) to be a stop');
      assert.ok(!lines.includes(65), 'the un-taken arm 0=> (:65) must never be a stop');
      assert.ok(!lines.includes(67), 'the un-taken arm _=> (:67) must never be a stop');
    });
  });
});
