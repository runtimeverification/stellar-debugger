/**
 * Live backend: the turnkey pipeline — build the contract, spawn/attach to
 * komet-node, seed an account, deploy, invoke-with-trace — then hand the trace
 * to the replay session. Also serves `attach` mode (connect to a running node).
 *
 * Pure module (no `vscode` imports); delegates to TurnkeyPipeline.
 */

import { TurnkeyPipeline } from '../../pipeline/TurnkeyPipeline';
import { ProgressReporter, ResolvedTrace, SessionBackend, SorobanLaunchArgs } from '../types';

export class LiveBackend implements SessionBackend {
  private readonly pipeline = new TurnkeyPipeline();

  async resolve(args: SorobanLaunchArgs, report: ProgressReporter): Promise<ResolvedTrace> {
    return this.pipeline.run(args, report);
  }

  async dispose(): Promise<void> {
    await this.pipeline.dispose();
  }
}
