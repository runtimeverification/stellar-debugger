import * as assert from 'assert';
import * as path from 'path';
import { DebugClient } from '@vscode/debugadapter-testsupport';
import { DebugProtocol } from '@vscode/debugprotocol';
// src/server/dapServer.ts does not exist yet — this import is what makes the
// suite fail to compile/run until M2's TCP server lands (docs/interfaces.md,
// "Interface 2 — standalone TCP DAP server").
import { startDapServer } from '../src/server/dapServer';
import { RawTraceBackend } from '../src/debugAdapter/backends/RawTraceBackend';
import {
  ProgressReporter,
  ResolvedTrace,
  SessionBackend,
  SorobanLaunchArgs,
} from '../src/debugAdapter/types';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const ADDER_TRACE = path.join(FIXTURES, 'adder-debug.trace.jsonl');
const ADDER_WASM = path.join(FIXTURES, 'adder-debug.wasm');

/** The real contract source the fixture's DWARF resolves to. */
const LIB_RS_SUFFIX = 'examples/adder/src/lib.rs';

const WITH_WASM = { rawTrace: ADDER_TRACE, wasmPath: ADDER_WASM };
const THREAD = { threadId: 1 };

describe('startDapServer (standalone TCP DAP server)', () => {
  let srv: { port: number; close: () => Promise<void> };
  let clients: DebugClient[];

  beforeEach(async () => {
    clients = [];
    srv = await startDapServer({ port: 0 });
    assert.strictEqual(typeof srv.port, 'number', 'expected a numeric ephemeral port');
    assert.ok(srv.port > 0, `expected an assigned ephemeral port, got ${srv.port}`);
  });

  afterEach(async function () {
    this.timeout(30000);
    for (const dc of clients) {
      try {
        await dc.stop();
      } catch {
        // best-effort teardown; a client may already be disconnected
      }
    }
    await srv.close();
  });

  /** Connect a fresh DebugClient to the server's TCP port. */
  async function connect(): Promise<DebugClient> {
    const dc = new DebugClient('node', 'unused', 'soroban');
    clients.push(dc);
    await dc.start(srv.port);
    return dc;
  }

  it('drives a real DAP session over the socket, stopping at the adder entry', async function () {
    this.timeout(30000);
    const dc = await connect();

    const [, , stopped] = await Promise.all([
      dc.configurationSequence(),
      dc.launch(WITH_WASM as any),
      dc.waitForEvent('stopped'),
    ]);
    assert.strictEqual((stopped as DebugProtocol.StoppedEvent).body.reason, 'entry');

    const res = await dc.stackTraceRequest(THREAD);
    assert.ok(res.body.stackFrames.length >= 1, 'expected at least one stack frame');
    const top = res.body.stackFrames[0];
    assert.strictEqual(top.line, 16);
    assert.ok(
      top.source?.path?.endsWith(LIB_RS_SUFFIX),
      `unexpected source: ${top.source?.path}`,
    );
  });

  it('serves a second independent connection (one session per connection)', async function () {
    this.timeout(30000);
    // First connection drives a full session to a stop...
    const dc1 = await connect();
    await Promise.all([
      dc1.configurationSequence(),
      dc1.launch(WITH_WASM as any),
      dc1.waitForEvent('stopped'),
    ]);

    // ...while a second, independent connection to the same server initializes
    // and disconnects cleanly, proving the server is not single-session.
    const dc2 = await connect();
    const init = await dc2.initializeRequest();
    assert.ok(init.body, 'expected initialize capabilities on the second connection');
    await dc2.disconnectRequest({});
  });

  it('disposes the per-connection backend when the socket drops without a disconnect', async function () {
    this.timeout(30000);

    // A spy backend delegating to the real replay path, counting disposals.
    // This is exactly the LiveBackend leak scenario: a backend resolved by a
    // launch (its komet-node pipeline live) must be disposed even when the
    // client vanishes without sending a `disconnect` request.
    class SpyBackend implements SessionBackend {
      disposeCount = 0;
      private readonly inner = new RawTraceBackend();
      resolve(args: SorobanLaunchArgs, report: ProgressReporter): Promise<ResolvedTrace> {
        return this.inner.resolve(args, report);
      }
      async dispose(): Promise<void> {
        this.disposeCount++;
      }
    }
    const spy = new SpyBackend();

    // A dedicated server whose sole connection uses the spy backend.
    const leakSrv = await startDapServer({ port: 0, backendFor: () => spy });
    try {
      const dc = new DebugClient('node', 'unused', 'soroban');
      await dc.start(leakSrv.port);

      // Drive a full launch so the backend selector resolves to the concrete
      // spy (mirrors a live komet-node pipeline being spun up).
      await Promise.all([
        dc.configurationSequence(),
        dc.launch(WITH_WASM as any),
        dc.waitForEvent('stopped'),
      ]);
      assert.strictEqual(spy.disposeCount, 0, 'backend should not be disposed while connected');

      // Abrupt drop: destroy the underlying socket WITHOUT a disconnect request
      // (editor crash / network drop). The old code wired socket close to
      // session.shutdown(), a no-op in server mode, so dispose never ran.
      const socket = (dc as unknown as { _socket?: import('net').Socket })._socket;
      assert.ok(socket, 'expected an underlying socket on the DebugClient');
      socket.destroy();

      // Poll until the teardown handler has disposed the backend.
      const deadline = Date.now() + 5000;
      while (spy.disposeCount === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.strictEqual(
        spy.disposeCount,
        1,
        'abrupt socket drop must dispose the per-connection backend exactly once',
      );
    } finally {
      await leakSrv.close();
    }
  });
});
