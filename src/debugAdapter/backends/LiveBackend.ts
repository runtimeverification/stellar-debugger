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
    await client.waitForHealthy(HEALTH_TIMEOUT_MS);

    // Execute the whole sequence: seed the source account, deploy, invoke, and
    // resolve the traced tx into a replayable trace regardless of its status.
    return new SequenceRunner(client).run(normalized, { sourceSecret: args.sourceSecret }, report);
  }

  async dispose(): Promise<void> {
    if (this.process) {
      await this.process.stop();
      this.process = undefined;
    }
  }
}
