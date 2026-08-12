import * as assert from 'assert';
import * as path from 'path';
import { DebugClient } from '@vscode/debugadapter-testsupport';
import { DebugProtocol } from '@vscode/debugprotocol';
import { StrKey } from '@stellar/stellar-sdk';

const ADAPTER = path.join(__dirname, 'support', 'adapterEntry.js');
const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
// A hand-written trace carrying per-step globals AND the full ledger event set.
const LEDGER_TRACE = path.join(FIXTURES, 'ledger-globals.trace.jsonl');
// A real captured trace with contract-call + storage events but NO globals.
const INCREMENT_TRACE = path.join(FIXTURES, 'increment-debug.trace.jsonl');
const INCREMENT_WASM = path.join(FIXTURES, 'increment-debug.wasm');
// A real captured trace with neither globals nor ledger events.
const ADDER_TRACE = path.join(FIXTURES, 'adder-debug.trace.jsonl');

const THREAD = { threadId: 1 };
const CONTRACT_STRKEY = StrKey.encodeContract(Buffer.from('07'.repeat(32), 'hex'));
const ACCOUNT_STRKEY = StrKey.encodeEd25519PublicKey(Buffer.from('08'.repeat(32), 'hex'));

describe('SorobanDebugSession Globals + Ledger scopes (docs/state-inspection.md)', () => {
  let dc: DebugClient;

  beforeEach(async () => {
    dc = new DebugClient('node', ADAPTER, 'soroban');
    await dc.start();
  });

  afterEach(async () => {
    await dc.stop();
  });

  async function launchAndStop(launchArgs: object): Promise<void> {
    const [, , stopped] = await Promise.all([
      dc.configurationSequence(),
      dc.launch(launchArgs as any),
      dc.waitForEvent('stopped'),
    ]);
    assert.strictEqual((stopped as DebugProtocol.StoppedEvent).body.reason, 'entry');
  }

  async function scopes(): Promise<DebugProtocol.Scope[]> {
    const frames = await dc.stackTraceRequest(THREAD);
    const res = await dc.scopesRequest({ frameId: frames.body.stackFrames[0].id });
    return res.body.scopes;
  }

  async function scopeNamed(name: string): Promise<DebugProtocol.Scope> {
    const all = await scopes();
    const found = all.find((s) => s.name === name);
    assert.ok(found, `expected a "${name}" scope, got: ${all.map((s) => s.name).join(', ')}`);
    return found;
  }

  async function childrenOf(reference: number): Promise<DebugProtocol.Variable[]> {
    const res = await dc.variablesRequest({ variablesReference: reference });
    return res.body.variables;
  }

  /** The variables of a named scope. */
  async function varsOf(name: string): Promise<DebugProtocol.Variable[]> {
    return childrenOf((await scopeNamed(name)).variablesReference);
  }

  /**
   * Take `n` instruction-granularity steps. The fixture's visible records (those
   * with a `pos`) are indices 2,3,4,6,8,10 — the event records in between are
   * invisible, so a step count has to be read off that sequence: the entry stop
   * rests on 2, and n steps land on the nth entry after it.
   */
  async function stepInstructions(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      // The stopped event must be awaited CONCURRENTLY with the request: it can
      // arrive before a sequentially-registered listener attaches.
      await Promise.all([
        dc.nextRequest({ ...THREAD, granularity: 'instruction' }),
        dc.waitForEvent('stopped'),
      ]);
    }
  }

  /** Descend a path of child names from a scope, e.g. ['Storage', 'instance']. */
  async function descend(scope: string, ...names: string[]): Promise<DebugProtocol.Variable[]> {
    let vars = await varsOf(scope);
    for (const name of names) {
      const next = vars.find((v) => v.name === name);
      assert.ok(next, `expected child "${name}", got: ${vars.map((v) => v.name).join(', ')}`);
      assert.notStrictEqual(next.variablesReference, 0, `"${name}" should be expandable`);
      vars = await childrenOf(next.variablesReference);
    }
    return vars;
  }

  // ------------------------------------------------------------------ G2/G4

  it('G2: offers a Globals scope listing the module globals by index', async () => {
    await launchAndStop({ rawTrace: LEDGER_TRACE });
    const globals = await varsOf('Globals');
    assert.deepStrictEqual(
      globals.map((v) => v.name),
      ['global[0]'],
    );
    assert.strictEqual(globals[0].value, '1048576');
    assert.strictEqual(globals[0].type, 'i32');
  });

  it('G2: the globals shown follow the cursor', async () => {
    await launchAndStop({ rawTrace: LEDGER_TRACE });
    // Entry rests on the first visible record (globals = 1048576). Two
    // instruction steps later the shadow-stack pointer has moved.
    await stepInstructions(2);
    const globals = await varsOf('Globals');
    assert.strictEqual(globals[0].value, '1048560');
  });

  it('G4: omits the Globals scope for a trace that carries no globals', async () => {
    await launchAndStop({ rawTrace: ADDER_TRACE });
    const names = (await scopes()).map((s) => s.name);
    assert.ok(!names.includes('Globals'), `expected no Globals scope, got: ${names.join(', ')}`);
    // The pre-existing scopes are untouched.
    assert.ok(names.includes('Locals'));
    assert.ok(names.includes('Value Stack'));
  });

  // ------------------------------------------------------------------ L14

  it('L14: omits the Ledger scope for a trace with no ledger information', async () => {
    await launchAndStop({ rawTrace: ADDER_TRACE });
    const names = (await scopes()).map((s) => s.name);
    assert.ok(!names.includes('Ledger'), `expected no Ledger scope, got: ${names.join(', ')}`);
  });

  it('L14: offers a Ledger scope for a real trace carrying storage events', async () => {
    await launchAndStop({ rawTrace: INCREMENT_TRACE, wasmPath: INCREMENT_WASM });
    const names = (await scopes()).map((s) => s.name);
    assert.ok(names.includes('Ledger'), `expected a Ledger scope, got: ${names.join(', ')}`);
  });

  // ------------------------------------------------------------------ the tree

  it('presents the documented Ledger sub-tree', async () => {
    await launchAndStop({ rawTrace: LEDGER_TRACE });
    const names = (await varsOf('Ledger')).map((v) => v.name);
    assert.deepStrictEqual(names, [
      'Contract',
      'Storage',
      'Accounts',
      'Ledger',
      'Host objects',
      'Call stack',
    ]);
  });

  it('shows the executing contract with its wasm hash and TTL', async () => {
    await launchAndStop({ rawTrace: LEDGER_TRACE });
    const contract = await descend('Ledger', 'Contract');
    const byName = new Map(contract.map((v) => [v.name, v.value]));
    assert.strictEqual(byName.get('id'), CONTRACT_STRKEY);
    assert.strictEqual(byName.get('wasmHash'), 'ab12');
    assert.strictEqual(byName.get('liveUntil'), '100');
  });

  it('L3: groups storage by durability, with keys, values and TTLs', async () => {
    await launchAndStop({ rawTrace: LEDGER_TRACE });
    const durabilities = (await descend('Ledger', 'Storage')).map((v) => v.name);
    // Only the durabilities that have entries are shown, in a stable order.
    assert.deepStrictEqual(durabilities, ['instance', 'persistent']);

    const instance = await descend('Ledger', 'Storage', 'instance');
    assert.deepStrictEqual(
      instance.map((v) => v.name),
      ['symbol(COUNTER)'],
    );
    assert.strictEqual(instance[0].value, '4');
    assert.strictEqual(instance[0].type, 'u32');

    // A composite value expands, and the TTL is reachable per entry.
    const persistent = await descend('Ledger', 'Storage', 'persistent');
    assert.deepStrictEqual(
      persistent.map((v) => v.name),
      ['symbol(OWNER)'],
    );
    assert.strictEqual(persistent[0].value, ACCOUNT_STRKEY);
  });

  it('L2/L15: stepping over a write moves the stored value', async () => {
    await launchAndStop({ rawTrace: LEDGER_TRACE });
    const before = await descend('Ledger', 'Storage', 'instance');
    assert.strictEqual(before[0].value, '4');

    // The put is record 7, so it applies from record 8 (L15) — the 4th visible
    // record after the entry stop (2 -> 3 -> 4 -> 6 -> 8).
    await stepInstructions(4);
    const after = await descend('Ledger', 'Storage', 'instance');
    assert.strictEqual(after[0].value, '5', 'the write should be visible after stepping past it');
  });

  it('L9/L10: shows account balances and the ledger scalars', async () => {
    await launchAndStop({ rawTrace: LEDGER_TRACE });
    const accounts = await descend('Ledger', 'Accounts');
    assert.deepStrictEqual(
      accounts.map((v) => v.name),
      [ACCOUNT_STRKEY],
    );
    assert.strictEqual(accounts[0].value, '9876543210');

    const info = new Map((await descend('Ledger', 'Ledger')).map((v) => [v.name, v.value]));
    assert.strictEqual(info.get('sequence'), '42');
    assert.ok(info.get('timestamp')?.includes('1712345678'), info.get('timestamp'));
  });

  it('L6: shows the open contract calls with their function and args', async () => {
    await launchAndStop({ rawTrace: LEDGER_TRACE });
    const frames = await descend('Ledger', 'Call stack');
    assert.strictEqual(frames.length, 1);
    assert.ok(frames[0].value.includes('bump'), frames[0].value);
    const frame = new Map(
      (await childrenOf(frames[0].variablesReference)).map((v) => [v.name, v.value]),
    );
    assert.strictEqual(frame.get('to'), CONTRACT_STRKEY);
    assert.strictEqual(frame.get('from'), ACCOUNT_STRKEY);
    assert.strictEqual(frame.get('function'), 'bump');
    assert.strictEqual(frame.get('depth'), '1');
  });

  it('L11: shows the host object table once objects are allocated', async () => {
    await launchAndStop({ rawTrace: LEDGER_TRACE });
    // Nothing allocated at the entry stop.
    assert.deepStrictEqual(await descend('Ledger', 'Host objects'), []);
    // addObject is record 5, so it applies from record 6 — the 3rd visible
    // record after the entry stop (2 -> 3 -> 4 -> 6).
    await stepInstructions(3);
    const objects = await descend('Ledger', 'Host objects');
    assert.deepStrictEqual(
      objects.map((v) => v.name),
      ['[0]'],
    );
    assert.strictEqual(objects[0].value, 'COUNTER');
  });

  // ------------------------------------------------------------------ L7 via steps

  it('L7: a TTL bump shows up on the entry it targets', async () => {
    await launchAndStop({ rawTrace: LEDGER_TRACE });
    const before = await descend('Ledger', 'Storage', 'persistent');
    const ttlBefore = await childrenOf(before[0].variablesReference);
    assert.strictEqual(
      ttlBefore.find((v) => v.name === 'liveUntil')?.value,
      '90',
    );

    // Run to the end of the trace, past the contractTtl record.
    await Promise.all([dc.continueRequest(THREAD), dc.waitForEvent('stopped')]);
    const after = await descend('Ledger', 'Storage', 'persistent');
    const ttlAfter = await childrenOf(after[0].variablesReference);
    assert.strictEqual(ttlAfter.find((v) => v.name === 'liveUntil')?.value, '5000');
  });

  // ------------------------------------------------------------------ real trace

  it('reconstructs the increment fixture storage in the Ledger scope', async () => {
    await launchAndStop({ rawTrace: INCREMENT_TRACE, wasmPath: INCREMENT_WASM });
    // Run to the end so the COUNTER write has been applied.
    await Promise.all([dc.continueRequest(THREAD), dc.waitForEvent('stopped')]);
    const instance = await descend('Ledger', 'Storage', 'instance');
    assert.deepStrictEqual(
      instance.map((v) => v.name),
      ['symbol(COUNTER)'],
    );
    assert.strictEqual(instance[0].value, '5');
  });

  // The pre-existing scopes must keep working alongside the new ones.
  it('leaves the existing scopes and their contents intact', async () => {
    await launchAndStop({ rawTrace: LEDGER_TRACE });
    const names = (await scopes()).map((s) => s.name);
    assert.deepStrictEqual(names, ['Locals', 'Value Stack', 'Globals', 'Ledger']);
    // Value Stack still reports the wasm stack of the current record.
    await dc.nextRequest({ ...THREAD, granularity: 'instruction' });
    await dc.waitForEvent('stopped');
    const stack = await varsOf('Value Stack');
    assert.strictEqual(stack.length, 1);
    assert.strictEqual(stack[0].value, '1048576');
  });
});
