/**
 * Systematic DAP-level suite for the stepping spec (docs/stepping.md): the
 * S1..S16 rules pinned end-to-end over the real adapter (RawTraceBackend
 * replay of the committed fixtures), citing the I1..I8 defect IDs where a rule
 * was empirically violated. test/stepping.test.ts pins the underlying
 * visible/depth/run model at the pure level.
 *
 * Ground truth (see docs/stepping.md "Fixtures"):
 *   adder-debug   — invisible 0..5; run starts 6 (:12), 29 (:16), 40 (:12).
 *   stepper-debug — invisible 0..4; run starts 5 (:20), 21/39/56/73 (:25),
 *                   27/44/61 (:26), 29/46/63 (:15, depth 1), 84 (:20); the
 *                   three `triple` calls return IMPLICITLY (no return record).
 */

import * as assert from 'assert';
import * as path from 'path';
import { DebugClient } from '@vscode/debugadapter-testsupport';
import { DebugProtocol } from '@vscode/debugprotocol';

const ADAPTER = path.join(__dirname, 'support', 'adapterEntry.js');
const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const EXAMPLES = path.join(__dirname, '..', '..', 'examples');

const STEPPER = {
  rawTrace: path.join(FIXTURES, 'stepper-debug.trace.jsonl'),
  wasmPath: path.join(FIXTURES, 'stepper-debug.wasm'),
};
const ADDER = {
  rawTrace: path.join(FIXTURES, 'adder-debug.trace.jsonl'),
  wasmPath: path.join(FIXTURES, 'adder-debug.wasm'),
};
const ADDER_RAW = { rawTrace: ADDER.rawTrace };
const TAIL_RAW = { rawTrace: path.join(FIXTURES, 'synthetic-tail.trace.jsonl') };
const ALL_NULL_RAW = { rawTrace: path.join(FIXTURES, 'synthetic-all-null.trace.jsonl') };

const STEPPER_LIB = path.join(EXAMPLES, 'stepper', 'src', 'lib.rs');
const ADDER_LIB = path.join(EXAMPLES, 'adder', 'src', 'lib.rs');
const STEPPER_LIB_SUFFIX = 'examples/stepper/src/lib.rs';
const ADDER_LIB_SUFFIX = 'examples/adder/src/lib.rs';

const THREAD = { threadId: 1 };
const STMT = { ...THREAD, granularity: 'statement' as const };
const INSTR = { ...THREAD, granularity: 'instruction' as const };

/** What the top stack frame shows at a stop. */
interface Stop {
  /** Trace index, parsed from the frame name's '[<cursor>/<last>]' probe. */
  index: number;
  line: number;
  path?: string;
  ipRef?: string;
}

describe('Stepping spec (docs/stepping.md, DAP level)', () => {
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
    return {
      index: Number(probe[1]),
      line: frame.line,
      path: frame.source?.path,
      ipRef: frame.instructionPointerReference,
    };
  }

  /** Send a stepping/continue request, await the stop, and return the frame. */
  async function stopAfter(request: Promise<unknown>, reason = 'step'): Promise<Stop> {
    const [, stopped] = await Promise.all([request, dc.waitForEvent('stopped')]);
    assert.strictEqual((stopped as DebugProtocol.StoppedEvent).body.reason, reason);
    return top();
  }

  function expect(
    stop: Stop,
    expected: { index: number; line?: number; ipRef?: string; file?: string; sourceless?: boolean },
  ): void {
    assert.strictEqual(stop.index, expected.index, `stopped at trace index ${stop.index}, expected ${expected.index}`);
    if (expected.line !== undefined) {
      assert.strictEqual(stop.line, expected.line, `stopped at line ${stop.line}, expected ${expected.line}`);
    }
    if (expected.ipRef !== undefined) {
      assert.strictEqual(stop.ipRef, expected.ipRef);
    }
    if (expected.file !== undefined) {
      assert.ok(stop.path?.endsWith(expected.file), `unexpected source: ${stop.path}`);
    }
    if (expected.sourceless) {
      assert.strictEqual(stop.path, undefined, `expected a sourceless frame, got ${stop.path}`);
    }
  }

  /** Launch and wait for the entry stop, returning it. */
  async function launchAndStop(launchArgs: object): Promise<Stop> {
    const [, , stopped] = await Promise.all([
      dc.configurationSequence(),
      dc.launch(launchArgs as any),
      dc.waitForEvent('stopped'),
    ]);
    assert.strictEqual((stopped as DebugProtocol.StoppedEvent).body.reason, 'entry');
    return top();
  }

  /** Launch with source breakpoints set during configuration (see dap.test.ts). */
  async function launchWithBreakpoints(
    launchArgs: object,
    sourcePath: string,
    lines: number[],
  ): Promise<DebugProtocol.SetBreakpointsResponse> {
    let bpResponse: DebugProtocol.SetBreakpointsResponse | undefined;
    await Promise.all([
      dc.launch(launchArgs as any),
      dc.waitForEvent('initialized').then(async () => {
        bpResponse = await dc.setBreakpointsRequest({
          source: { path: sourcePath },
          breakpoints: lines.map((line) => ({ line })),
        });
        await dc.configurationDoneRequest();
      }),
      dc.waitForEvent('stopped'),
    ]);
    assert.ok(bpResponse, 'expected a setBreakpoints response');
    return bpResponse;
  }

  async function setInstructionBreakpoints(
    breakpoints: DebugProtocol.InstructionBreakpoint[],
  ): Promise<DebugProtocol.SetInstructionBreakpointsResponse> {
    const args: DebugProtocol.SetInstructionBreakpointsArguments = { breakpoints };
    return (await dc.customRequest(
      'setInstructionBreakpoints',
      args,
    )) as DebugProtocol.SetInstructionBreakpointsResponse;
  }

  /** Statement-next `times` times, returning the last stop. */
  async function stmtNext(times: number): Promise<Stop> {
    let stop!: Stop;
    for (let i = 0; i < times; i++) {
      stop = await stopAfter(dc.nextRequest(STMT));
    }
    return stop;
  }

  describe('stepper fixture — statement granularity', () => {
    it('S1/S11/S16: entry stops on the first run start with source and address', async () => {
      const entry = await launchAndStop(STEPPER);
      expect(entry, { index: 5, line: 20, file: STEPPER_LIB_SUFFIX, ipRef: '0xd' });
    });

    it('S4: stepIn enters the callee at its first mapped line', async () => {
      await launchAndStop(STEPPER);
      expect(await stmtNext(2), { index: 27, line: 26 });
      const stop = await stopAfter(dc.stepInRequest(STMT));
      expect(stop, { index: 29, line: 15, file: STEPPER_LIB_SUFFIX, ipRef: '0x3' });
    });

    it('S5/I1: next steps over the implicit-return call in one press', async () => {
      await launchAndStop(STEPPER);
      expect(await stmtNext(2), { index: 27, line: 26 });
      // triple's return is implicit (no return record): one press must still
      // step over the whole call and land on the loop line's next run.
      const stop = await stopAfter(dc.nextRequest(STMT));
      expect(stop, { index: 39, line: 25, file: STEPPER_LIB_SUFFIX, ipRef: '0x49' });
    });

    it('S6/S2: the loop stops once per iteration, then forward steps clamp', async () => {
      await launchAndStop(STEPPER);
      const sequence: [number, number][] = [
        [21, 25],
        [27, 26],
        [39, 25],
        [44, 26],
        [56, 25],
        [61, 26],
        [73, 25],
        [84, 20],
      ];
      for (const [index, line] of sequence) {
        expect(await stopAfter(dc.nextRequest(STMT)), { index, line });
      }
      // S2: no further stop point ahead — stay on the last one, still a stop.
      expect(await stopAfter(dc.nextRequest(STMT)), { index: 84, line: 20 });
    });

    it('S7/I7/S16: stepOut from the callee lands on the next shallower run start, mapped', async () => {
      await launchAndStop(STEPPER);
      await stmtNext(2);
      expect(await stopAfter(dc.stepInRequest(STMT)), { index: 29, line: 15 });
      const stop = await stopAfter(dc.stepOutRequest(STMT));
      expect(stop, { index: 39, line: 25, file: STEPPER_LIB_SUFFIX, ipRef: '0x49' });
    });

    it('S7/S2: stepOut at the outermost depth runs to the last stop point', async () => {
      await launchAndStop(STEPPER);
      const stop = await stopAfter(dc.stepOutRequest(STMT));
      expect(stop, { index: 84, line: 20, ipRef: '0x56' });
    });

    it('S8: stepBack lands on the previous run start, skipping the deeper frame', async () => {
      await launchAndStop(STEPPER);
      expect(await stmtNext(3), { index: 39, line: 25 });
      const stop = await stopAfter(dc.stepBackRequest(STMT));
      expect(stop, { index: 27, line: 26, ipRef: '0x35' });
    });

    it('S8: stepBack from inside the callee lands on the caller run start', async () => {
      await launchAndStop(STEPPER);
      await stmtNext(2);
      expect(await stopAfter(dc.stepInRequest(STMT)), { index: 29, line: 15 });
      const stop = await stopAfter(dc.stepBackRequest(STMT));
      expect(stop, { index: 27, line: 26 });
    });

    it('S9/S3: reverse stepping revisits the per-iteration stops, then clamps at the first', async () => {
      await launchAndStop(STEPPER);
      // Run to the last stop point (S14), then walk the whole trace backwards.
      expect(await stopAfter(dc.continueRequest(THREAD)), { index: 84, line: 20 });
      const sequence: [number, number][] = [
        [73, 25],
        [61, 26],
        [56, 25],
        [44, 26],
        [39, 25],
        [27, 26],
        [21, 25],
        [5, 20],
      ];
      for (const [index, line] of sequence) {
        expect(await stopAfter(dc.stepBackRequest(STMT)), { index, line });
      }
      // S3: no earlier stop point — stay on the first one, still a stop.
      expect(await stopAfter(dc.stepBackRequest(STMT)), { index: 5, line: 20 });
    });
  });

  describe('stepper fixture — instruction granularity', () => {
    it('S10/S11/I2: stepIn moves exactly one visible record per press', async () => {
      await launchAndStop(STEPPER);
      expect(await stopAfter(dc.stepInRequest(INSTR)), { index: 6, ipRef: '0xf' });
      expect(await stopAfter(dc.stepInRequest(INSTR)), { index: 7, ipRef: '0x11' });
      // Record 8 is visible but unmapped — still a legitimate instruction stop.
      expect(await stopAfter(dc.stepInRequest(INSTR)), { index: 8, ipRef: '0x14' });
    });

    it('S10/S11: stepIn enters the callee; next and reverse-next step over it', async () => {
      await launchAndStop(STEPPER);
      await stmtNext(2);
      expect(await stopAfter(dc.stepInRequest(INSTR)), { index: 28, ipRef: '0x37' });
      expect(await stopAfter(dc.stepInRequest(INSTR)), { index: 29, ipRef: '0x3', line: 15 });
      // stepBack is reverse-next: from the callee's first record back to the call.
      expect(await stopAfter(dc.stepBackRequest(INSTR)), { index: 28, ipRef: '0x37' });
      // next skips the whole callee frame (29..31) in one press.
      expect(await stopAfter(dc.nextRequest(INSTR)), { index: 32, ipRef: '0x3d' });
      // ... and reverse-next skips it backwards again.
      expect(await stopAfter(dc.stepBackRequest(INSTR)), { index: 28, ipRef: '0x37' });
    });

    it('S16: an instruction stop on an unmapped record is sourceless but addressed', async () => {
      await launchAndStop(STEPPER);
      await stmtNext(2);
      await stopAfter(dc.stepInRequest(INSTR)); // 28, the call
      const stop = await stopAfter(dc.nextRequest(INSTR));
      expect(stop, { index: 32, ipRef: '0x3d', sourceless: true });
    });

    it('S7: instruction stepOut leaves the callee to the next shallower visible record', async () => {
      await launchAndStop(STEPPER);
      await stmtNext(2);
      expect(await stopAfter(dc.stepInRequest(STMT)), { index: 29, line: 15 });
      const stop = await stopAfter(dc.stepOutRequest(INSTR));
      expect(stop, { index: 32, ipRef: '0x3d' });
    });

    it('S3: instruction stepBack at the first visible record stays put', async () => {
      await launchAndStop(STEPPER);
      const stop = await stopAfter(dc.stepBackRequest(INSTR));
      expect(stop, { index: 5, ipRef: '0xd' });
    });

    it('S2: instruction stepIn at the last stop point stays put', async () => {
      await launchAndStop(STEPPER);
      expect(await stopAfter(dc.continueRequest(THREAD)), { index: 84 });
      const stop = await stopAfter(dc.stepInRequest(INSTR));
      expect(stop, { index: 84, ipRef: '0x56' });
    });
  });

  describe('stepper fixture — continue and breakpoints', () => {
    it('S12/S14: a loop-line breakpoint stops once per iteration, then settles at the end', async () => {
      const res = await launchWithBreakpoints(STEPPER, STEPPER_LIB, [25]);
      assert.strictEqual(res.body.breakpoints[0].verified, true);
      assert.strictEqual(res.body.breakpoints[0].line, 25);

      for (const index of [21, 39, 56, 73]) {
        expect(await stopAfter(dc.continueRequest(THREAD), 'breakpoint'), { index, line: 25 });
      }
      // S14: no breakpoint ahead — settle on the last stop point, plain stop.
      expect(await stopAfter(dc.continueRequest(THREAD)), { index: 84, line: 20 });
    });

    it('S13/S14: reverseContinue mirrors continue on run starts, then settles at the start', async () => {
      await launchWithBreakpoints(STEPPER, STEPPER_LIB, [25]);
      for (let i = 0; i < 5; i++) {
        await stopAfter(dc.continueRequest(THREAD), i < 4 ? 'breakpoint' : 'step');
      }
      for (const index of [73, 56, 39, 21]) {
        expect(await stopAfter(dc.reverseContinueRequest(THREAD), 'breakpoint'), { index, line: 25 });
      }
      // S14: no breakpoint behind — settle on the first stop point, plain stop.
      expect(await stopAfter(dc.reverseContinueRequest(THREAD)), { index: 5, line: 20 });
    });

    it('S12: a breakpoint on the callee line stops once per call', async () => {
      const res = await launchWithBreakpoints(STEPPER, STEPPER_LIB, [15]);
      assert.strictEqual(res.body.breakpoints[0].verified, true);
      for (const index of [29, 46, 63]) {
        expect(await stopAfter(dc.continueRequest(THREAD), 'breakpoint'), {
          index,
          line: 15,
          ipRef: '0x3',
        });
      }
    });

    it('S15: an instruction breakpoint inside the callee hits once per execution', async () => {
      await launchAndStop(STEPPER);
      const res = await setInstructionBreakpoints([{ instructionReference: '0x3' }]);
      assert.strictEqual(res.body.breakpoints[0].verified, true);
      for (const index of [29, 46, 63]) {
        expect(await stopAfter(dc.continueRequest(THREAD), 'breakpoint'), { index, ipRef: '0x3' });
      }
    });
  });

  describe('adder fixture', () => {
    it('S1/I3: entry lands on lib.rs:12 with an instruction pointer', async () => {
      const entry = await launchAndStop(ADDER);
      expect(entry, { index: 6, line: 12, file: ADDER_LIB_SUFFIX, ipRef: '0x5' });
    });

    it('S10/I2: no dead presses at the trace start, in either direction', async () => {
      await launchAndStop(ADDER);
      expect(await stopAfter(dc.stepInRequest(INSTR)), { index: 7, ipRef: '0x7' });
      expect(await stopAfter(dc.stepInRequest(INSTR)), { index: 8, ipRef: '0x9' });
      expect(await stopAfter(dc.stepBackRequest(INSTR)), { index: 7, ipRef: '0x7' });
      expect(await stopAfter(dc.stepBackRequest(INSTR)), { index: 6, ipRef: '0x5' });
      // S3: the entry record is the first visible one — stay put.
      expect(await stopAfter(dc.stepBackRequest(INSTR)), { index: 6, ipRef: '0x5' });
    });

    it('S2/S11: statement steps visit each run start once and clamp at the last', async () => {
      await launchAndStop(ADDER);
      expect(await stopAfter(dc.nextRequest(STMT)), { index: 29, line: 16, ipRef: '0x2d' });
      expect(await stopAfter(dc.nextRequest(STMT)), { index: 40, line: 12, ipRef: '0x3e' });
      expect(await stopAfter(dc.nextRequest(STMT)), { index: 40, line: 12 });
    });

    it('S3/I5: statement stepBack at the first run start stays mapped', async () => {
      await launchAndStop(ADDER);
      const stop = await stopAfter(dc.stepBackRequest(STMT));
      expect(stop, { index: 6, line: 12, file: ADDER_LIB_SUFFIX });
    });

    it('I4/S12/S13: a lib.rs:16 breakpoint stops once per execution, symmetric in reverse', async () => {
      await launchWithBreakpoints(ADDER, ADDER_LIB, [16]);
      // One execution of the line -> ONE forward stop (not one per record).
      expect(await stopAfter(dc.continueRequest(THREAD), 'breakpoint'), {
        index: 29,
        line: 16,
        ipRef: '0x2d',
      });
      expect(await stopAfter(dc.continueRequest(THREAD)), { index: 40, line: 12 });
      // Reverse lands on the same run START (29), not the run end (33).
      expect(await stopAfter(dc.reverseContinueRequest(THREAD), 'breakpoint'), {
        index: 29,
        line: 16,
        ipRef: '0x2d',
      });
      // S14/I6: nothing behind — settle on the first stop point, plain stop.
      expect(await stopAfter(dc.reverseContinueRequest(THREAD)), { index: 6, line: 12 });
    });

    it('I6/S14: continue without breakpoints settles on the stop points, not the raw ends', async () => {
      await launchAndStop(ADDER);
      expect(await stopAfter(dc.continueRequest(THREAD)), { index: 40, line: 12 });
      expect(await stopAfter(dc.reverseContinueRequest(THREAD)), { index: 6, line: 12 });
    });
  });

  describe('wasm-less replay (raw positions as visibility)', () => {
    it('S1: entry lands on the first record with a raw position', async () => {
      const entry = await launchAndStop(ADDER_RAW);
      expect(entry, { index: 0, ipRef: '0x3', sourceless: true });
    });

    it('S10/I2: instruction steps skip pos:null records in both directions', async () => {
      await launchAndStop(ADDER_RAW);
      expect(await stopAfter(dc.stepInRequest(INSTR)), { index: 1, ipRef: '0xb' });
      expect(await stopAfter(dc.stepInRequest(INSTR)), { index: 2, ipRef: '0x13' });
      // Records 3..5 are pos:null — invisible even in raw mode.
      expect(await stopAfter(dc.stepInRequest(INSTR)), { index: 6, ipRef: '0x5' });
      expect(await stopAfter(dc.stepBackRequest(INSTR)), { index: 2, ipRef: '0x13' });
    });

    it('S2/S14/I6: trailing pos:null records are never a resting point', async () => {
      const entry = await launchAndStop(TAIL_RAW);
      expect(entry, { index: 0, ipRef: '0x1' });
      // The last two records are invisible: continue settles on the last
      // VISIBLE record, not the raw end of the trace.
      expect(await stopAfter(dc.continueRequest(THREAD)), { index: 2, ipRef: '0x3' });
      expect(await stopAfter(dc.stepInRequest(INSTR)), { index: 2, ipRef: '0x3' });
      expect(await stopAfter(dc.reverseContinueRequest(THREAD)), { index: 0, ipRef: '0x1' });
    });

    it('S1: a trace with no stop point at all falls back to index 0', async () => {
      const entry = await launchAndStop(ALL_NULL_RAW);
      expect(entry, { index: 0, sourceless: true });
      assert.strictEqual(entry.ipRef, undefined);
    });
  });
});
