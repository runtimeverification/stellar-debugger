/**
 * Systematic DAP-level suite for the stepping spec (docs/stepping.md): the
 * S1..S16 rules pinned end-to-end over the real adapter (RawTraceBackend
 * replay of the committed fixtures), citing the I1..I8 defect IDs where a rule
 * was empirically violated. test/stepping.test.ts pins the underlying
 * visible/depth/run model at the pure level.
 *
 * Ground truth (see docs/stepping.md "Fixtures"), post-S17/S18 filtering:
 *   adder-debug   — invisible 0..5; raw run starts 6 (:12), 29 (:16), 40 (:12);
 *                   both :12 run starts are the #[contractimpl] shim, dropped by
 *                   S17, leaving ONE statement stop: 29 (:16). First visible
 *                   record is 6, last is 40.
 *   stepper-debug — invisible 0..4; statement stops 21/39/56/73 (:25),
 *                   27/44/61 (:26), 29/46/63 (:15, depth 1 — kept by the S17
 *                   sole-frame-stop exception, `triple` collapses onto its
 *                   signature line). The #[contractimpl] shim (5, :20) and its
 *                   epilogue (84, :20) are dropped by S17; the three `triple`
 *                   calls return IMPLICITLY (no return record). First visible
 *                   record is 5, last is 84.
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
  /** 1-based source column reported on the frame (S19: first non-whitespace). */
  col?: number;
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
      col: frame.column,
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

  /**
   * S20: issue a forward statement step that should EXHAUST the stop set and end
   * the session. Races 'terminated' against 'stopped' so a step that terminates
   * never blocks the suite waiting 30s for a 'stopped' that will never come, and
   * a step that (wrongly, pre-S20) clamps-in-place resolves promptly as false.
   * Returns true iff the session terminated.
   */
  async function stepEndsSession(reqFactory: () => Promise<unknown>): Promise<boolean> {
    const req = reqFactory();
    const ended = await Promise.race([
      dc.waitForEvent('terminated').then(() => true),
      dc.waitForEvent('stopped').then(() => false),
    ]);
    await req;
    return ended;
  }

  function expect(
    stop: Stop,
    expected: { index: number; line?: number; col?: number; ipRef?: string; file?: string; sourceless?: boolean },
  ): void {
    assert.strictEqual(stop.index, expected.index, `stopped at trace index ${stop.index}, expected ${expected.index}`);
    if (expected.line !== undefined) {
      assert.strictEqual(stop.line, expected.line, `stopped at line ${stop.line}, expected ${expected.line}`);
    }
    if (expected.col !== undefined) {
      // S19: the frame column is the first non-whitespace column of the line,
      // NOT the DWARF sub-expression column.
      assert.strictEqual(stop.col, expected.col, `stopped at column ${stop.col}, expected ${expected.col} (S19)`);
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

  /**
   * Walk at instruction granularity in one direction until the cursor clamps
   * (stops changing) — reaching the first visible record with 'back' or the
   * last with 'in'. Statement-stop filtering (S17/S18) moves the ENTRY stop off
   * the trace ends, so instruction-level head/tail tests re-anchor with this.
   */
  async function instrClamp(direction: 'back' | 'in'): Promise<Stop> {
    let prev = -1;
    let cur = await top();
    while (cur.index !== prev) {
      prev = cur.index;
      cur = await stopAfter(
        direction === 'back' ? dc.stepBackRequest(INSTR) : dc.stepInRequest(INSTR),
      );
    }
    return cur;
  }

  describe('stepper fixture — statement granularity', () => {
    it('S1/S11/S16/S17: entry stops on the first statement stop, not the shim', async () => {
      // S17 drops the #[contractimpl] shim (record 5, :20); the entry stop lands
      // on the first surviving statement stop — the `while` line (:25, record 21).
      const entry = await launchAndStop(STEPPER);
      // S19: the DWARF column of the `while` line was 15 (the sub-expression);
      // the frame now reports the first non-whitespace column (9).
      expect(entry, { index: 21, line: 25, col: 9, file: STEPPER_LIB_SUFFIX, ipRef: '0x2a' });
    });

    it('S4: stepIn enters the callee at its first mapped line', async () => {
      await launchAndStop(STEPPER);
      // S19: :26's DWARF column was 36; the first non-whitespace column is 13.
      expect(await stmtNext(1), { index: 27, line: 26, col: 13 });
      // triple collapses onto its `fn` signature (:15), kept by the S17
      // sole-frame-stop exception, so step-in still has a target. S19: the DWARF
      // column was undefined/0; the first non-whitespace column is 1.
      const stop = await stopAfter(dc.stepInRequest(STMT));
      expect(stop, { index: 29, line: 15, col: 1, file: STEPPER_LIB_SUFFIX, ipRef: '0x3' });
    });

    it('S5/I1: next steps over the implicit-return call in one press', async () => {
      await launchAndStop(STEPPER);
      expect(await stmtNext(1), { index: 27, line: 26, col: 13 });
      // triple's return is implicit (no return record): one press must still
      // step over the whole call and land on the loop line's next run.
      const stop = await stopAfter(dc.nextRequest(STMT));
      expect(stop, { index: 39, line: 25, col: 9, file: STEPPER_LIB_SUFFIX, ipRef: '0x49' });
    });

    it('S6/S20: the loop stops once per iteration, then a forward step terminates', async () => {
      await launchAndStop(STEPPER);
      // Entry already sits on the first :25 run start (21); `next` (step over)
      // then alternates :26/:25 once per iteration, skipping the deeper triple.
      const sequence: { index: number; line: number; col: number }[] = [
        { index: 27, line: 26, col: 13 },
        { index: 39, line: 25, col: 9 },
        { index: 44, line: 26, col: 13 },
        { index: 56, line: 25, col: 9 },
        { index: 61, line: 26, col: 13 },
        { index: 73, line: 25, col: 9 },
      ];
      for (const step of sequence) {
        expect(await stopAfter(dc.nextRequest(STMT)), step);
      }
      // S20: no further statement stop ahead (the :20 epilogue is dropped by
      // S17) — a forward statement step ends the session instead of clamping.
      assert.ok(
        await stepEndsSession(() => dc.nextRequest(STMT)),
        'expected the forward statement step past the last stop to terminate (S20)',
      );
    });

    it('S7/I7/S16: stepOut from the callee lands on the next shallower run start, mapped', async () => {
      await launchAndStop(STEPPER);
      await stmtNext(1);
      expect(await stopAfter(dc.stepInRequest(STMT)), { index: 29, line: 15, col: 1 });
      const stop = await stopAfter(dc.stepOutRequest(STMT));
      expect(stop, { index: 39, line: 25, col: 9, file: STEPPER_LIB_SUFFIX, ipRef: '0x49' });
    });

    it('S7/S20: statement stepOut at the outermost depth terminates the session', async () => {
      await launchAndStop(STEPPER);
      // The entry stop (index 21) is at the outermost recorded depth: there is no
      // shallower run start, so a statement stepOut terminates (S20/S7).
      assert.ok(
        await stepEndsSession(() => dc.stepOutRequest(STMT)),
        'expected stepOut at the outermost depth to terminate (S20)',
      );
    });

    it('S8: stepBack lands on the previous run start, skipping the deeper frame', async () => {
      await launchAndStop(STEPPER);
      expect(await stmtNext(2), { index: 39, line: 25, col: 9 });
      const stop = await stopAfter(dc.stepBackRequest(STMT));
      expect(stop, { index: 27, line: 26, col: 13, ipRef: '0x35' });
    });

    it('S8: stepBack from inside the callee lands on the caller run start', async () => {
      await launchAndStop(STEPPER);
      await stmtNext(1);
      expect(await stopAfter(dc.stepInRequest(STMT)), { index: 29, line: 15, col: 1 });
      const stop = await stopAfter(dc.stepBackRequest(STMT));
      expect(stop, { index: 27, line: 26, col: 13 });
    });

    it('S9/S3: reverse stepping revisits the per-iteration stops, then clamps at the first', async () => {
      await launchAndStop(STEPPER);
      // Run to the last stop point (S14), then walk the whole trace backwards.
      expect(await stopAfter(dc.continueRequest(THREAD)), { index: 73, line: 25, col: 9 });
      const sequence: { index: number; line: number; col: number }[] = [
        { index: 61, line: 26, col: 13 },
        { index: 56, line: 25, col: 9 },
        { index: 44, line: 26, col: 13 },
        { index: 39, line: 25, col: 9 },
        { index: 27, line: 26, col: 13 },
        { index: 21, line: 25, col: 9 },
      ];
      for (const step of sequence) {
        expect(await stopAfter(dc.stepBackRequest(STMT)), step);
      }
      // S3/S8: no earlier statement stop (the :20 shim is dropped by S17) — a
      // reverse step CLAMPS on the first one (never terminates, S20 is forward-only).
      expect(await stopAfter(dc.stepBackRequest(STMT)), { index: 21, line: 25, col: 9 });
    });
  });

  describe('stepper fixture — instruction granularity', () => {
    it('S10/S11/I2: stepIn moves exactly one visible record per press', async () => {
      await launchAndStop(STEPPER);
      // Entry sits at the first statement stop (record 21) now, so rewind to the
      // first visible record before pinning the head sequence.
      await instrClamp('back');
      expect(await stopAfter(dc.stepInRequest(INSTR)), { index: 6, ipRef: '0xf' });
      expect(await stopAfter(dc.stepInRequest(INSTR)), { index: 7, ipRef: '0x11' });
      // Record 8 is visible but unmapped — still a legitimate instruction stop.
      expect(await stopAfter(dc.stepInRequest(INSTR)), { index: 8, ipRef: '0x14' });
    });

    it('S10/S11: stepIn enters the callee; next and reverse-next step over it', async () => {
      await launchAndStop(STEPPER);
      await stmtNext(1);
      expect(await stopAfter(dc.stepInRequest(INSTR)), { index: 28, ipRef: '0x37' });
      // S19: resting on a mapped record, the frame column is the line start (1),
      // even at instruction granularity — only disassembly rows keep DWARF cols.
      expect(await stopAfter(dc.stepInRequest(INSTR)), { index: 29, ipRef: '0x3', line: 15, col: 1 });
      // stepBack is reverse-next: from the callee's first record back to the call.
      expect(await stopAfter(dc.stepBackRequest(INSTR)), { index: 28, ipRef: '0x37' });
      // next skips the whole callee frame (29..31) in one press.
      expect(await stopAfter(dc.nextRequest(INSTR)), { index: 32, ipRef: '0x3d' });
      // ... and reverse-next skips it backwards again.
      expect(await stopAfter(dc.stepBackRequest(INSTR)), { index: 28, ipRef: '0x37' });
    });

    it('S16: an instruction stop on an unmapped record is sourceless but addressed', async () => {
      await launchAndStop(STEPPER);
      await stmtNext(1);
      await stopAfter(dc.stepInRequest(INSTR)); // 28, the call
      const stop = await stopAfter(dc.nextRequest(INSTR));
      expect(stop, { index: 32, ipRef: '0x3d', sourceless: true });
    });

    it('S7: instruction stepOut leaves the callee to the next shallower visible record', async () => {
      await launchAndStop(STEPPER);
      await stmtNext(1);
      expect(await stopAfter(dc.stepInRequest(STMT)), { index: 29, line: 15, col: 1 });
      const stop = await stopAfter(dc.stepOutRequest(INSTR));
      expect(stop, { index: 32, ipRef: '0x3d' });
    });

    it('S3: instruction stepBack at the first visible record stays put', async () => {
      await launchAndStop(STEPPER);
      // Rewind to the first visible record (5, the shim) — instruction stops are
      // unaffected by S17/S18, only the statement entry moved off it.
      const stop = await instrClamp('back');
      expect(stop, { index: 5, ipRef: '0xd' });
    });

    it('S2: instruction stepIn at the last visible record stays put', async () => {
      await launchAndStop(STEPPER);
      // Instruction granularity rests on visible records, so the last stop is
      // the trailing epilogue record (84), not the last statement stop (73).
      const stop = await instrClamp('in');
      expect(stop, { index: 84, ipRef: '0x56' });
      // A further stepIn stays put (S2).
      expect(await stopAfter(dc.stepInRequest(INSTR)), { index: 84, ipRef: '0x56' });
    });
  });

  describe('stepper fixture — continue and breakpoints', () => {
    it('S12/S14: a loop-line breakpoint stops once per iteration, then settles at the end', async () => {
      const res = await launchWithBreakpoints(STEPPER, STEPPER_LIB, [25]);
      assert.strictEqual(res.body.breakpoints[0].verified, true);
      assert.strictEqual(res.body.breakpoints[0].line, 25);

      // Entry already sits on the first :25 run start (21); continue then hits
      // the remaining three per-iteration run starts.
      for (const index of [39, 56, 73]) {
        expect(await stopAfter(dc.continueRequest(THREAD), 'breakpoint'), { index, line: 25 });
      }
      // S14: no breakpoint ahead — settle on the last stop point (73), plain stop.
      expect(await stopAfter(dc.continueRequest(THREAD)), { index: 73, line: 25 });
    });

    it('S13/S14: reverseContinue mirrors continue on run starts, then settles at the start', async () => {
      await launchWithBreakpoints(STEPPER, STEPPER_LIB, [25]);
      // Drive forward to the last :25 run start: three breakpoint hits (39, 56,
      // 73), then the settle-at-end plain stop.
      for (let i = 0; i < 4; i++) {
        await stopAfter(dc.continueRequest(THREAD), i < 3 ? 'breakpoint' : 'step');
      }
      for (const index of [56, 39, 21]) {
        expect(await stopAfter(dc.reverseContinueRequest(THREAD), 'breakpoint'), { index, line: 25 });
      }
      // S14: no breakpoint behind — settle on the first stop point (21), plain stop.
      expect(await stopAfter(dc.reverseContinueRequest(THREAD)), { index: 21, line: 25 });
    });

    it('S12: a breakpoint on the callee line stops once per call', async () => {
      const res = await launchWithBreakpoints(STEPPER, STEPPER_LIB, [15]);
      assert.strictEqual(res.body.breakpoints[0].verified, true);
      for (const index of [29, 46, 63]) {
        expect(await stopAfter(dc.continueRequest(THREAD), 'breakpoint'), {
          index,
          line: 15,
          col: 1,
          ipRef: '0x3',
        });
      }
    });

    it('S12/S13/S17: a breakpoint on the S17-dropped #[contractimpl] line still fires at its run starts', async () => {
      // lib.rs:20 is the `#[contractimpl]` shim — its run starts (records 5 and
      // 84) are dropped from STATEMENT stepping by S17, so no step ever rests on
      // them. But a source breakpoint there must still resolve and fire at each
      // :20 run start (breakpoint resolution is unchanged by S17/S18). Regression
      // guard: without this, S17/S18 leaking into resolvedBreakpointIndices would
      // leave a breakpoint on a declaration/brace line silently dead.
      const res = await launchWithBreakpoints(STEPPER, STEPPER_LIB, [20]);
      assert.strictEqual(res.body.breakpoints[0].verified, true);
      assert.strictEqual(res.body.breakpoints[0].line, 20);

      // Entry sits on the first statement stop (record 21, :25). reverseContinue
      // reaches the earlier :20 run start (record 5); forward continue then
      // reaches the trailing one (record 84) — the S13 mirror on a filtered line.
      expect(await stopAfter(dc.reverseContinueRequest(THREAD), 'breakpoint'), {
        index: 5,
        line: 20,
        file: STEPPER_LIB_SUFFIX,
      });
      expect(await stopAfter(dc.continueRequest(THREAD), 'breakpoint'), {
        index: 84,
        line: 20,
        file: STEPPER_LIB_SUFFIX,
      });
    });

    it('S15: an instruction breakpoint inside the callee hits once per execution', async () => {
      await launchAndStop(STEPPER);
      const res = await setInstructionBreakpoints([{ instructionReference: '0x3' }]);
      assert.strictEqual(res.body.breakpoints[0].verified, true);
      for (const index of [29, 46, 63]) {
        // Each hit rests on the mapped :15 record — S19 line-start column 1.
        expect(await stopAfter(dc.continueRequest(THREAD), 'breakpoint'), { index, col: 1, ipRef: '0x3' });
      }
    });
  });

  describe('adder fixture', () => {
    it('S1/I3/S17: entry lands on the sole statement stop lib.rs:16 (shim dropped)', async () => {
      // The two :12 run starts (records 6, 40) are the #[contractimpl] shim,
      // dropped by S17 — leaving one statement stop, the body `a + b` (:16).
      const entry = await launchAndStop(ADDER);
      expect(entry, { index: 29, line: 16, col: 9, file: ADDER_LIB_SUFFIX, ipRef: '0x2d' });
    });

    it('S10/I2: no dead presses at the trace start, in either direction', async () => {
      await launchAndStop(ADDER);
      // Entry now sits at record 29 (:16); rewind to the first visible record.
      await instrClamp('back');
      expect(await stopAfter(dc.stepInRequest(INSTR)), { index: 7, ipRef: '0x7' });
      expect(await stopAfter(dc.stepInRequest(INSTR)), { index: 8, ipRef: '0x9' });
      expect(await stopAfter(dc.stepBackRequest(INSTR)), { index: 7, ipRef: '0x7' });
      expect(await stopAfter(dc.stepBackRequest(INSTR)), { index: 6, ipRef: '0x5' });
      // S3: the entry record is the first visible one — stay put.
      expect(await stopAfter(dc.stepBackRequest(INSTR)), { index: 6, ipRef: '0x5' });
    });

    it('S20/S17: with a single statement stop, a forward statement `next` terminates', async () => {
      await launchAndStop(ADDER);
      // The only statement stop is 29 (:16): the two #[contractimpl] :12 run
      // starts are dropped by S17, so a forward statement `next` has nowhere to
      // go and ends the session (S20) instead of clamping in place.
      assert.ok(
        await stepEndsSession(() => dc.nextRequest(STMT)),
        'expected the sole-stop forward statement next to terminate (S20)',
      );
    });

    it('S3/I5: statement stepBack at the sole run start stays mapped', async () => {
      await launchAndStop(ADDER);
      // Reverse steps CLAMP (S3/S8) — they never terminate, even at the sole stop.
      const stop = await stopAfter(dc.stepBackRequest(STMT));
      expect(stop, { index: 29, line: 16, col: 9, file: ADDER_LIB_SUFFIX });
    });

    it('I4/S12/S13: a lib.rs:16 breakpoint stops once per execution, symmetric in reverse', async () => {
      await launchWithBreakpoints(ADDER, ADDER_LIB, [16]);
      // Entry already sits on the :16 run start (29); rewind to the trace head,
      // then continue forward to hit the breakpoint once (not once per record).
      await instrClamp('back');
      expect(await stopAfter(dc.continueRequest(THREAD), 'breakpoint'), {
        index: 29,
        line: 16,
        ipRef: '0x2d',
      });
      // S14: nothing ahead — settle on the last stop point (the sole :16 stop).
      expect(await stopAfter(dc.continueRequest(THREAD)), { index: 29, line: 16 });
      // Move forward off the run start, then reverse-continue lands on the same
      // run START (29), not the run end (33).
      await instrClamp('in');
      expect(await stopAfter(dc.reverseContinueRequest(THREAD), 'breakpoint'), {
        index: 29,
        line: 16,
        ipRef: '0x2d',
      });
      // S14/I6: nothing behind — settle on the first stop point, plain stop.
      expect(await stopAfter(dc.reverseContinueRequest(THREAD)), { index: 29, line: 16 });
    });

    it('I6/S14: continue without breakpoints settles on the sole statement stop', async () => {
      await launchAndStop(ADDER);
      // The single :16 statement stop is both the first and last stop point, so
      // continue and reverse-continue both settle there (never the shim ends).
      expect(await stopAfter(dc.continueRequest(THREAD)), { index: 29, line: 16 });
      expect(await stopAfter(dc.reverseContinueRequest(THREAD)), { index: 29, line: 16 });
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
