/**
 * KometProcess failure detection: a node that cannot be spawned, or that dies
 * before it serves, must be reported AT ONCE rather than left for the 60-second
 * health-check timeout to notice. `whenFailed()` is what LiveBackend races the
 * health check against.
 */

import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KometProcess } from '../src/komet/KometProcess';
import { isUserFacing } from '../src/diagnostics/setup';

/** A command name no PATH can resolve. */
const MISSING = 'komet-node-does-not-exist-4f2a';

/** Resolve to `'pending'` if `p` has not settled within `ms`. */
function within<T>(p: Promise<T>, ms: number): Promise<T | 'pending'> {
  return Promise.race([p, new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms))]);
}

describe('KometProcess failure detection', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  /**
   * An executable stand-in for komet-node: it ignores the --host/--port
   * arguments the real node takes, so `body` decides how the "node" behaves.
   */
  async function fakeNode(body: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'komet-process-test-'));
    tempDirs.push(dir);
    const script = path.join(dir, 'komet-node');
    await fs.writeFile(script, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return script;
  }

  it('reports a missing binary immediately, as a user-facing setup error', async () => {
    const proc = new KometProcess({ command: MISSING, port: 8123 });
    const messages: string[] = [];
    const started = Date.now();
    proc.start((m) => messages.push(m));

    const failure = await within(proc.whenFailed(), 5000);
    assert.notStrictEqual(failure, 'pending', 'the spawn failure was not reported');
    const err = failure as Error;
    assert.ok(isUserFacing(err), `expected a user-facing error, got ${err.name}`);
    assert.match(err.message, /komet-node/);
    assert.match(err.message, /kup install komet-node/);
    assert.match(err.message, new RegExp(MISSING));
    assert.ok(Date.now() - started < 5000, 'reporting a missing binary should not wait on a timeout');
    // The console still gets a line, so the log tells the same story.
    assert.ok(messages.some((m) => /komet-node/.test(m)), messages.join('\n'));
    await proc.stop();
  });

  it('reports a node that exits before serving, with its exit code', async () => {
    const proc = new KometProcess({ command: await fakeNode('exit 1'), port: 8123 });
    proc.start(() => undefined);

    const failure = await within(proc.whenFailed(), 5000);
    assert.notStrictEqual(failure, 'pending', 'the early exit was not reported');
    const err = failure as Error;
    assert.ok(isUserFacing(err));
    assert.match(err.message, /exited/);
    assert.match(err.message, /code 1/);
    await proc.stop();
  });

  it('keeps the node output that explains an early exit', async () => {
    const proc = new KometProcess({
      command: await fakeNode('echo "Address already in use" >&2; exit 2'),
      port: 8123,
    });
    proc.start(() => undefined);

    const failure = await within(proc.whenFailed(), 5000);
    assert.notStrictEqual(failure, 'pending');
    assert.match((failure as Error).message, /Address already in use/);
    await proc.stop();
  });

  it('never reports a failure for a node we shut down ourselves', async () => {
    const proc = new KometProcess({ command: await fakeNode('sleep 30'), port: 8123 });
    proc.start(() => undefined);
    await proc.stop();

    assert.strictEqual(await within(proc.whenFailed(), 300), 'pending');
  });

  it('survives stop() after a failed spawn', async () => {
    const proc = new KometProcess({ command: MISSING, port: 8123 });
    proc.start(() => undefined);
    await within(proc.whenFailed(), 5000);
    await assert.doesNotReject(() => proc.stop());
  });

  it('does not report a failure while the node is still running', async () => {
    const proc = new KometProcess({ command: await fakeNode('sleep 30'), port: 8123 });
    proc.start(() => undefined);

    assert.strictEqual(await within(proc.whenFailed(), 300), 'pending');
    await proc.stop();
  });
});
