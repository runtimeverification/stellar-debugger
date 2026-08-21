/**
 * Live backend: from a launch configuration to a replayable trace, in one go.
 *
 *   (spawn + health-check komet-node) -> normalizeConfig -> SequenceRunner.run
 *
 * `normalizeConfig` folds the `transactions` sequence into a canonical
 * `{ steps, trace }`, and the `SequenceRunner` executes it against one
 * accumulating komet-node ledger, never throwing on a FAILED tx and fetching the
 * traced step's trace regardless of status.
 *
 * In `attach` mode the spawn step is skipped and the backend talks to an
 * already-running node.
 *
 * Pure module (no `vscode` imports) so it can be driven against a mock node in
 * tests and against a real komet-node in integration.
 */

import { KometClient } from '../../komet/KometClient';
import { KometProcess } from '../../komet/KometProcess';
import { normalizeConfig } from '../../pipeline/config';
import { SequenceRunner } from '../../pipeline/SequenceRunner';
import { ProgressReporter, ResolvedTrace, SessionBackend, SorobanLaunchArgs } from '../types';
import { kometUnreachable } from '../../diagnostics/setup';

/** Default deadline for the node to answer `getHealth`; `node.healthTimeoutMs` overrides. */
const HEALTH_TIMEOUT_MS = 60_000;

// Generous per-RPC default: large contracts can take minutes for komet-node to
// parse into KORE, and a 60s limit aborted them mid-flight, surfacing to the
// user as a confusing "operation was cancelled".
const DEFAULT_RPC_TIMEOUT_MS = 600_000;

export class LiveBackend implements SessionBackend {
  private process?: KometProcess;

  async resolve(args: SorobanLaunchArgs, report: ProgressReporter): Promise<ResolvedTrace> {
    const node = args.node ?? {};
    const host = node.host ?? 'localhost';
    const port = node.port ?? 8000;

    // Normalize (and thereby validate) the launch config before spawning.
    const normalized = normalizeConfig(args);

    if (!(node.attach ?? false)) {
      this.process = new KometProcess({ command: node.command, host, port, ioDir: node.ioDir });
      this.process.start(report);
    }

    const client = new KometClient({
      host,
      port,
      timeoutMs: node.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
    });
    report(`Waiting for komet-node at ${client.url} ...`);
    await this.waitUntilServing(client, {
      attach: node.attach ?? false,
      timeoutMs: node.healthTimeoutMs ?? HEALTH_TIMEOUT_MS,
      port,
    });

    // Execute the whole sequence: seed the source account, deploy, invoke, and
    // resolve the traced tx into a replayable trace regardless of its status.
    return new SequenceRunner(client).run(normalized, { sourceSecret: args.sourceSecret }, report);
  }

  /**
   * Wait for the node to answer `getHealth`, and explain it when it never does.
   *
   * A node we spawned can fail in a way we learn about immediately — no such
   * binary, or an exit during boot — so the health wait races
   * `KometProcess.whenFailed()`: that turns a 60-second timeout into an instant,
   * accurate message. When the node does come up, the failure promise is simply
   * abandoned (it resolves rather than rejects, so nothing goes unhandled).
   */
  private async waitUntilServing(
    client: KometClient,
    opts: { attach: boolean; timeoutMs: number; port: number },
  ): Promise<void> {
    // `giveUp` ends the poll loop as soon as the node is known to be doomed, so
    // no request keeps hitting a dead port after this method has thrown.
    const healthy = client
      .waitForHealthy(opts.timeoutMs, undefined, () => this.process?.currentFailure() !== undefined)
      .then(() => 'healthy' as const);
    const failure = this.process?.whenFailed();
    const outcome = await Promise.race(failure ? [healthy, failure] : [healthy]).catch(() => {
      // The deadline passed. If the process died meanwhile, its own reason is
      // the better one; otherwise the node is up but mute.
      throw (
        this.process?.currentFailure() ??
        kometUnreachable({ url: client.url, ...opts })
      );
    });
    if (outcome !== 'healthy') {
      throw outcome;
    }
  }

  async dispose(): Promise<void> {
    if (this.process) {
      await this.process.stop();
      this.process = undefined;
    }
  }
}
