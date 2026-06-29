import * as assert from 'assert';
import * as path from 'path';
import { DebugClient } from '@vscode/debugadapter-testsupport';

const ADAPTER = path.join(__dirname, 'support', 'adapterEntry.js');
const FIXTURE = path.join(__dirname, '..', '..', 'test', 'fixtures', 'add.trace.jsonl');

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
  async function launchAndStop() {
    const [, , stopped] = await Promise.all([
      dc.configurationSequence(),
      dc.launch({ rawTrace: FIXTURE, function: 'add' } as any),
      dc.assertStoppedLocation('entry', { line: 1 }),
    ]);
    return stopped;
  }

  it('advertises reverse-debugging capability', async () => {
    const res = await dc.initializeRequest();
    assert.strictEqual(res.body?.supportsStepBack, true);
  });

  it('stops at entry on the first instruction', async () => {
    const stopped = await launchAndStop();
    assert.ok(stopped.body.stackFrames.length >= 1);
  });

  it('steps forward one instruction at a time', async () => {
    await launchAndStop();
    await Promise.all([dc.stepInRequest({ threadId: 1 }), dc.assertStoppedLocation('step', { line: 2 })]);
    await Promise.all([dc.stepInRequest({ threadId: 1 }), dc.assertStoppedLocation('step', { line: 3 })]);
  });

  it('steps backward (time travel)', async () => {
    await launchAndStop();
    await Promise.all([dc.stepInRequest({ threadId: 1 }), dc.assertStoppedLocation('step', { line: 2 })]);
    await Promise.all([dc.stepBackRequest({ threadId: 1 }), dc.assertStoppedLocation('step', { line: 1 })]);
  });

  it('exposes locals and value stack at the cursor', async () => {
    const stopped = await launchAndStop();
    const frameId = stopped.body.stackFrames[0].id;
    const scopes = await dc.scopesRequest({ frameId });
    const names = scopes.body.scopes.map((s) => s.name);
    assert.deepStrictEqual(names, ['Locals', 'Value Stack']);

    const localsRef = scopes.body.scopes[0].variablesReference;
    const locals = await dc.variablesRequest({ variablesReference: localsRef });
    const local0 = locals.body.variables.find((v) => v.name === 'local[0]');
    assert.ok(local0, 'expected local[0]');
    assert.strictEqual(local0!.type, 'i64');
    assert.strictEqual(local0!.value, '4');
  });

  it('runs to a breakpoint, then reverse-continues back to it', async () => {
    // Set a breakpoint on line 3 (the i64.add instruction) once the adapter
    // signals it is ready (InitializedEvent), then finish configuration.
    await Promise.all([
      dc.launch({ rawTrace: FIXTURE, function: 'add' } as any),
      dc.waitForEvent('initialized').then(async () => {
        await dc.setBreakpointsRequest({
          source: { name: 'trace.komet' },
          breakpoints: [{ line: 3 }],
        });
        await dc.configurationDoneRequest();
      }),
      dc.assertStoppedLocation('entry', { line: 1 }),
    ]);

    await Promise.all([dc.continueRequest({ threadId: 1 }), dc.assertStoppedLocation('breakpoint', { line: 3 })]);

    // Move past it, then reverse-continue back to the same breakpoint.
    await Promise.all([dc.stepInRequest({ threadId: 1 }), dc.assertStoppedLocation('step', { line: 4 })]);
    await Promise.all([
      dc.reverseContinueRequest({ threadId: 1 }),
      dc.assertStoppedLocation('breakpoint', { line: 3 }),
    ]);
  });
});
