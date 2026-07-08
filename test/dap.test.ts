import * as assert from 'assert';
import * as path from 'path';
import { DebugClient } from '@vscode/debugadapter-testsupport';
import { DebugProtocol } from '@vscode/debugprotocol';

const ADAPTER = path.join(__dirname, 'support', 'adapterEntry.js');
const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const ADDER_TRACE = path.join(FIXTURES, 'adder-debug.trace.jsonl');
const ADDER_WASM = path.join(FIXTURES, 'adder-debug.wasm');
const ADD_TRACE = path.join(FIXTURES, 'add.trace.jsonl');

/** The real contract source the fixture's DWARF resolves to. */
const LIB_RS = path.join(__dirname, '..', '..', 'examples', 'adder', 'src', 'lib.rs');
const LIB_RS_SUFFIX = 'examples/adder/src/lib.rs';

const WITH_WASM = { rawTrace: ADDER_TRACE, wasmPath: ADDER_WASM };
const NO_WASM = { rawTrace: ADDER_TRACE };
const THREAD = { threadId: 1 };

describe('SorobanDebugSession (DAP replay)', () => {
  let dc: DebugClient;

  beforeEach(async () => {
    dc = new DebugClient('node', ADAPTER, 'soroban');
    await dc.start();
  });

  afterEach(async () => {
    await dc.stop();
  });

  /** Launch and wait for the entry stop, registering the listener up front. */
  async function launchAndStop(launchArgs: object): Promise<void> {
    const [, , stopped] = await Promise.all([
      dc.configurationSequence(),
      dc.launch(launchArgs as any),
      dc.waitForEvent('stopped'),
    ]);
    assert.strictEqual((stopped as DebugProtocol.StoppedEvent).body.reason, 'entry');
  }

  /**
   * Launch, set breakpoints on LIB_RS once the adapter signals readiness
   * (InitializedEvent), finish configuration, and wait for the entry stop.
   */
  async function launchWithBreakpoints(
    launchArgs: object,
    lines: number[],
  ): Promise<DebugProtocol.SetBreakpointsResponse> {
    let bpResponse: DebugProtocol.SetBreakpointsResponse | undefined;
    await Promise.all([
      dc.launch(launchArgs as any),
      dc.waitForEvent('initialized').then(async () => {
        bpResponse = await dc.setBreakpointsRequest({
          source: { path: LIB_RS },
          breakpoints: lines.map((line) => ({ line })),
        });
        await dc.configurationDoneRequest();
      }),
      dc.waitForEvent('stopped'),
    ]);
    assert.ok(bpResponse, 'expected a setBreakpoints response');
    return bpResponse;
  }

  async function topFrame(): Promise<DebugProtocol.StackFrame> {
    const res = await dc.stackTraceRequest(THREAD);
    assert.ok(res.body.stackFrames.length >= 1, 'expected at least one stack frame');
    return res.body.stackFrames[0];
  }

  /** Send a request and wait for the resulting stop, asserting its reason. */
  async function stopAfter(request: Promise<unknown>, reason: string): Promise<void> {
    const [, stopped] = await Promise.all([request, dc.waitForEvent('stopped')]);
    assert.strictEqual((stopped as DebugProtocol.StoppedEvent).body.reason, reason);
  }

  it('advertises reverse debugging and stepping granularity', async () => {
    const res = await dc.initializeRequest();
    assert.strictEqual(res.body?.supportsStepBack, true);
    assert.strictEqual(res.body?.supportsSteppingGranularity, true);
    assert.strictEqual(res.body?.supportsTerminateRequest, true);
  });

  describe('breakpointLocations', () => {
    /** The DebugClient has no typed helper for this request; go via customRequest. */
    async function breakpointLocations(
      args: DebugProtocol.BreakpointLocationsArguments,
    ): Promise<DebugProtocol.BreakpointLocationsResponse> {
      return (await dc.customRequest(
        'breakpointLocations',
        args,
      )) as DebugProtocol.BreakpointLocationsResponse;
    }

    it('advertises the breakpointLocations request', async () => {
      const res = await dc.initializeRequest();
      assert.strictEqual(res.body?.supportsBreakpointLocationsRequest, true);
    });

    it('lists exactly the executed lib.rs lines in a range, ascending', async () => {
      await launchAndStop(WITH_WASM);
      // Only lines 12 and 16 of lib.rs carry executed code in the fixture trace.
      const res = await breakpointLocations({ source: { path: LIB_RS }, line: 1, endLine: 20 });
      assert.deepStrictEqual(res.body.breakpoints, [{ line: 12 }, { line: 16 }]);
    });

    it('treats a missing endLine as the single requested line', async () => {
      await launchAndStop(WITH_WASM);
      const res = await breakpointLocations({ source: { path: LIB_RS }, line: 16 });
      assert.deepStrictEqual(res.body.breakpoints, [{ line: 16 }]);
    });

    it('is empty for a range without executed code (no forward slide)', async () => {
      await launchAndStop(WITH_WASM);
      const res = await breakpointLocations({ source: { path: LIB_RS }, line: 13, endLine: 15 });
      assert.deepStrictEqual(res.body.breakpoints, []);
    });

    it('is empty without wasm (no line info)', async () => {
      await launchAndStop(NO_WASM);
      const res = await breakpointLocations({ source: { path: LIB_RS }, line: 1, endLine: 99 });
      assert.deepStrictEqual(res.body.breakpoints, []);
    });
  });

  describe('with DWARF symbols (rawTrace + wasmPath)', () => {
    it('stops at entry on the first line-run start with a mapped frame (S1/I3)', async () => {
      await launchAndStop(WITH_WASM);
      // Records 0..5 are invisible (unvalidated global initializers and
      // pos-null synthetics): the entry stop skips them and lands on record 6,
      // the first run start (lib.rs:12), with a real instruction pointer.
      const frame = await topFrame();
      assert.ok(frame.source?.path?.endsWith(LIB_RS_SUFFIX), `unexpected source: ${frame.source?.path}`);
      assert.strictEqual(frame.line, 12);
      assert.ok(frame.name.includes('[6/40]'), `unexpected frame name: ${frame.name}`);
      assert.strictEqual(frame.instructionPointerReference, '0x5');
    });

    it('verifies, forward-slides, and rejects Rust-line breakpoints', async () => {
      const res = await launchWithBreakpoints(WITH_WASM, [16, 13, 99]);
      const bps = res.body.breakpoints;
      assert.strictEqual(bps.length, 3);

      assert.strictEqual(bps[0].verified, true);
      assert.strictEqual(bps[0].line, 16);

      // Lines 13..15 carry no executed code: the breakpoint slides forward.
      assert.strictEqual(bps[1].verified, true);
      assert.strictEqual(bps[1].line, 16);

      assert.strictEqual(bps[2].verified, false);
      assert.strictEqual(bps[2].line, 99);
      assert.strictEqual(bps[2].message, 'No executed code maps to this line in the recorded trace.');
    });

    it('runs to a Rust breakpoint, line-steps off it, and reverse-continues back', async () => {
      await launchWithBreakpoints(WITH_WASM, [16]);

      await stopAfter(dc.continueRequest(THREAD), 'breakpoint');
      let frame = await topFrame();
      assert.ok(frame.source?.path?.endsWith(LIB_RS_SUFFIX), `unexpected source: ${frame.source?.path}`);
      assert.strictEqual(frame.line, 16);
      assert.ok(frame.name.includes('[29/40]'), `unexpected frame name: ${frame.name}`);

      // Statement granularity: one step covers the whole lib.rs:16 run.
      await stopAfter(dc.nextRequest({ ...THREAD, granularity: 'statement' }), 'step');
      frame = await topFrame();
      assert.ok(frame.source?.path?.endsWith(LIB_RS_SUFFIX));
      assert.strictEqual(frame.line, 12);

      // S13: reverse lands on the same run START forward continue used (29),
      // not on the run's last record (33).
      await stopAfter(dc.reverseContinueRequest(THREAD), 'breakpoint');
      frame = await topFrame();
      assert.strictEqual(frame.line, 16);
      assert.ok(frame.name.includes('[29/40]'), `unexpected frame name: ${frame.name}`);
    });

    it('default-granularity next steps by Rust line', async () => {
      await launchAndStop(WITH_WASM);
      // The entry stop is already the lib.rs:12 run start (S1); a default-
      // granularity next moves to the next run start, lib.rs:16 (record 29).
      await stopAfter(dc.nextRequest(THREAD), 'step');
      const frame = await topFrame();
      assert.ok(frame.source?.path?.endsWith(LIB_RS_SUFFIX), `unexpected source: ${frame.source?.path}`);
      assert.strictEqual(frame.line, 16);
      assert.ok(frame.name.includes('[29/40]'), `unexpected frame name: ${frame.name}`);
    });

    it('instruction-granularity stepIn advances exactly one record', async () => {
      await launchAndStop(WITH_WASM);
      const entry = await topFrame();
      assert.ok(entry.name.includes('[6/40]'), `unexpected entry frame name: ${entry.name}`);

      await stopAfter(dc.stepInRequest({ ...THREAD, granularity: 'instruction' }), 'step');
      const frame = await topFrame();
      assert.notStrictEqual(frame.name, entry.name);
      assert.ok(frame.name.includes('[7/40]'), `unexpected frame name: ${frame.name}`);
      // Record 7 is still inside the lib.rs:12 run (S16).
      assert.strictEqual(frame.line, 12);
    });
  });

  describe('without wasm (rawTrace only, instruction-level fallback)', () => {
    it('frames carry no Source and Rust-line breakpoints do not verify', async () => {
      const res = await launchWithBreakpoints(NO_WASM, [16]);
      assert.strictEqual(res.body.breakpoints[0].verified, false);

      const frame = await topFrame();
      assert.strictEqual(frame.source, undefined);
      assert.strictEqual(frame.line, 0);
    });

    it('still steps at instruction level, both directions', async () => {
      await launchAndStop(NO_WASM);

      await stopAfter(dc.stepInRequest(THREAD), 'step');
      let frame = await topFrame();
      assert.ok(frame.name.includes('[1/40]'), `unexpected frame name: ${frame.name}`);
      assert.strictEqual(frame.source, undefined);

      await stopAfter(dc.stepBackRequest(THREAD), 'step');
      frame = await topFrame();
      assert.ok(frame.name.includes('[0/40]'), `unexpected frame name: ${frame.name}`);
    });

    it('exposes locals and value stack at the cursor', async () => {
      await launchAndStop({ rawTrace: ADD_TRACE });
      const frame = await topFrame();
      const scopes = await dc.scopesRequest({ frameId: frame.id });
      const names = scopes.body.scopes.map((s) => s.name);
      assert.deepStrictEqual(names, ['Locals', 'Value Stack']);

      const localsRef = scopes.body.scopes[0].variablesReference;
      const locals = await dc.variablesRequest({ variablesReference: localsRef });
      const local0 = locals.body.variables.find((v) => v.name === 'local[0]');
      assert.ok(local0, 'expected local[0]');
      assert.strictEqual(local0!.type, 'i64');
      assert.strictEqual(local0!.value, '4');
    });

    it('terminateRequest emits a TerminatedEvent', async () => {
      await launchAndStop(NO_WASM);
      await Promise.all([dc.terminateRequest({}), dc.waitForEvent('terminated')]);
    });
  });

  describe('Disassembly View (instructionPointerReference + disassembleRequest)', () => {
    /** Numeric value of a disassembly address, accepting the '-0x' padding form. */
    function addressValue(address: string): number {
      return address.startsWith('-') ? -parseInt(address.slice(1), 16) : parseInt(address, 16);
    }

    /** Strictly increasing addresses (which also makes them unique) — VS Code keys rows by address. */
    function assertStrictlyIncreasing(rows: DebugProtocol.DisassembledInstruction[]): void {
      for (let i = 1; i < rows.length; i++) {
        assert.ok(
          addressValue(rows[i].address) > addressValue(rows[i - 1].address),
          `addresses not strictly increasing at row ${i}: ${rows[i - 1].address} then ${rows[i].address}`,
        );
      }
    }

    /** Run to the lib.rs:16 breakpoint — the `i32.add` record at code offset 0x2d (pos 45). */
    async function runToAdd(): Promise<void> {
      await launchWithBreakpoints(WITH_WASM, [16]);
      await stopAfter(dc.continueRequest(THREAD), 'breakpoint');
    }

    it('advertises the disassemble request', async () => {
      const res = await dc.initializeRequest();
      assert.strictEqual(res.body?.supportsDisassembleRequest, true);
    });

    describe('with wasm', () => {
      it('anchors the entry stop on a validated instruction address (S1/I3)', async () => {
        await launchAndStop(WITH_WASM);
        // The entry stop skips the unvalidated head records (S1), so the very
        // first frame already carries a validated code offset (record 6, 0x5).
        const frame = await topFrame();
        assert.strictEqual(frame.instructionPointerReference, '0x5');
      });

      it('reports the validated code offset of the stopped record', async () => {
        await runToAdd();
        const frame = await topFrame();
        assert.strictEqual(frame.instructionPointerReference, '0x2d');
      });

      it('moves the instruction pointer on instruction-granularity steps', async () => {
        await runToAdd();
        await stopAfter(dc.stepInRequest({ ...THREAD, granularity: 'instruction' }), 'step');
        const frame = await topFrame();
        // The next record is the `local.tee` at pos 46.
        assert.strictEqual(frame.instructionPointerReference, '0x2e');
      });

      it('disassembles an in-range window around the stop address', async () => {
        await runToAdd();
        const res = await dc.disassembleRequest({
          memoryReference: '0x2d',
          instructionOffset: -5,
          instructionCount: 11,
        });
        const rows = res.body?.instructions ?? [];
        assert.strictEqual(rows.length, 11);
        assertStrictlyIncreasing(rows);
        // The adder's code spans offsets ~5..91, so this window is all real rows.
        assert.ok(
          rows.every((r) => r.presentationHint !== 'invalid'),
          'expected no padding rows in an in-range window',
        );

        const middle = rows[5];
        assert.strictEqual(middle.address, '0x2d');
        assert.ok(middle.instruction.startsWith('i32.add'), `unexpected instruction: ${middle.instruction}`);
        assert.strictEqual(middle.instructionBytes, '6a');
        assert.strictEqual(middle.line, 16);
        // The Rust location is on this row or inherited from an earlier one
        // (DAP allows omitting `location` while the file is unchanged).
        const located = rows
          .slice(0, 6)
          .reverse()
          .find((r) => r.location?.path !== undefined);
        assert.ok(
          located?.location?.path?.endsWith(LIB_RS_SUFFIX),
          `unexpected location: ${located?.location?.path}`,
        );
      });

      it('pads a window scrolled above the first instruction with invalid rows', async () => {
        await launchAndStop(WITH_WASM);
        // Address 0x0 precedes the first instruction; the anchor snaps to it.
        const probe = await dc.disassembleRequest({ memoryReference: '0x0', instructionCount: 1 });
        const first = (probe.body?.instructions ?? [])[0];
        assert.ok(first, 'expected the first real instruction');
        assert.notStrictEqual(first.presentationHint, 'invalid');

        const res = await dc.disassembleRequest({
          memoryReference: first.address,
          instructionOffset: -3,
          instructionCount: 6,
        });
        const rows = res.body?.instructions ?? [];
        assert.strictEqual(rows.length, 6);
        for (const row of rows.slice(0, 3)) {
          assert.strictEqual(row.presentationHint, 'invalid');
        }
        assertStrictlyIncreasing(rows);
        assert.strictEqual(rows[3].address, first.address);
        assert.strictEqual(rows[3].instruction, first.instruction);
      });

      it('pads a window past the end of the code section with invalid rows', async () => {
        await launchAndStop(WITH_WASM);
        const res = await dc.disassembleRequest({ memoryReference: '0xffff', instructionCount: 4 });
        const rows = res.body?.instructions ?? [];
        assert.strictEqual(rows.length, 4);
        // 0xffff snaps to the last real instruction; everything after is padding.
        assert.notStrictEqual(rows[0].presentationHint, 'invalid');
        for (const row of rows.slice(1)) {
          assert.strictEqual(row.presentationHint, 'invalid');
        }
        assertStrictlyIncreasing(rows);
      });
    });

    describe('without wasm (trace-derived rows, unvalidated raw positions)', () => {
      it('exposes raw trace positions and disassembles around them', async () => {
        await launchAndStop(NO_WASM);
        // Nothing to validate against: record 0's raw pos 3 is the reference.
        const frame = await topFrame();
        assert.strictEqual(frame.instructionPointerReference, '0x3');

        const res = await dc.disassembleRequest({
          memoryReference: '0x3',
          instructionOffset: -2,
          instructionCount: 5,
        });
        const rows = res.body?.instructions ?? [];
        assert.strictEqual(rows.length, 5);
        // The trace-derived disassembly starts at pos 3: two padding rows first.
        assert.strictEqual(rows[0].presentationHint, 'invalid');
        assert.strictEqual(rows[1].presentationHint, 'invalid');
        assert.strictEqual(rows[2].address, '0x3');
        assert.strictEqual(rows[2].instruction, 'i32.const 1048576');
        assert.notStrictEqual(rows[3].presentationHint, 'invalid');
        assertStrictlyIncreasing(rows);
      });

      it('steps over pos-null records without dead presses (S10/I2)', async () => {
        await launchAndStop(NO_WASM);
        // Records 0..2 carry raw positions 3, 11, 19; records 3..5 are pos-null
        // (invisible even in raw mode). Three instruction steps land on records
        // 1, 2, and 6 — the cursor never rests on an invisible record.
        for (let i = 0; i < 3; i++) {
          await stopAfter(dc.stepInRequest({ ...THREAD, granularity: 'instruction' }), 'step');
        }
        const frame = await topFrame();
        assert.ok(frame.name.includes('[6/40]'), `unexpected frame name: ${frame.name}`);
        assert.strictEqual(frame.instructionPointerReference, '0x5');
      });
    });
  });

  describe('instruction breakpoints', () => {
    /** The DebugClient has no typed helper for this request; go via customRequest. */
    async function setInstructionBreakpoints(
      breakpoints: DebugProtocol.InstructionBreakpoint[],
    ): Promise<DebugProtocol.SetInstructionBreakpointsResponse> {
      const args: DebugProtocol.SetInstructionBreakpointsArguments = { breakpoints };
      return (await dc.customRequest(
        'setInstructionBreakpoints',
        args,
      )) as DebugProtocol.SetInstructionBreakpointsResponse;
    }

    it('advertises instruction breakpoints', async () => {
      const res = await dc.initializeRequest();
      assert.strictEqual(res.body?.supportsInstructionBreakpoints, true);
    });

    it('verifies a breakpoint on an executed instruction and stops there, both directions', async () => {
      await launchAndStop(WITH_WASM);
      // 0x2d is the `i32.add` record (pos 45), a validated executed instruction.
      const res = await setInstructionBreakpoints([{ instructionReference: '0x2d' }]);
      assert.strictEqual(res.body.breakpoints.length, 1);
      assert.strictEqual(res.body.breakpoints[0].verified, true);

      await stopAfter(dc.continueRequest(THREAD), 'breakpoint');
      let frame = await topFrame();
      assert.strictEqual(frame.instructionPointerReference, '0x2d');

      // Step past it, then reverse-continue lands on it again.
      await stopAfter(dc.stepInRequest({ ...THREAD, granularity: 'instruction' }), 'step');
      await stopAfter(dc.reverseContinueRequest(THREAD), 'breakpoint');
      frame = await topFrame();
      assert.strictEqual(frame.instructionPointerReference, '0x2d');
    });

    it('rejects an address with no validated executed instruction and never stops on it', async () => {
      await launchAndStop(WITH_WASM);
      // Code offset 3 holds no instruction (the first is at 5), and the trace
      // records carrying RAW pos 3 are unvalidated global-initializer records
      // in another section's address space — they must not verify it.
      const res = await setInstructionBreakpoints([{ instructionReference: '0x3' }]);
      assert.strictEqual(res.body.breakpoints.length, 1);
      assert.strictEqual(res.body.breakpoints[0].verified, false);
      assert.strictEqual(
        res.body.breakpoints[0].message,
        'No executed instruction at this address in the recorded trace.',
      );

      // With only that breakpoint set, continue runs to the trace end.
      await stopAfter(dc.continueRequest(THREAD), 'step');
      const frame = await topFrame();
      assert.ok(frame.name.includes('[40/40]'), `unexpected frame name: ${frame.name}`);
    });

    it('triggers on the validated record at an address, not a raw global-init pos', async () => {
      await launchAndStop(WITH_WASM);
      // Raw pos 11 appears twice: record 1 is an unvalidated global-initializer
      // record, record 9 is the validated `i64.const 255` inside function code.
      // Only the validated record may trigger the breakpoint.
      const res = await setInstructionBreakpoints([{ instructionReference: '0xb' }]);
      assert.strictEqual(res.body.breakpoints[0].verified, true);

      await stopAfter(dc.continueRequest(THREAD), 'breakpoint');
      const frame = await topFrame();
      assert.strictEqual(frame.instructionPointerReference, '0xb');
      assert.ok(frame.name.includes('[9/40]'), `unexpected frame name: ${frame.name}`);
      // Function code maps to Rust; the global-init record has no source.
      assert.ok(
        frame.source?.path?.endsWith(LIB_RS_SUFFIX),
        `unexpected source: ${frame.source?.path}`,
      );
    });

    it('combines with source breakpoints', async () => {
      await launchWithBreakpoints(WITH_WASM, [16]);
      const res = await setInstructionBreakpoints([{ instructionReference: '0xb' }]);
      assert.strictEqual(res.body.breakpoints[0].verified, true);

      // The 0xb record (index 9) precedes the lib.rs:16 record (i32.add).
      await stopAfter(dc.continueRequest(THREAD), 'breakpoint');
      let frame = await topFrame();
      assert.strictEqual(frame.instructionPointerReference, '0xb');

      await stopAfter(dc.continueRequest(THREAD), 'breakpoint');
      frame = await topFrame();
      assert.strictEqual(frame.line, 16);
      assert.ok(
        frame.source?.path?.endsWith(LIB_RS_SUFFIX),
        `unexpected source: ${frame.source?.path}`,
      );
    });

    it('replaces the breakpoint list wholesale: an empty request clears them', async () => {
      await launchAndStop(WITH_WASM);
      const set = await setInstructionBreakpoints([{ instructionReference: '0xb' }]);
      assert.strictEqual(set.body.breakpoints[0].verified, true);

      const cleared = await setInstructionBreakpoints([]);
      assert.deepStrictEqual(cleared.body.breakpoints, []);

      await stopAfter(dc.continueRequest(THREAD), 'step');
      const frame = await topFrame();
      assert.ok(frame.name.includes('[40/40]'), `unexpected frame name: ${frame.name}`);
    });

    it('applies the offset field to the instruction reference', async () => {
      await launchAndStop(WITH_WASM);
      // 0x2d + 1 = 0x2e, the validated `local.tee` record.
      const res = await setInstructionBreakpoints([{ instructionReference: '0x2d', offset: 1 }]);
      assert.strictEqual(res.body.breakpoints[0].verified, true);

      await stopAfter(dc.continueRequest(THREAD), 'breakpoint');
      const frame = await topFrame();
      assert.strictEqual(frame.instructionPointerReference, '0x2e');
    });
  });
});
