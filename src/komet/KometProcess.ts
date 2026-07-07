/**
 * Spawns and manages a komet-node process for the turnkey backend.
 *
 * Launch command defaults to `komet-node` (the binary kup puts on PATH).
 * Traces are not requested at launch any more — they are fetched per
 * transaction via the `traceTransaction` RPC. The process is health-checked via
 * the JSON-RPC `getHealth` method (see KometClient.waitForHealthy) before the
 * pipeline proceeds.
 *
 * Pure module (uses child_process, no `vscode` imports).
 */

import { ChildProcess, spawn } from 'child_process';
import { ProgressReporter } from '../debugAdapter/types';

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

export class KometProcess {
  private child?: ChildProcess;
  readonly host: string;
  readonly port: number;

  constructor(private readonly opts: KometProcessOptions) {
    this.host = opts.host ?? 'localhost';
    this.port = opts.port ?? 8000;
  }

  /** Spawn the node with tracing enabled. Does not wait for health. */
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
    this.child.stdout?.on('data', (d) => report(`[komet-node] ${d.toString().trimEnd()}`));
    this.child.stderr?.on('data', (d) => report(`[komet-node] ${d.toString().trimEnd()}`));
    this.child.on('error', (err) => report(`[komet-node] failed to spawn: ${err.message}`));
  }

  async stop(): Promise<void> {
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
}
