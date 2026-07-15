import * as assert from 'assert';
import * as path from 'path';
import { DebugClient } from '@vscode/debugadapter-testsupport';
import { DebugProtocol } from '@vscode/debugprotocol';

const ADAPTER = path.join(__dirname, 'support', 'adapterEntry.js');
const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const ADDER_TRACE = path.join(FIXTURES, 'adder-debug.trace.jsonl');
const ADDER_WASM = path.join(FIXTURES, 'adder-debug.wasm');

// WITH_WASM supplies the DWARF-bearing wasm alongside the canned trace, so the
// session builds a DwarfVariableResolver. NO_WASM replays the same trace with
// no wasm at all -> NullVariableResolver (no source-level Variables scope).
const WITH_WASM = { rawTrace: ADDER_TRACE, wasmPath: ADDER_WASM };
const NO_WASM = { rawTrace: ADDER_TRACE };
const THREAD = { threadId: 1 };

describe('SorobanDebugSession source-level Variables view (M9)', () => {
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

  async function topFrame(): Promise<DebugProtocol.StackFrame> {
    const res = await dc.stackTraceRequest(THREAD);
    assert.ok(res.body.stackFrames.length >= 1, 'expected at least one stack frame');
    return res.body.stackFrames[0];
  }

  /** The scopes offered for the current top frame. */
  async function topScopes(): Promise<DebugProtocol.Scope[]> {
    const frame = await topFrame();
    const res = await dc.scopesRequest({ frameId: frame.id });
    return res.body.scopes;
  }

  it('exposes a source-level Variables scope first when DWARF is present', async () => {
    await launchAndStop(WITH_WASM);
    // After S17 the entry stop lands on the sole statement stop, lib.rs:16
    // `a + b` (record 29, code offset 0x2d), inside the Soroban-generated
    // invoke_raw_extern where the two params are in scope. The resolver has
    // functions, so the Variables scope is offered regardless of the exact PC.
    const names = (await topScopes()).map((s) => s.name);
    assert.ok(names.includes('Variables'), `expected a Variables scope, got: ${names.join(', ')}`);
    assert.strictEqual(names[0], 'Variables', `Variables must be the first scope, got: ${names.join(', ')}`);
    assert.ok(names.includes('Locals'), `expected the wasm Locals scope, got: ${names.join(', ')}`);
    assert.ok(names.includes('Value Stack'), `expected the Value Stack scope, got: ${names.join(', ')}`);
  });

  it('resolves the named Rust parameters with a type and a numeric value', async () => {
    await launchAndStop(WITH_WASM);
    const scopes = await topScopes();
    const varScope = scopes.find((s) => s.name === 'Variables');
    assert.ok(varScope, 'expected a Variables scope');

    const res = await dc.variablesRequest({ variablesReference: varScope!.variablesReference });
    const vars = res.body.variables;

    // invoke_raw_extern's DWARF parameters are arg_0 and arg_1 (Soroban `Val`s).
    // They live in wasm locals via inline location expressions, so they resolve
    // WITHOUT any memory image — this works with the canned trace today.
    for (const name of ['arg_0', 'arg_1']) {
      const v = vars.find((x) => x.name === name);
      assert.ok(v, `expected a variable named ${name}, got: ${vars.map((x) => x.name).join(', ')}`);
      assert.ok(v!.type !== undefined && v!.type.length > 0, `expected a non-empty type for ${name}, got: ${v!.type}`);
      assert.ok(/^\d+$/.test(v!.value), `expected a numeric value for ${name}, got: ${v!.value}`);
    }

    // Cross-check (exact numbers not hardcoded): each param's decoded value
    // matches one of the wasm Locals it aliases — arg_0/arg_1 read from
    // local[0]/local[1]. Values live in locals, so this must agree.
    const localsScope = scopes.find((s) => s.name === 'Locals');
    assert.ok(localsScope, 'expected the wasm Locals scope');
    const localsRes = await dc.variablesRequest({ variablesReference: localsScope!.variablesReference });
    const localValues = new Set(localsRes.body.variables.map((v) => v.value));
    for (const name of ['arg_0', 'arg_1']) {
      const v = vars.find((x) => x.name === name)!;
      assert.ok(localValues.has(v.value), `expected ${name} value ${v.value} to match a wasm local value`);
    }
  });

  it('shows no Variables scope without DWARF, exactly [Locals, Value Stack] (regression guard)', async () => {
    await launchAndStop(NO_WASM);
    // NullVariableResolver reports no functions -> the Variables scope is never
    // prepended, so the scope list is unchanged from the pre-M9 behaviour.
    const names = (await topScopes()).map((s) => s.name);
    assert.deepStrictEqual(names, ['Locals', 'Value Stack']);
  });

  it('marks a scalar parameter as a leaf (variablesReference 0)', async () => {
    await launchAndStop(WITH_WASM);
    const varScope = (await topScopes()).find((s) => s.name === 'Variables');
    assert.ok(varScope, 'expected a Variables scope');

    const res = await dc.variablesRequest({ variablesReference: varScope!.variablesReference });
    const arg0 = res.body.variables.find((v) => v.name === 'arg_0');
    assert.ok(arg0, 'expected the arg_0 parameter');
    // A scalar Soroban `Val` has no expandable children, so its reference is 0
    // (not expandable). Struct/enum child expansion is validated by the M6/M8
    // ValueDecoder unit tests; full memory-backed expansion in the DAP session
    // awaits the komet-node memory trace and is not exercised here.
    assert.strictEqual(arg0!.variablesReference, 0);
  });
});
