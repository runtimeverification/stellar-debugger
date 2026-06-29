/**
 * Spawns and manages a komet-node process for the turnkey backend.
 *
 * Launch command defaults to `python3 -m komet_node`; tracing is enabled
 * with `--trace`. The process is health-checked via the JSON-RPC `getHealth`
 * method (see KometClient.waitForHealthy) before the pipeline proceeds.
 *
 * Pure module (uses child_process, no `vscode` imports).
 */

import { ChildProcess, spawn } from 'child_process';
import { ProgressReporter } from '../debugAdapter/types';

export interface KometProcessOptions {
  /** Base command, e.g. "python3 -m komet_node". */
  command?: string;
  host?: string;
  port?: number;
  /** Path to the state.kore file. */
  stateFile?: string;
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
    const base = this.opts.command ?? 'python3 -m komet_node';
    const args = [
      '--host', this.host,
      '--port', String(this.port),
      '--trace',
    ];
    if (this.opts.stateFile) {
      args.push('--state-file', this.opts.stateFile);
    }
    const full = `${base} ${args.join(' ')}`;
    report(`Spawning komet-node: ${full}`);

    this.child = spawn(full, { cwd: this.opts.cwd, shell: true });
    this.child.stdout?.on('data', (d) => report(`[komet-node] ${d.toString().trimEnd()}`));
    this.child.stderr?.on('data', (d) => report(`[komet-node] ${d.toString().trimEnd()}`));
    this.child.on('error', (err) => report(`[komet-node] failed to spawn: ${err.message}`));
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3000);
      child.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
}
