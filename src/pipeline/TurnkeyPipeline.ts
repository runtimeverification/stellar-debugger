/**
 * The turnkey pipeline: from contract source to a replayable trace, in one go.
 *
 *   build wasm -> (spawn + health-check komet-node) -> seed account ->
 *   upload wasm -> create contract -> invoke-with-trace -> parse trace.
 *
 * In `attach` mode the build and spawn steps are skipped and the pipeline talks
 * to an already-running node.
 *
 * Pure module (no `vscode` imports) so it can be driven against a mock node in
 * tests and against a real komet-node in integration.
 */

import { randomBytes } from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { KometClient } from '../komet/KometClient';
import { KometProcess } from '../komet/KometProcess';
import { ContractBuilder } from '../build/ContractBuilder';
import { SorobanTxBuilder } from '../soroban/SorobanTxBuilder';
import { encodeArgs } from '../soroban/scval';
import { parseTraceJsonl } from '../komet/trace';
import { promises as fs } from 'fs';
import { TraceModel } from '../debugAdapter/TraceModel';
import { TraceListingSource } from '../sourcemap/SourceMapper';
import { ProgressReporter, ResolvedTrace, SorobanLaunchArgs } from '../debugAdapter/types';

const HEALTH_TIMEOUT_MS = 60_000;

export class TurnkeyPipeline {
  private process?: KometProcess;

  async run(args: SorobanLaunchArgs, report: ProgressReporter): Promise<ResolvedTrace> {
    const attach = args.node?.attach ?? false;
    const host = args.node?.host ?? 'localhost';
    const port = args.node?.port ?? 8000;

    // 1. Build (or locate) the contract wasm.
    const wasm = await this.loadWasm(args, report);

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

    const network = await client.getNetwork();
    const passphrase = network.passphrase;
    const txBuilder = new SorobanTxBuilder(passphrase);

    // 3. Source account.
    const source = args.sourceSecret ? Keypair.fromSecret(args.sourceSecret) : Keypair.random();
    report(`Source account: ${source.publicKey()}`);
    report('Seeding source account (CreateAccount) ...');
    await client.sendTransaction(txBuilder.buildCreateAccount(source));

    // 4. Upload wasm.
    report('Uploading contract wasm ...');
    const upload = txBuilder.buildUploadWasm(source, wasm);
    await client.sendTransaction(upload.envelopeXdr);

    // 5. Create contract.
    const salt = randomBytes(32);
    const create = txBuilder.buildCreateContract(source, upload.wasmHash, salt);
    report(`Creating contract ${create.contractId} ...`);
    await client.sendTransaction(create.envelopeXdr);

    // 6. Invoke, then fetch its trace by hash. The node submits the envelope
    // (sendTransaction) and exposes the per-instruction trace separately via
    // traceTransaction(hash); the final status comes from getTransaction(hash).
    const scvalArgs = encodeArgs(args.args);
    report(`Invoking ${args.function}(${(args.args ?? []).map((a) => JSON.stringify(a.value)).join(', ')}) with trace ...`);
    const invokeXdr = txBuilder.buildInvoke(source, create.contractId, args.function, scvalArgs);
    const sent = await client.sendTransaction(invokeXdr);

    const result = await client.getTransaction(sent.hash);
    if (result.status === 'FAILED') {
      throw new Error(
        `Invocation of ${args.function}(...) failed on komet-node (status FAILED, tx ${sent.hash}). ` +
          `Note: the current komet-node only completes contract calls that return no value — ` +
          `its callTx handling asserts a Void result, so any function returning a value gets ` +
          `stuck and the transaction is reported FAILED. Try a function that returns () / no value, ` +
          `or update komet-node.`,
      );
    }

    const trace = await client.traceTransaction(sent.hash);

    // 7. Parse trace into the replay model.
    const records = parseTraceJsonl(trace);
    const model = new TraceModel(records);
    const source2 = new TraceListingSource(model);

    return { model, source: source2 };
  }

  async dispose(): Promise<void> {
    if (this.process) {
      await this.process.stop();
      this.process = undefined;
    }
  }

  private async loadWasm(args: SorobanLaunchArgs, report: ProgressReporter): Promise<Buffer> {
    const builder = new ContractBuilder();
    const wasmPath = await builder.build(
      {
        contractDir: args.contract ?? process.cwd(),
        buildCommand: args.buildCommand,
        wasmPath: args.wasmPath,
      },
      report,
    );
    return fs.readFile(wasmPath);
  }
}
