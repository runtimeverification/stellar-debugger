/**
 * Spawns and manages a komet-node process for the turnkey backend.
 *
 * Launch command defaults to `komet-node` (the binary kup puts on PATH). The
 * node is started with no tracing flags — a trace is fetched per transaction via
 * the `traceTransaction` RPC — and is health-checked via the JSON-RPC
 * `getHealth` method (see KometClient.waitForHealthy) before the pipeline
 * proceeds.
 *
 * Failures are surfaced through `whenFailed()`, which LiveBackend races the
 * health check against: a node that cannot be spawned (not installed, not
 * executable) or that dies during boot is known to be a lost cause the moment it
 * happens, and waiting out the health-check deadline would only replace a
 * precise diagnosis with a timeout.
 *
 * Pure module (uses child_process, no `vscode` imports).
 */

import { ChildProcess, spawn } from 'child_process';
import { ProgressReporter } from '../debugAdapter/types';
import { SetupError, kometExitedEarly, kometSpawnFailure } from '../diagnostics/setup';

export interface KometProcessOptions {
  /** Base command, e.g. "komet-node". */
  command?: string;
  host?: string;
  port?: number;
  /** Directory for komet-node's I/O artifacts (`--io-dir`). */
  ioDir?: string;
  /** Working directory for the process. */
  cwd?: string;
}

/** How many trailing output lines are kept to explain an early exit. */
const OUTPUT_TAIL_LINES = 20;

export class KometProcess {
  private child?: ChildProcess;
  readonly host: string;
  readonly port: number;

  /** The failure, once one is known; `whenFailed()` settles with it. */
  private failure?: SetupError;
  private readonly failureWaiters: ((failure: SetupError) => void)[] = [];
  /** Set by `stop()`, so a shutdown we asked for is not reported as a failure. */
  private stopping = false;
  /** Ring buffer of the node's most recent output, for the failure message. */
  private readonly outputTail: string[] = [];

  constructor(private readonly opts: KometProcessOptions) {
    this.host = opts.host ?? 'localhost';
    this.port = opts.port ?? 8000;
  }

  /** Spawn the node. Does not wait for it to become healthy. */
  start(report: ProgressReporter): void {
    const base = this.opts.command ?? 'komet-node';
    const args = [
      '--host', this.host,
      '--port', String(this.port),
    ];
    if (this.opts.ioDir) {
      args.push('--io-dir', this.opts.ioDir);
    }
    report(`Spawning komet-node: ${base} ${args.join(' ')}`);

    // `detached: true` makes the child a process-group leader so that stop() can
    // signal the whole group. komet-node itself spawns the K interpreter as a
    // child; killing only komet-node (or, worse, a `sh -c` wrapper) would orphan
    // those grandchildren, leaving the port bound. We spawn without a shell for
    // the same reason — a shell wrapper is a separate process that swallows the
    // signal and orphans the real node.
    this.child = spawn(base, args, { cwd: this.opts.cwd, detached: true });
    this.child.stdout?.on('data', (d) => this.onOutput(d, report));
    this.child.stderr?.on('data', (d) => this.onOutput(d, report));
    this.child.on('error', (err) => {
      const failure = kometSpawnFailure({ command: base, error: err });
      // Only the headline goes to the log: the full message — install hint,
      // README link and all — is the thrown error, and printing both would
      // duplicate the whole thing on a CLI, where both land on stderr.
      report(`[komet-node] ${failure.message.split('\n')[0]}`);
      this.fail(failure);
    });
    // An exit before the health check passes is fatal — the pipeline has nothing
    // to talk to — and the node's own output usually says why (a bound port, a
    // missing K distribution). A deliberate stop() sets `stopping` first.
    this.child.on('exit', (code, signal) => {
      // A process that never spawned reports itself through 'error' above, with
      // a far better message than "exited with code unknown".
      if (this.child?.pid === undefined) {
        return;
      }
      this.fail(
        kometExitedEarly({
          command: base,
          code,
          signal,
          output: this.outputTail,
          port: this.port,
        }),
      );
    });
  }

  /**
   * Settles with the reason the node will never serve. Stays pending while the
   * node is alive and after a deliberate `stop()`, so it is safe to race against
   * the health check and simply abandon when the node comes up.
   */
  whenFailed(): Promise<SetupError> {
    if (this.failure) {
      return Promise.resolve(this.failure);
    }
    return new Promise<SetupError>((resolve) => this.failureWaiters.push(resolve));
  }

  /** The failure so far, if any: what a health-check timeout should defer to. */
  currentFailure(): SetupError | undefined {
    return this.failure;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null || child.pid === undefined) {
      return;
    }
    const pid = child.pid;
    // Negative pid targets the whole process group (see `detached: true` above),
    // so the K interpreter subprocess dies with the node.
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-pid, signal);
      } catch {
        // Group already gone, or never became a leader; fall back to the child.
        try {
          child.kill(signal);
        } catch {
          /* already dead */
        }
      }
    };
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        killGroup('SIGKILL');
        resolve();
      }, 3000);
      child.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
      killGroup('SIGTERM');
    });
  }

  /** Mirror node output to the console, keeping the tail for diagnostics. */
  private onOutput(chunk: unknown, report: ProgressReporter): void {
    const text = String(chunk).trimEnd();
    report(`[komet-node] ${text}`);
    this.outputTail.push(text);
    if (this.outputTail.length > OUTPUT_TAIL_LINES) {
      this.outputTail.splice(0, this.outputTail.length - OUTPUT_TAIL_LINES);
    }
  }

  /** Record the first failure and release anyone waiting on it. */
  private fail(failure: SetupError): void {
    if (this.stopping || this.failure) {
      return;
    }
    this.failure = failure;
    for (const resolve of this.failureWaiters.splice(0)) {
      resolve(failure);
    }
  }
}
