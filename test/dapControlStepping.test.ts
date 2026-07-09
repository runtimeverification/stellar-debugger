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
 * S17 drops the shim and the `pub fn` signature, so the entry stop (S1) now
 * lands on the first body statement at depth 2. Because `next` (step-over) only
 * lands on stop points at depth <= the current one, `stepIn` (the next run
 * start regardless of depth) is what descends into the depth-3 `bump` body;
 * `stepIn` therefore also enumerates every statement stop in trace order, one
 * per press.
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
  /** 1-based source column reported on the frame (S19: first non-whitespace). */
  col?: number;
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
    return { index: Number(probe[1]), line: frame.line, col: frame.column, path: frame.source?.path };
  }

  async function stopAfter(request: Promise<unknown>, reason = 'step'): Promise<Stop> {
    const [, stopped] = await Promise.all([request, dc.waitForEvent('stopped')]);
    assert.strictEqual((stopped as DebugProtocol.StoppedEvent).body.reason, reason);
    return top();
  }

  function expect(stop: Stop, expected: { index: number; line?: number; col?: number; file?: string }): void {
    assert.strictEqual(stop.index, expected.index, `stopped at trace index ${stop.index}, expected ${expected.index}`);
    if (expected.line !== undefined) {
      assert.strictEqual(stop.line, expected.line, `stopped at line ${stop.line}, expected ${expected.line}`);
    }
    if (expected.col !== undefined) {
      // S19: the frame column is the first non-whitespace column of the line,
      // NOT the DWARF sub-expression column.
      assert.strictEqual(stop.col, expected.col, `stopped at column ${stop.col}, expected ${expected.col} (S19)`);
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
   * entry stop, collecting every distinct stop in trace order — the DAP-visible
   * enumeration of the statement stop points. S20: the step AFTER the last stop
   * point ends the session (TerminatedEvent) rather than clamping in place, so
   * we race 'terminated' against 'stopped' on each press and stop collecting the
   * moment the session terminates (never blocking on a 'stopped' that won't come).
   */
  async function walkStepIn(launchArgs: object): Promise<Stop[]> {
    const stops: Stop[] = [await launchAndStop(launchArgs)];
    for (;;) {
      const req = dc.stepInRequest(STMT);
      const ended = await Promise.race([
        dc.waitForEvent('terminated').then(() => true),
        dc.waitForEvent('stopped').then(() => false),
      ]);
      await req;
      if (ended) {
        break; // S20: forward statement step past the last stop terminated.
      }
      const next = await top();
      // S20: past the last stop a statement step must TERMINATE, never clamp in
      // place. A repeated index means the engine clamped (pre-S20 behavior) —
      // fail fast and explicitly here rather than looping until the 30s timeout.
      assert.notStrictEqual(
        next.index,
        stops[stops.length - 1].index,
        `S20: statement stepIn clamped in place at index ${next.index} instead of terminating`,
      );
      stops.push(next);
    }
    return stops;
  }

  const asPairs = (stops: Stop[]): [number, number][] => stops.map((s) => [s.index, s.line]);

  describe('seq — straight-line sequence', () => {
    it('S1/S16/S17: entry lands on the first body statement (lib.rs:24), not the shim', async () => {
      // S17 drops the #[contractimpl] export shim (:20) and the `pub fn seq`
      // signature (:23), so the entry stop rests on the first real statement.
      const entry = await launchAndStop(control('seq'));
      // S19: :24's DWARF column was 19 (the `let a` initializer sub-expression);
      // the frame now reports the first non-whitespace column (9).
      expect(entry, { index: 236, line: 24, col: 9, file: CONTROL_LIB_SUFFIX });
    });

    it('S4/S5: statement stops are the three assignments and return brace — strictly increasing', async () => {
      const stops = await walkStepIn(control('seq'));
      assert.deepStrictEqual(asPairs(stops), [
        [236, 24],
        [249, 25],
        [262, 26],
        [265, 28],
      ]);
      // S19: every stop rests on its line's first non-whitespace column.
      assert.deepStrictEqual(stops.map((s) => s.col), [9, 9, 9, 5]);
      // The body lines strictly increase (24,25,26,28): a pure sequence stops
      // once per statement, never re-visiting a line.
      const bodyLines = stops.map((s) => s.line);
      for (let i = 1; i < bodyLines.length; i++) {
        assert.ok(bodyLines[i] > bodyLines[i - 1], `line ${bodyLines[i]} did not increase past ${bodyLines[i - 1]}`);
      }
    });
  });

  describe('branch — if/else, only the taken arm', () => {
    it('S4/S5: the else arm (:36) is a stop and the then arm (:34) NEVER appears', async () => {
      const stops = await walkStepIn(control('branch'));
      assert.deepStrictEqual(asPairs(stops), [
        [226, 33],
        [244, 36],
        [245, 33],
        [246, 38],
        [248, 39],
      ]);
      // S19: first non-whitespace column of each stop's line.
      assert.deepStrictEqual(stops.map((s) => s.col), [9, 13, 9, 9, 5]);
      const lines = stops.map((s) => s.line);
      assert.ok(lines.includes(36), 'expected the taken else arm (:36) to be a stop');
      assert.ok(!lines.includes(34), 'the un-taken then arm (:34) must never be a stop');
    });
  });

  describe('count — `for` loop, body once per iteration (S6/S12)', () => {
    it('S6: the loop body line :44 is a fresh statement stop each iteration (>=3 times)', async () => {
      const stops = await walkStepIn(control('count'));
      assert.deepStrictEqual(asPairs(stops), [
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
      // S19: first non-whitespace column of each stop's line.
      assert.deepStrictEqual(stops.map((s) => s.col), [9, 9, 13, 9, 13, 9, 13, 9, 9, 5]);
      const body = stops.filter((s) => s.line === 44);
      assert.ok(body.length >= 3, `expected >=3 per-iteration stops on :44, got ${body.length}`);
      // Each body stop is a distinct trace index — a genuinely separate stop.
      assert.strictEqual(new Set(body.map((s) => s.index)).size, body.length);
    });
  });

  describe('while_call — `while` with a real `bump` call', () => {
    // Post-S17/S18 statement stops (index=line@depth): ... 243=56@2 266=16@3
    // 278=18@3 291=57@2 ... The call line :56 sits at depth 2; bump's body
    // (:16) and epilogue brace (:18) at depth 3. The `fn bump` signature :15 is
    // dropped by S17 (bump has a real body statement, so the exception does not
    // apply).

    it('S4/S5/S6/S8: stepIn enumerates every stop, descending into bump each iteration', async () => {
      const stops = await walkStepIn(control('while_call'));
      assert.deepStrictEqual(asPairs(stops), [
        [228, 53],
        [231, 54],
        [234, 55],
        [243, 56],
        [266, 16],
        [278, 18],
        [291, 57],
        [305, 55],
        [314, 56],
        [337, 16],
        [349, 18],
        [362, 57],
        [376, 55],
        [385, 56],
        [408, 16],
        [420, 18],
        [433, 57],
        [447, 55],
        [456, 59],
        [459, 60],
      ]);
      // S19: first non-whitespace column of each stop's line (the depth-3 bump
      // body :16 is col 5, its epilogue brace :18 col 1).
      assert.deepStrictEqual(
        stops.map((s) => s.col),
        [9, 9, 9, 13, 5, 1, 13, 9, 13, 5, 1, 13, 9, 13, 5, 1, 13, 9, 9, 5],
      );
      // bump's first body line :16 is visited exactly once per loop iteration (3x).
      assert.strictEqual(stops.filter((s) => s.line === 16).length, 3);
      // The dropped `fn bump` signature :15 never surfaces as a stop (S17).
      assert.strictEqual(stops.filter((s) => s.line === 15).length, 0);
    });

    it('S4: stepIn at the call line :56 descends into bump body :16', async () => {
      await launchAndStop(control('while_call'));
      // Entry is the first body statement (:53); stepIn three times to reach the
      // first call line (:56, index 243). S19: :56's DWARF column was 19; the
      // first non-whitespace column is 13.
      expect(await stmtStepIn(3), { index: 243, line: 56, col: 13 });
      const stop = await stopAfter(dc.stepInRequest(STMT));
      expect(stop, { index: 266, line: 16, col: 5, file: CONTROL_LIB_SUFFIX });
    });

    it('S5/I1: next at the call line :56 steps OVER bump to :57 in one press', async () => {
      await launchAndStop(control('while_call'));
      expect(await stmtStepIn(3), { index: 243, line: 56, col: 13 });
      // bump's records (:16/:18) are one frame deeper and its return is
      // implicit (no return record); one `next` must skip the whole call.
      const stop = await stopAfter(dc.nextRequest(STMT));
      expect(stop, { index: 291, line: 57, col: 13, file: CONTROL_LIB_SUFFIX });
    });

    it('S7/S8: stepOut from inside bump returns to the caller line :57 (implicit return)', async () => {
      await launchAndStop(control('while_call'));
      expect(await stmtStepIn(3), { index: 243, line: 56, col: 13 });
      expect(await stopAfter(dc.stepInRequest(STMT)), { index: 266, line: 16, col: 5 });
      // Despite no `return` record, stepOut unwinds the deeper bump frame and
      // lands on the next shallower run start (:57).
      const stop = await stopAfter(dc.stepOutRequest(STMT));
      expect(stop, { index: 291, line: 57, col: 13 });
    });
  });

  describe('choose — `match`, only the taken arm', () => {
    it('S4/S5: only the taken arm (:66) stops; arms :65 and :67 NEVER appear', async () => {
      const stops = await walkStepIn(control('choose'));
      assert.deepStrictEqual(asPairs(stops), [
        [228, 64],
        [240, 66],
        [243, 69],
        [245, 70],
      ]);
      // S19: :64's DWARF column was 23 (the `match x % 3` sub-expression); the
      // first non-whitespace column is 9. Every stop rests at its line start.
      assert.deepStrictEqual(stops.map((s) => s.col), [9, 13, 9, 5]);
      const lines = stops.map((s) => s.line);
      assert.ok(lines.includes(66), 'expected the taken match arm (:66) to be a stop');
      assert.ok(!lines.includes(65), 'the un-taken arm 0=> (:65) must never be a stop');
      assert.ok(!lines.includes(67), 'the un-taken arm _=> (:67) must never be a stop');
    });
  });
});
