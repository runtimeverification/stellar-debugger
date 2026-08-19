/**
 * Unit suite for the call stack (docs/callstack.md):
 *
 *   buildCallStack({ resolved, frames, ranges }, index): CallFrame[]
 *     from src/debugAdapter/callStack.ts
 *
 * Values are pinned to the real fixtures, whose stacks are ground truth:
 *   - adder-debug (above opt-0): `add` is fully INLINED into the
 *     `#[contractimpl]` wrapper, so the whole Rust chain is inline frames (C2).
 *   - stepper-debug: `triple` is a REAL call (`#[inline(never)]`) whose caller
 *     `sum_triples` is itself inlined — a mixed physical/inline stack (C1 + C2).
 *   - control-debug (opt-0): `bump` called from `Control::while_call`, both real
 *     wasm functions — the case where activations alone carry the Rust chain.
 *   - the same traces replayed with NO wasm — the degraded ladder (C4).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { buildCallStack, CallFrame } from '../src/debugAdapter/callStack';
import { buildStopModel } from '../src/debugAdapter/stopModel';
import { RawTraceBackend } from '../src/debugAdapter/backends/RawTraceBackend';
import { ResolvedTrace } from '../src/debugAdapter/types';
import { parseTraceJsonl, toTraceRecord, TraceRecord } from '../src/komet/trace';
import { TraceModel } from '../src/debugAdapter/TraceModel';
import { Disassembly } from '../src/wasm/Disassembly';
import { NullSourceMapper } from '../src/sourcemap/NullSourceMapper';
import { NullVariableResolver } from '../src/sourcemap/VariableResolver';
import { buildDebugArtifacts } from '../src/debugAdapter/artifacts';
import { stripDebugSections } from '../src/wasm/sections';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');

/** Resolve a fixture trace, with its wasm (symbol-rich) or without (degraded). */
async function resolveFixture(trace: string, wasm?: string): Promise<ResolvedTrace> {
  const args: Record<string, string> = { rawTrace: path.join(FIXTURES, `${trace}.trace.jsonl`) };
  if (wasm !== undefined) {
    args.wasmPath = path.join(FIXTURES, `${wasm}.wasm`);
  }
  return new RawTraceBackend().resolve(args as never, () => {});
}

/** The call stack at `index`, via the shared stop model. */
function stackAt(resolved: ResolvedTrace, index: number): CallFrame[] {
  const stops = buildStopModel(resolved);
  return buildCallStack({ resolved, frames: stops.frames, ranges: stops.ranges }, index);
}

/** `name @ file:line` per frame — the shape a reader of the view sees. */
function outline(frames: CallFrame[]): string[] {
  return frames.map(
    (f) => `${f.name} @ ${f.source === null ? '-' : `${path.basename(f.source.path)}:${f.source.line}`}`,
  );
}

describe('buildCallStack (docs/callstack.md)', () => {
  describe('adder-debug: a fully inlined Rust chain (C2)', () => {
    let resolved: ResolvedTrace;
    before(async () => {
      resolved = await resolveFixture('adder-debug', 'adder-debug');
    });

    it('reports the inlined callee, its inliner, and the wasm activation', () => {
      // Index 29 is the sole statement stop, lib.rs:16 (`a + b`) at pc 0x2d. The
      // ONLY wasm activation there is the export wrapper; `add` and the macro's
      // `invoke_raw` exist only as DWARF inline instances.
      assert.deepStrictEqual(outline(stackAt(resolved, 29)), [
        'add @ lib.rs:16',
        'invoke_raw @ lib.rs:12',
        'adder::__add::invoke_raw_extern @ lib.rs:12',
      ]);
    });

    it('marks the inline frames as such and the activation as a rust frame (C1/C2)', () => {
      const frames = stackAt(resolved, 29);
      assert.deepStrictEqual(
        frames.map((f) => f.kind),
        ['inline', 'inline', 'rust'],
      );
      assert.deepStrictEqual(
        frames.map((f) => f.level),
        [0, 1, 2],
      );
    });

    it('positions every frame at the same pc but at its own source line (C2)', () => {
      // Inlined code has ONE pc; what differs per frame is where the call was
      // written. The innermost frame stands on the line the line table names, the
      // outer ones on their callee's call site.
      const frames = stackAt(resolved, 29);
      assert.deepStrictEqual(
        frames.map((f) => f.pc),
        [0x2d, 0x2d, 0x2d],
      );
      assert.deepStrictEqual(
        frames.map((f) => f.source?.line),
        [16, 12, 12],
      );
    });

    it('reads every frame’s state from the same record when nothing was called', () => {
      for (const frame of stackAt(resolved, 29)) {
        assert.strictEqual(frame.stateIndex, 29);
      }
    });

    it('treats workspace frames as prominent (C5)', () => {
      assert.deepStrictEqual(
        stackAt(resolved, 29).map((f) => f.subtle),
        [false, false, false],
      );
    });
  });

  describe('stepper-debug: a real call under an inlined caller (C1 + C2)', () => {
    let resolved: ResolvedTrace;
    before(async () => {
      resolved = await resolveFixture('stepper-debug', 'stepper-debug');
    });

    it('shows the callee, the CALL SITE of its caller, and the wrapper chain', () => {
      // Index 29 is inside `triple` (depth 1), called from lib.rs:26
      // `acc.wrapping_add(triple(i))`. The caller frame must stand on line 26 —
      // the call it is suspended in — not on `sum_triples`' own first line.
      assert.deepStrictEqual(outline(stackAt(resolved, 29)), [
        'stepper::triple @ lib.rs:15',
        'sum_triples @ lib.rs:26',
        'invoke_raw @ lib.rs:20',
        'stepper::__sum_triples::invoke_raw_extern @ lib.rs:20',
      ]);
    });

    it('reads an outer frame’s state from its own call instruction (C7)', () => {
      const frames = stackAt(resolved, 29);
      // The callee's state is the cursor's record; the caller's is the record of
      // the `call` that entered it (28), where its locals were last observed.
      assert.deepStrictEqual(
        frames.map((f) => f.stateIndex),
        [29, 28, 28, 28],
      );
    });

    it('has no caller frames at all before any call is made', () => {
      // Index 21 (lib.rs:25, the `while`) runs at depth 0: one activation.
      const frames = stackAt(resolved, 21);
      assert.strictEqual(frames.filter((f) => f.kind !== 'inline').length, 1);
      assert.deepStrictEqual(outline(frames), [
        'sum_triples @ lib.rs:25',
        'invoke_raw @ lib.rs:20',
        'stepper::__sum_triples::invoke_raw_extern @ lib.rs:20',
      ]);
    });

    it('agrees with the stepping depth about how deep the stack is', () => {
      // The Callstack view and step-over/step-out are derived from the SAME frame
      // reconstruction, so the number of activations is depth + 1 (C1).
      const stops = buildStopModel(resolved);
      for (const index of [21, 27, 29, 46, 63, 73]) {
        const frames = buildCallStack(
          { resolved, frames: stops.frames, ranges: stops.ranges },
          index,
        );
        const activations = frames.filter((f) => f.kind !== 'inline' && f.kind !== 'contract');
        assert.strictEqual(
          activations.length,
          stops.depths[index] + 1,
          `index ${index}: ${activations.length} activations at depth ${stops.depths[index]}`,
        );
      }
    });
  });

  describe('control-debug: opt-0, where activations carry the Rust chain (C1)', () => {
    let resolved: ResolvedTrace;
    before(async () => {
      resolved = await resolveFixture('control-while_call', 'control-debug');
    });

    it('shows a real callee over its real caller, each on its own line', () => {
      // Index 266 is `bump`'s body (lib.rs:16) at depth 3, called from
      // `while_call` at lib.rs:56.
      assert.deepStrictEqual(outline(stackAt(resolved, 266)), [
        'control::bump @ lib.rs:16',
        'control::Control::while_call @ lib.rs:56',
        'control::__while_call::invoke_raw @ lib.rs:20',
        'control::__while_call::invoke_raw_extern @ lib.rs:20',
      ]);
    });

    it('names a frame whose DWARF DIE is anonymous from the name section (C4)', () => {
      // rustc leaves `Control::while_call`'s subprogram DIE unnamed; the demangled
      // `name`-section symbol is the next rung of the ladder, and the frame is
      // still located by DWARF, so it stays a rust frame.
      const frame = stackAt(resolved, 266)[1];
      assert.strictEqual(frame.name, 'control::Control::while_call');
      assert.strictEqual(frame.kind, 'rust');
    });

    it('exposes each frame’s own variables (C7)', () => {
      const frames = stackAt(resolved, 266);
      const names = (frame: CallFrame): string[] =>
        frame.variables.map((v) => v.name ?? '<anon>');
      assert.deepStrictEqual(names(frames[0]), ['x']);
      // The caller's own locals, not the callee's.
      for (const expected of ['n', 'acc', 'i']) {
        assert.ok(
          names(frames[1]).includes(expected),
          `expected ${expected} among the caller's variables, got: ${names(frames[1]).join(', ')}`,
        );
      }
      assert.ok(!names(frames[1]).includes('x'), 'the caller must not report the callee’s x');
    });
  });

  describe('no wasm at all: the degraded ladder (C4)', () => {
    let resolved: ResolvedTrace;
    before(async () => {
      resolved = await resolveFixture('adder-debug');
    });

    it('reports one addressed wasm frame, with no source and no name to give', () => {
      const frames = stackAt(resolved, 29);
      assert.deepStrictEqual(outline(frames), ['wasm@0x2d @ -']);
      assert.strictEqual(frames[0].kind, 'wasm');
      assert.strictEqual(frames[0].pc, 0x2d);
    });

    it('does not deemphasize a sourceless frame when the session has no line info (C5)', () => {
      // Everything is sourceless here, so deemphasizing would grey out the whole
      // view and say nothing.
      assert.strictEqual(stackAt(resolved, 29)[0].subtle, false);
    });
  });

  describe('wasm without DWARF: named from the name section (C4)', () => {
    it('labels every frame with the demangled symbol and its offset in the function', () => {
      // The activation structure survives losing DWARF — index 29 is still
      // `triple` called from the wrapper — and each frame is named from the
      // `name` section, carrying the offset that is now the only position it has.
      const frames = stackAt(strippedStepper(), 29);
      assert.deepStrictEqual(
        frames.map((f) => f.kind),
        ['wasm', 'wasm'],
      );
      assert.strictEqual(frames[0].name, 'stepper::triple');
      assert.match(frames[1].name, /^sum_triples\+0x[0-9a-f]+$/);
      for (const frame of frames) {
        assert.strictEqual(frame.source, null);
        assert.strictEqual(frame.subtle, false, 'nothing is deemphasized without line info');
      }
    });
  });

  describe('the bottom rungs of the naming ladder (C4)', () => {
    it('falls back to the wasm function index when the module names nothing', () => {
      // composite.wasm carries neither DWARF nor a `name` section, so a frame can
      // only be identified by which function body it is in.
      const frames = stackAt(unnamedModule(), 0);
      assert.strictEqual(frames.length, 1);
      assert.match(frames[0].name, /^func\[\d+\](\+0x[0-9a-f]+)?$/);
      assert.strictEqual(frames[0].kind, 'wasm');
    });

    it('still reports the cursor on a record ahead of the first established frame', async () => {
      // adder's records 0..5 precede every visible instruction, so the frame walk
      // has nothing on its stack yet. The view must still show where the cursor
      // is rather than come back empty.
      const resolved = await resolveFixture('adder-debug', 'adder-debug');
      const stops = buildStopModel(resolved);
      assert.strictEqual(stops.frames[0], null, 'record 0 precedes the first frame');
      const frames = buildCallStack({ resolved, frames: stops.frames, ranges: stops.ranges }, 0);
      assert.strictEqual(frames.length, 1);
      assert.strictEqual(frames[0].level, 0);
      assert.strictEqual(frames[0].stateIndex, 0);
    });

    it('reports a synthetic frame when no record has an address at all', async () => {
      // Every record of this trace is synthetic (pos null): there is no pc, so no
      // function, no name and no offset — but still a frame, never an empty view.
      const resolved = await resolveFixture('synthetic-all-null');
      const frames = stackAt(resolved, 0);
      assert.strictEqual(frames.length, 1);
      assert.strictEqual(frames[0].name, '<synthetic>');
      assert.strictEqual(frames[0].pc, null);
    });
  });

  describe('contract boundaries (C3)', () => {
    it('appends one label frame per open contract call, innermost first', () => {
      const frames = stackAt(syntheticCrossContract(), 4);
      const contracts = frames.filter((f) => f.kind === 'contract');
      assert.deepStrictEqual(
        contracts.map((f) => f.name),
        ['inner() @ 0xbbbb', 'outer() @ 0xaaaa'],
      );
      // A boundary is not a code position: nothing to open, nothing to inspect.
      for (const frame of contracts) {
        assert.strictEqual(frame.pc, null);
        assert.strictEqual(frame.stateIndex, null);
        assert.strictEqual(frame.source, null);
        assert.deepStrictEqual(frame.variables, []);
      }
    });

    it('puts the boundary frames below every wasm frame', () => {
      const frames = stackAt(syntheticCrossContract(), 4);
      const firstContract = frames.findIndex((f) => f.kind === 'contract');
      assert.ok(firstContract > 0, 'expected at least one wasm frame above the boundaries');
      assert.ok(
        frames.slice(firstContract).every((f) => f.kind === 'contract'),
        'a wasm frame must never appear below a contract boundary',
      );
    });
  });
});

/**
 * stepper-debug's trace replayed against a DWARF-STRIPPED stepper wasm: real
 * disassembly and a real `name` section, no line info and no DIEs. This is what a
 * release build (`debugInfo: false`) gives the debugger.
 */
function strippedStepper(): ResolvedTrace {
  const wasm = stripDebugSections(
    new Uint8Array(fs.readFileSync(path.join(FIXTURES, 'stepper-debug.wasm'))),
  );
  const records = parseTraceJsonl(
    fs.readFileSync(path.join(FIXTURES, 'stepper-debug.trace.jsonl'), 'utf8'),
  );
  const model = new TraceModel(records);
  return { model, ...buildDebugArtifacts(wasm, model, () => {}) };
}

/**
 * A one-record trace inside composite.wasm — a module with no DWARF and no
 * `name` section. `['unknown']` is the mnemonic komet emits for opcodes its
 * printer cannot decode, and position validation accepts it on the exact-address
 * check alone, so the record lands inside a real function body.
 */
function unnamedModule(): ResolvedTrace {
  const wasm = new Uint8Array(fs.readFileSync(path.join(FIXTURES, 'composite.wasm')));
  const body = Disassembly.fromWasm(wasm).functionRanges[0];
  const records = [
    toTraceRecord({ kind: 'instr', pos: body.start, instr: ['unknown'], stack: [], locals: {} }, 1),
  ];
  const model = new TraceModel(records);
  return { model, ...buildDebugArtifacts(wasm, model, () => {}) };
}

/** A trace with two nested contract calls open at index 4. */
function syntheticCrossContract(): ResolvedTrace {
  const A = 'a'.repeat(4);
  const B = 'b'.repeat(4);
  const call = (to: string, fn: string, depth: number): TraceRecord =>
    toTraceRecord(
      {
        kind: 'callContract',
        from: { type: 'address', addrType: 'contract', value: A },
        to: { type: 'address', addrType: 'contract', value: to },
        function: fn,
        depth,
        args: [],
      },
      1,
    );
  const nop = (pos: number | null): TraceRecord =>
    toTraceRecord({ kind: 'instr', pos, instr: ['nop'], stack: [], locals: {} }, 1);

  const records = [nop(0), call(A, 'outer', 1), nop(1), call(B, 'inner', 2), nop(2)];
  const model = new TraceModel(records);
  return {
    model,
    source: new NullSourceMapper(),
    variables: new NullVariableResolver(),
    disassembly: Disassembly.fromTrace(model),
    positions: records.map((r) => r.pos),
  };
}
