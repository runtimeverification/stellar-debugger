/**
 * End-to-end behavior of the setup diagnostics through the backends: what a
 * user actually sees when komet-node, the toolchain, or an input file is not
 * there. The messages themselves are asserted in setupErrors.test.ts; here we
 * check that each failure path REACHES them, and reaches them fast.
 */

import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LiveBackend } from '../src/debugAdapter/backends/LiveBackend';
import { RawTraceBackend } from '../src/debugAdapter/backends/RawTraceBackend';
import { SorobanLaunchArgs } from '../src/debugAdapter/types';
import { TROUBLESHOOTING_URL, isUserFacing } from '../src/diagnostics/setup';
import { MockKometNode } from './support/mockKometNode';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const WASM = path.join(FIXTURES, 'sample_contract.wasm');
const TRACE = path.join(FIXTURES, 'add.trace.jsonl');

const MISSING_BINARY = 'komet-node-does-not-exist-4f2a';

/** A closed port: bind one, note it, release it. */
async function freePort(): Promise<number> {
  const net = await import('net');
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('net').AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function launch(node: Record<string, unknown>, wasm = WASM): SorobanLaunchArgs {
  return {
    transactions: [
      { kind: 'deploy', id: 'c', wasm },
      { kind: 'invoke', contract: 'c', function: 'add', args: { a: 1, b: 2 } },
    ],
    node,
  } as unknown as SorobanLaunchArgs;
}

/** Reject the launch and hand back the error, asserting it is user-facing. */
async function failedLaunch(backend: LiveBackend | RawTraceBackend, args: SorobanLaunchArgs): Promise<Error> {
  try {
    await backend.resolve(args, () => undefined);
  } catch (e) {
    const err = e as Error;
    assert.ok(isUserFacing(err), `expected a user-facing error, got ${err.name}: ${err.message}`);
    assert.ok(err.message.includes(TROUBLESHOOTING_URL), `expected the README link in: ${err.message}`);
    return err;
  }
  return assert.fail('expected the launch to fail');
}

describe('a launch with komet-node missing', () => {
  it('fails at once with an install hint, instead of waiting out the health check', async function () {
    this.timeout(20_000);
    const backend = new LiveBackend();
    const started = Date.now();
    // healthTimeoutMs is left at its 60s default on purpose: the point is that
    // the spawn failure short-circuits it.
    const err = await failedLaunch(backend, launch({ command: MISSING_BINARY, port: await freePort() }));
    const elapsed = Date.now() - started;

    assert.match(err.message, /kup install komet-node/);
    assert.match(err.message, /stellar\.kometNode\.path/);
    assert.ok(elapsed < 10_000, `took ${elapsed}ms — the health-check timeout was not short-circuited`);
    await backend.dispose();
  });
});

describe('a launch against a node that is not there', () => {
  it('explains an attach-mode failure as nothing listening, not as a missing install', async () => {
    const backend = new LiveBackend();
    const err = await failedLaunch(
      backend,
      launch({ attach: true, host: '127.0.0.1', port: await freePort(), healthTimeoutMs: 300 }),
    );

    assert.match(err.message, /attach/);
    assert.doesNotMatch(err.message, /kup install/);
    await backend.dispose();
  });

  it('explains a spawned node that never became healthy', async function () {
    this.timeout(20_000);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-backends-'));
    const script = path.join(dir, 'komet-node');
    // Runs, serves nothing, and stays up: the health check must time out.
    await fs.writeFile(script, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    const backend = new LiveBackend();
    try {
      const err = await failedLaunch(
        backend,
        launch({ command: script, port: await freePort(), healthTimeoutMs: 500 }),
      );
      assert.match(err.message, /healthTimeoutMs/);
      assert.match(err.message, /did not become (ready|healthy)|no response/i);
    } finally {
      await backend.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('a launch against a komet-node that is too old', () => {
  let mock: MockKometNode;

  afterEach(async () => {
    if (mock) {
      await mock.stop();
    }
  });

  it('explains a node with no traceTransaction method as a version problem', async () => {
    mock = new MockKometNode({
      trace: await fs.readFile(TRACE, 'utf8'),
      errorFor: { method: 'traceTransaction', code: -32601, message: 'Method not found' },
    });
    const port = await mock.start();

    const backend = new LiveBackend();
    const err = await failedLaunch(backend, launch({ attach: true, host: '127.0.0.1', port }));
    assert.match(err.message, /traceTransaction/);
    assert.match(err.message, /kup install komet-node/);
    await backend.dispose();
  });

  it('explains a pre-v0.1.87 trace shape as a version problem', async () => {
    // The old shape: no `kind` field on the records (see the release notes).
    mock = new MockKometNode({
      trace: '{"pos":null,"instr":["callContract"],"stack":[],"locals":{}}',
    });
    const port = await mock.start();

    const backend = new LiveBackend();
    const err = await failedLaunch(backend, launch({ attach: true, host: '127.0.0.1', port }));
    assert.match(err.message, /komet v0\.1\.87/);
    assert.match(err.message, /kup install komet-node/);
    await backend.dispose();
  });
});

describe('a launch whose inputs cannot be read', () => {
  let mock: MockKometNode;

  afterEach(async () => {
    if (mock) {
      await mock.stop();
    }
  });

  it('explains a missing rawTrace file, and how to record one', async () => {
    const backend = new RawTraceBackend();
    const err = await failedLaunch(backend, { rawTrace: '/nope/missing.jsonl' } as SorobanLaunchArgs);
    assert.match(err.message, /\/nope\/missing\.jsonl/);
    assert.match(err.message, /rawTrace/);
    assert.match(err.message, /no such file/i);
    assert.match(err.message, /stellar-trace/);
  });

  it('explains a missing wasmPath alongside a good rawTrace', async () => {
    const backend = new RawTraceBackend();
    const err = await failedLaunch(backend, {
      rawTrace: TRACE,
      wasmPath: '/nope/missing.wasm',
    } as SorobanLaunchArgs);
    assert.match(err.message, /\/nope\/missing\.wasm/);
    assert.match(err.message, /wasmPath/);
  });

  it('explains a deploy step whose prebuilt wasm is missing, naming the step', async () => {
    mock = new MockKometNode({ trace: await fs.readFile(TRACE, 'utf8') });
    const port = await mock.start();

    const backend = new LiveBackend();
    const err = await failedLaunch(
      backend,
      launch({ attach: true, host: '127.0.0.1', port }, '/nope/missing.wasm'),
    );
    assert.match(err.message, /\/nope\/missing\.wasm/);
    assert.match(err.message, /"c"/);
    await backend.dispose();
  });
});
