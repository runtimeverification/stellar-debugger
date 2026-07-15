import * as assert from 'assert';
import * as path from 'path';
import { DebugClient } from '@vscode/debugadapter-testsupport';
import { DebugProtocol } from '@vscode/debugprotocol';

const ADAPTER = path.join(__dirname, 'support', 'adapterEntry.js');
const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');

// A REAL komet trace of `increment(5)` (records carry per-step `mem` sparse
// snapshots), replayed against the DWARF-bearing contract wasm. Unlike the adder
// (whose params live in wasm locals), the increment contract spills its Rust locals
// to the shadow stack in LINEAR MEMORY at -O0, so resolving them exercises the whole
// chain end to end: komet `mem` snapshots -> trace.ts -> MemoryImage -> RuntimeState
// -> DWARF fbreg location eval -> ValueDecoder -> the DAP Variables view.
const INCR_TRACE = path.join(FIXTURES, 'increment-debug.trace.jsonl');
const INCR_WASM = path.join(FIXTURES, 'increment-debug.wasm');
const INCR_LIB_RS = path.join(__dirname, '..', '..', 'examples', 'increment', 'src', 'lib.rs');
const WITH_WASM = { rawTrace: INCR_TRACE, wasmPath: INCR_WASM };
const NO_WASM = { rawTrace: INCR_TRACE };
const THREAD = { threadId: 1 };

// `increment(env: Env, by: u32) -> u32` — `by` is declared here (line 19). The debugger
// stops at statement run-starts; line 19's run-start is the prologue, where the argument
// has not yet been spilled to the shadow stack (a stale slot reads 0). By the first
// statement of the body (line 20, `let current ...`) `by` has been stored, so that stop
// is where the memory-backed parameter reads its passed value.
const INCREMENT_FN_LINE = 19;
const INCREMENT_BODY_LINE = 20;

describe('SorobanDebugSession memory-backed Rust variables (end-to-end)', () => {
  let dc: DebugClient;

  beforeEach(async () => {
    dc = new DebugClient('node', ADAPTER, 'soroban');
    await dc.start();
  });

  afterEach(async () => {
    await dc.stop();
  });

  /** Launch, set a breakpoint on INCR_LIB_RS at `line`, and wait for the entry stop. */
  async function launchWithBreakpoint(launchArgs: object, line: number): Promise<void> {
    await Promise.all([
      dc.launch(launchArgs as any),
      dc.waitForEvent('initialized').then(async () => {
        await dc.setBreakpointsRequest({ source: { path: INCR_LIB_RS }, breakpoints: [{ line }] });
        await dc.configurationDoneRequest();
      }),
      dc.waitForEvent('stopped'),
    ]);
  }

  async function topFrame(): Promise<DebugProtocol.StackFrame> {
    const res = await dc.stackTraceRequest(THREAD);
    assert.ok(res.body.stackFrames.length >= 1, 'expected at least one stack frame');
    return res.body.stackFrames[0];
  }

  async function sourceVariables(frameId: number): Promise<DebugProtocol.Variable[] | null> {
    const scopes = (await dc.scopesRequest({ frameId })).body.scopes;
    const varScope = scopes.find((s) => s.name === 'Variables');
    if (!varScope) {
      return null;
    }
    return (await dc.variablesRequest({ variablesReference: varScope.variablesReference })).body.variables;
  }

  it('resolves a shadow-stack (memory-backed) Rust parameter to its passed value', async () => {
    // The trace was produced by calling increment(5). `by` is a u32 whose DWARF
    // location is DW_OP_fbreg — it lives in the shadow stack (linear memory), NOT a
    // wasm local — so reading it back as 5 proves the memory pipeline works.
    await launchWithBreakpoint(WITH_WASM, INCREMENT_BODY_LINE);

    let found: DebugProtocol.Variable | undefined;
    const seen: string[] = [];
    // The body line is reached twice — once in the SDK-generated wrapper pass (where the
    // slot is not yet the caller's argument) and once in the real call — so continue to
    // the breakpoint until `by` has settled at its passed value. Reached well within this bound.
    for (let i = 0; i < 60 && !found; i++) {
      const frame = await topFrame();
      if (frame.source?.path === INCR_LIB_RS) {
        const vars = await sourceVariables(frame.id);
        assert.ok(vars, 'expected a Variables scope at a DWARF-mapped stop');
        const by = vars!.find((v) => v.name === 'by');
        if (by) {
          seen.push(by.value);
          if (by.type === 'u32' && by.value === '5') {
            found = by;
            break;
          }
        }
      }
      await Promise.all([dc.continueRequest(THREAD), dc.waitForEvent('stopped')]);
    }

    assert.ok(found, `expected \`by: u32\` to resolve to 5 from memory; values seen for by: [${seen.join(', ')}]`);
    // It must be a scalar leaf (no children), decoded straight from the memory bytes.
    assert.strictEqual(found!.type, 'u32');
    assert.strictEqual(found!.value, '5');
  });

  it('offers the source Variables scope with named Rust locals inside the contract fn', async () => {
    await launchWithBreakpoint(WITH_WASM, INCREMENT_FN_LINE);
    // At the breakpoint stop the resolver has functions, so a Variables scope is
    // offered and lists the function's named parameters (`by`, `env`).
    const frame = await topFrame();
    assert.strictEqual(frame.source?.path, INCR_LIB_RS);
    const scopes = (await dc.scopesRequest({ frameId: frame.id })).body.scopes.map((s) => s.name);
    assert.ok(scopes.includes('Variables'), `expected a Variables scope, got: ${scopes.join(', ')}`);
    assert.strictEqual(scopes[0], 'Variables', 'Variables must be the first scope');

    const vars = await sourceVariables(frame.id);
    const names = (vars ?? []).map((v) => v.name);
    assert.ok(names.includes('by'), `expected a \`by\` variable, got: ${names.join(', ')}`);
    assert.ok(names.includes('env'), `expected an \`env\` variable, got: ${names.join(', ')}`);
  });

  it('shows no Variables scope without the wasm (regression guard)', async () => {
    // NO_WASM => NullVariableResolver => no source-level scope, only wasm scopes.
    await Promise.all([
      dc.launch(NO_WASM as any),
      dc.configurationSequence(),
      dc.waitForEvent('stopped'),
    ]);
    const frame = await topFrame();
    const names = (await dc.scopesRequest({ frameId: frame.id })).body.scopes.map((s) => s.name);
    assert.deepStrictEqual(names, ['Locals', 'Value Stack']);
  });
});
