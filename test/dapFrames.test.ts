/**
 * DAP-level suite for the Callstack view (docs/callstack.md, C1–C8), driven over
 * the real adapter by @vscode/debugadapter-testsupport.
 *
 * test/callStack.test.ts pins the frame derivation at the pure level; this suite
 * pins what a DAP CLIENT sees: how many frames it gets, how they are labelled and
 * hinted, what paging returns, and — the part a call stack is actually FOR — that
 * selecting an outer frame inspects that frame's state and not the innermost
 * one's.
 */

import * as assert from 'assert';
import * as path from 'path';
import { DebugClient } from '@vscode/debugadapter-testsupport';
import { DebugProtocol } from '@vscode/debugprotocol';

const ADAPTER = path.join(__dirname, 'support', 'adapterEntry.js');
const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');

const STEPPER = {
  rawTrace: path.join(FIXTURES, 'stepper-debug.trace.jsonl'),
  wasmPath: path.join(FIXTURES, 'stepper-debug.wasm'),
};
const ADDER = {
  rawTrace: path.join(FIXTURES, 'adder-debug.trace.jsonl'),
  wasmPath: path.join(FIXTURES, 'adder-debug.wasm'),
};
const ADDER_RAW = { rawTrace: ADDER.rawTrace };
const INCREMENT = {
  rawTrace: path.join(FIXTURES, 'increment-debug.trace.jsonl'),
  wasmPath: path.join(FIXTURES, 'increment-debug.wasm'),
};

const THREAD = { threadId: 1 };
const STMT = { ...THREAD, granularity: 'statement' as const };

describe('Callstack view (docs/callstack.md, DAP level)', () => {
  let dc: DebugClient;

  beforeEach(async () => {
    dc = new DebugClient('node', ADAPTER, 'soroban');
    await dc.start();
  });

  afterEach(async () => {
    await dc.stop();
  });

  /** Launch and wait for the entry stop. */
  async function launchAndStop(launchArgs: object): Promise<void> {
    const [, , stopped] = await Promise.all([
      dc.configurationSequence(),
      dc.launch(launchArgs as never),
      dc.waitForEvent('stopped'),
    ]);
    assert.strictEqual((stopped as DebugProtocol.StoppedEvent).body.reason, 'entry');
  }

  async function stopAfter(request: Promise<unknown>): Promise<void> {
    await Promise.all([request, dc.waitForEvent('stopped')]);
  }

  async function frames(args: object = {}): Promise<DebugProtocol.StackTraceResponse> {
    return dc.stackTraceRequest({ ...THREAD, ...args });
  }

  /** `name @ file:line` per frame. */
  function outline(response: DebugProtocol.StackTraceResponse): string[] {
    return response.body.stackFrames.map(
      (f) => `${f.name} @ ${f.source ? `${path.basename(f.source.path ?? '')}:${f.line}` : '-'}`,
    );
  }

  /** The scopes of one frame, by frame id. */
  async function scopesOf(frameId: number): Promise<DebugProtocol.Scope[]> {
    return (await dc.scopesRequest({ frameId })).body.scopes;
  }

  /** `name=value` for every variable of a named scope of a frame. */
  async function scopeContents(frameId: number, scope: string): Promise<string[]> {
    const found = (await scopesOf(frameId)).find((s) => s.name === scope);
    assert.ok(found, `frame ${frameId} offers no ${scope} scope`);
    const res = await dc.variablesRequest({ variablesReference: found.variablesReference });
    return res.body.variables.map((v) => `${v.name}=${v.value}`);
  }

  describe('the stack a client receives (C1, C2, C6)', () => {
    it('reports the whole Rust chain, innermost first, with totalFrames', async () => {
      await launchAndStop(STEPPER);
      // Entry stop is lib.rs:25 in `sum_triples`, which is INLINED into the
      // export wrapper: one activation, three frames.
      const res = await frames();
      assert.deepStrictEqual(outline(res), [
        'sum_triples @ lib.rs:25',
        'invoke_raw @ lib.rs:20',
        'stepper::__sum_triples::invoke_raw_extern @ lib.rs:20',
      ]);
      assert.strictEqual(res.body.totalFrames, 3);
    });

    it('grows by a frame when stepping into a real call, and shows the call site', async () => {
      await launchAndStop(STEPPER);
      // :25 -> :26 (the call line) -> into `triple`.
      await stopAfter(dc.nextRequest(STMT));
      await stopAfter(dc.stepInRequest(STMT));
      assert.deepStrictEqual(outline(await frames()), [
        'stepper::triple @ lib.rs:15',
        'sum_triples @ lib.rs:26',
        'invoke_raw @ lib.rs:20',
        'stepper::__sum_triples::invoke_raw_extern @ lib.rs:20',
      ]);
    });

    it('gives every frame a distinct id and its own instruction pointer (C6)', async () => {
      await launchAndStop(STEPPER);
      await stopAfter(dc.nextRequest(STMT));
      await stopAfter(dc.stepInRequest(STMT));
      const stack = (await frames()).body.stackFrames;
      assert.strictEqual(new Set(stack.map((f) => f.id)).size, stack.length);
      for (const frame of stack) {
        assert.match(frame.instructionPointerReference ?? '', /^0x[0-9a-f]+$/);
      }
      // The callee runs in `triple`'s body; its caller is suspended at the call.
      assert.notStrictEqual(
        stack[0].instructionPointerReference,
        stack[1].instructionPointerReference,
      );
    });

    it('honors the client’s paging window (C6)', async () => {
      await launchAndStop(STEPPER);
      const full = (await frames()).body.stackFrames;
      const page = await frames({ startFrame: 1, levels: 1 });
      assert.strictEqual(page.body.stackFrames.length, 1);
      assert.strictEqual(page.body.totalFrames, full.length);
      assert.strictEqual(page.body.stackFrames[0].id, full[1].id);
      assert.strictEqual(page.body.stackFrames[0].name, full[1].name);
    });

    it('reports the same frame for the same id across requests (C6)', async () => {
      await launchAndStop(STEPPER);
      const first = (await frames()).body.stackFrames;
      const again = (await frames()).body.stackFrames;
      assert.deepStrictEqual(
        again.map((f) => [f.id, f.name, f.line]),
        first.map((f) => [f.id, f.name, f.line]),
      );
    });

    it('reports the line’s first non-whitespace column on every mapped frame (S19)', async () => {
      await launchAndStop(STEPPER);
      for (const frame of (await frames()).body.stackFrames) {
        if (frame.source) {
          assert.ok(frame.column > 0, `frame ${frame.name} reports column ${frame.column}`);
        }
      }
    });
  });

  describe('presentation (C3, C5, C8)', () => {
    it('carries the recording position in the thread label, not a frame name', async () => {
      await launchAndStop(ADDER);
      const threads = await dc.threadsRequest();
      assert.match(threads.body.threads[0].name, /^soroban-vm \[\d+\/40\]$/);
      for (const frame of (await frames()).body.stackFrames) {
        assert.ok(
          !/\[\d+\/\d+\]/.test(frame.name),
          `a frame name must not carry the cursor: ${frame.name}`,
        );
      }
    });

    it('updates the thread label as the cursor moves', async () => {
      await launchAndStop(ADDER);
      const before = (await dc.threadsRequest()).body.threads[0].name;
      await stopAfter(dc.stepBackRequest({ ...THREAD, granularity: 'instruction' }));
      assert.notStrictEqual((await dc.threadsRequest()).body.threads[0].name, before);
    });

    it('labels a contract boundary as such and hangs it below the code frames (C3)', async () => {
      await launchAndStop(INCREMENT);
      const stack = (await frames()).body.stackFrames;
      const boundary = stack.filter((f) => f.presentationHint === 'label');
      assert.strictEqual(boundary.length, 1, `expected one boundary frame in: ${outline({ body: { stackFrames: stack } } as never).join(' | ')}`);
      assert.match(boundary[0].name, /^\w+\(\) @ /);
      assert.strictEqual(stack[stack.length - 1].id, boundary[0].id);
      assert.strictEqual(boundary[0].source, undefined);
    });

    it('deemphasizes a frame outside the workspace, without hiding it (C5)', async () => {
      // Instruction-stepping into the SDK's conversion glue reaches frames whose
      // source is a crates.io path that does not exist on this machine.
      await launchAndStop(INCREMENT);
      const seen: DebugProtocol.StackFrame[] = [];
      for (let i = 0; i < 40 && seen.length === 0; i++) {
        const stack = (await frames()).body.stackFrames;
        seen.push(...stack.filter((f) => f.presentationHint === 'subtle'));
        await stopAfter(dc.stepInRequest({ ...THREAD, granularity: 'instruction' }));
      }
      assert.ok(seen.length > 0, 'expected at least one deemphasized frame while stepping');
      for (const frame of seen) {
        assert.notStrictEqual(frame.name, '', 'a deemphasized frame is still named');
      }
    });

    it('offers one addressed frame and no source when there is no wasm at all (C4)', async () => {
      await launchAndStop(ADDER_RAW);
      const stack = (await frames()).body.stackFrames;
      assert.strictEqual(stack.length, 1);
      assert.match(stack[0].name, /^wasm@0x[0-9a-f]+$/);
      assert.strictEqual(stack[0].source, undefined);
      assert.strictEqual(stack[0].line, 0);
    });
  });

  describe('inspecting a selected frame (C7)', () => {
    it('reads an outer frame’s wasm locals from that frame’s own record', async () => {
      await launchAndStop(STEPPER);
      await stopAfter(dc.nextRequest(STMT));
      await stopAfter(dc.stepInRequest(STMT));
      const stack = (await frames()).body.stackFrames;

      const callee = await scopeContents(stack[0].id, 'Locals');
      const caller = await scopeContents(stack[1].id, 'Locals');
      assert.notDeepStrictEqual(
        caller,
        callee,
        `the caller must not report the callee's locals: ${callee.join(', ')}`,
      );
      // `triple(x)` has one local; `sum_triples` is mid-loop with several.
      assert.ok(callee.length >= 1 && caller.length > callee.length, `${callee.length} vs ${caller.length}`);
    });

    it('shows each frame’s own Rust variables', async () => {
      await launchAndStop(STEPPER);
      await stopAfter(dc.nextRequest(STMT));
      await stopAfter(dc.stepInRequest(STMT));
      const stack = (await frames()).body.stackFrames;

      // `triple`'s parameter is `x`; the frame below it is `sum_triples`, which
      // has no `x` of its own.
      const callee = await scopeContents(stack[0].id, 'Variables');
      assert.ok(
        callee.some((v) => v.startsWith('x=')),
        `expected x among triple's variables, got: ${callee.join(', ')}`,
      );
      const caller = await scopeContents(stack[1].id, 'Variables');
      assert.ok(
        !caller.some((v) => v.startsWith('x=')),
        `the caller must not report the callee's x, got: ${caller.join(', ')}`,
      );
    });

    it('offers the VM-wide scopes on every code frame', async () => {
      await launchAndStop(INCREMENT);
      const stack = (await frames()).body.stackFrames;
      for (const frame of stack.filter((f) => f.presentationHint !== 'label')) {
        const names = (await scopesOf(frame.id)).map((s) => s.name);
        assert.ok(names.includes('Ledger'), `frame ${frame.name} offers: ${names.join(', ')}`);
        assert.ok(names.includes('Locals'), `frame ${frame.name} offers: ${names.join(', ')}`);
      }
    });

    it('offers nothing to inspect on a contract boundary (C3)', async () => {
      await launchAndStop(INCREMENT);
      const stack = (await frames()).body.stackFrames;
      const boundary = stack.find((f) => f.presentationHint === 'label');
      assert.ok(boundary, 'expected a boundary frame');
      assert.deepStrictEqual(await scopesOf(boundary.id), []);
    });

    it('keeps a frame’s children expandable after another frame is selected', async () => {
      // Handles are reset per STOP, not per scopes request: a client that expands
      // frame 0, selects frame 1, and comes back must not get an empty tree.
      await launchAndStop(STEPPER);
      await stopAfter(dc.nextRequest(STMT));
      await stopAfter(dc.stepInRequest(STMT));
      const stack = (await frames()).body.stackFrames;

      const scope = (await scopesOf(stack[0].id)).find((s) => s.name === 'Locals');
      assert.ok(scope);
      const before = await dc.variablesRequest({ variablesReference: scope.variablesReference });
      await scopesOf(stack[1].id);
      const after = await dc.variablesRequest({ variablesReference: scope.variablesReference });
      assert.deepStrictEqual(after.body.variables, before.body.variables);
    });
  });
});
