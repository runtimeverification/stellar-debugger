/**
 * The turnkey pipeline: from a launch configuration to a replayable trace, in
 * one go.
 *
 *   (spawn + health-check komet-node) -> normalizeConfig -> SequenceRunner.run
 *
 * `normalizeConfig` (M1) folds the `transactions` sequence config into a
 * canonical `{ steps, trace }`, and the `SequenceRunner` (M3) executes it
 * against one accumulating komet-node ledger, never throwing on a FAILED tx and
 * fetching the traced step's trace regardless of status.
 *
 * In `attach` mode the spawn step is skipped and the pipeline talks to an
 * already-running node.
 *
 * Pure module (no `vscode` imports) so it can be driven against a mock node in
 * tests and against a real komet-node in integration.
 */

import { KometClient } from '../komet/KometClient';
import { KometProcess } from '../komet/KometProcess';
import { ProgressReporter, ResolvedTrace, SorobanLaunchArgs } from '../debugAdapter/types';
import { normalizeConfig, RawLaunchConfig } from './config';
import { SequenceRunner } from './SequenceRunner';

const HEALTH_TIMEOUT_MS = 60_000;

export class TurnkeyPipeline {
  private process?: KometProcess;

  async run(args: SorobanLaunchArgs, report: ProgressReporter): Promise<ResolvedTrace> {
    const attach = args.node?.attach ?? false;
    const host = args.node?.host ?? 'localhost';
    const port = args.node?.port ?? 8000;

    // 1. Normalize the launch config's `transactions` into a canonical
    // `{ steps, trace }`. This also validates it before we spawn.
    const normalized = normalizeConfig(args as RawLaunchConfig);

    // 2. Spawn komet-node unless attaching to a running one.
    if (!attach) {
      this.process = new KometProcess({
        command: args.node?.command,
        host,
        port,
        ioDir: args.node?.ioDir,
      });
      this.process.start(report);
    }

    const client = new KometClient({ host, port });
    report(`Waiting for komet-node at ${client.url} ...`);
    await client.waitForHealthy(HEALTH_TIMEOUT_MS);

    // 3. Execute the whole sequence and resolve the traced tx into a replayable
    // trace. The runner seeds the source account, deploys, invokes, and fetches
    // the traced step's trace regardless of status.
    return new SequenceRunner(client).run(normalized, { sourceSecret: args.sourceSecret }, report);
  }

  async dispose(): Promise<void> {
    if (this.process) {
      await this.process.stop();
      this.process = undefined;
    }
  }
}
