/**
 * The generalized sequence runner: execute a canonical `{ steps, trace }`
 * (produced by M1 `normalizeConfig`) as an ordered sequence of transactions
 * against one accumulating komet-node ledger, then resolve the traced tx into a
 * replayable `ResolvedTrace`.
 *
 * This generalizes the fixed 4-step `TurnkeyPipeline` into an arbitrary
 * `TxStep[]`, keeping the same acquisition flow per contract:
 *
 *   seed source (CreateAccount) ->
 *   per deploy: load wasm -> strip debug sections -> upload -> create contract
 *               (registers handle id -> contractId AND id -> wasm) ->
 *   per invoke: resolve handle -> Spec -> substitute(args) -> encode -> invoke ->
 *   fetch the TRACED step's trace by hash -> toTraceRecords -> TraceModel ->
 *   buildDebugArtifacts -> ResolvedTrace.
 *
 * Two behaviors this runner guarantees over the old pipeline (spec blockers):
 *   1. It NEVER throws on a FAILED tx. Every step runs; each `{hash, status}`
 *      is recorded, and the traced step's trace is fetched regardless of its
 *      status — a reverting tx stays debuggable.
 *   2. It assigns a DISTINCT, incrementing account sequence per submitted tx so
 *      byte-identical invokes hash differently and komet-node cannot dedup the
 *      second.
 *
 * The source account is DETERMINISTIC: the provided `sourceSecret` is used
 * verbatim, else a fixed derived keypair (never `Keypair.random()`), so the
 * same config yields the same source address.
 *
 * Pure module (no `vscode` imports): driveable against a mock node in tests.
 */

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { Keypair } from '@stellar/stellar-sdk';
import { KometClient } from '../komet/KometClient';
import { ContractBuilder } from '../build/ContractBuilder';
import { SorobanTxBuilder } from '../soroban/SorobanTxBuilder';
import { stripDebugSections } from '../wasm/sections';
import { toTraceRecords } from '../komet/trace';
import { TraceModel } from '../debugAdapter/TraceModel';
import { buildDebugArtifacts } from '../debugAdapter/artifacts';
import { ProgressReporter, ResolvedTrace } from '../debugAdapter/types';
import { loadContractSpec, encodeInvokeArgs, substitute, Spec } from '../soroban/specEncode';
import { DeployStep, InvokeStep, NormalizedConfig } from './config';

/** Options controlling how the sequence is run. */
export interface RunOptions {
  /** Deterministic source secret; a stable derived key is used when omitted. */
  sourceSecret?: string;
}

/** A submitted transaction's hash and final status, recorded per step. */
export interface SubmittedTx {
  hash: string;
  status: string;
}

/**
 * A fixed seed for the derived source keypair. Deterministic (NOT random), so
 * a config without an explicit `sourceSecret` still yields a stable source
 * address across runs. komet-node self-seeds via CreateAccount, so the exact
 * key does not matter — only its stability does.
 */
const DERIVED_SOURCE_SEED = Buffer.from(
  'komet-debugger-deterministic-source'.padEnd(32, '.').slice(0, 32),
);

export class SequenceRunner {
  constructor(private readonly client: KometClient) {}

  async run(
    config: NormalizedConfig,
    opts: RunOptions,
    report: ProgressReporter,
  ): Promise<ResolvedTrace> {
    const network = await this.client.getNetwork();
    const txBuilder = new SorobanTxBuilder(network.passphrase);

    const source = opts.sourceSecret
      ? Keypair.fromSecret(opts.sourceSecret)
      : Keypair.fromRawEd25519Seed(DERIVED_SOURCE_SEED);
    const sourceAddress = source.publicKey();
    report(`Source account: ${sourceAddress}`);

    // A distinct, incrementing account sequence per submitted tx keeps every
    // envelope's hash unique so komet-node cannot dedup identical invokes.
    let seq = 0;
    const submit = async (envelopeXdr: string): Promise<SubmittedTx> => {
      const sent = await this.client.sendTransaction(envelopeXdr);
      const status = await this.recordStatus(sent.hash);
      return { hash: sent.hash, status };
    };

    // Seed the source account (self-seed; komet boots from empty state).
    report('Seeding source account (CreateAccount) ...');
    await submit(txBuilder.buildCreateAccount(source, undefined, seq++));

    // Handle registries, filled as deploys execute.
    const contracts: Record<string, string> = {};
    const wasms: Record<string, Buffer> = {};
    const specs: Record<string, Spec> = {};

    // Per-step: the hash whose trace represents that step, and the wasm that
    // supplies its debug artifacts. Parallel to `config.steps`.
    const stepHash: (string | undefined)[] = new Array(config.steps.length);
    const stepWasm: (Buffer | undefined)[] = new Array(config.steps.length);

    for (let i = 0; i < config.steps.length; i++) {
      const step = config.steps[i];
      if (step.kind === 'deploy') {
        const { contractId, createTxHash, wasm } = await this.runDeploy(
          step,
          txBuilder,
          source,
          () => seq++,
          submit,
          report,
        );
        contracts[step.id] = contractId;
        wasms[step.id] = wasm;
        stepHash[i] = createTxHash;
        stepWasm[i] = wasm;
      } else {
        const invokeHash = await this.runInvoke(
          step,
          txBuilder,
          source,
          sourceAddress,
          contracts,
          wasms,
          specs,
          () => seq++,
          submit,
          report,
        );
        stepHash[i] = invokeHash;
        stepWasm[i] = wasms[step.contract];
      }
    }

    // Fetch the traced step's trace regardless of its status (blocker #1: a
    // reverting tx stays debuggable).
    const tracedHash = stepHash[config.trace];
    const tracedWasm = stepWasm[config.trace];
    if (tracedHash === undefined || tracedWasm === undefined) {
      throw new Error(`internal error: traced step ${config.trace} produced no submitted transaction`);
    }
    report(`Fetching trace for transaction ${tracedHash} ...`);
    const trace = await this.client.traceTransaction(tracedHash);

    const records = toTraceRecords(trace);
    const model = new TraceModel(records);
    const { source: sourceMapper, variables, disassembly, positions } = buildDebugArtifacts(
      tracedWasm,
      model,
      report,
    );

    return { model, source: sourceMapper, variables, disassembly, positions };
  }

  /** Upload + create a contract; register its id and full wasm bytes. */
  private async runDeploy(
    step: DeployStep,
    txBuilder: SorobanTxBuilder,
    source: Keypair,
    nextSeq: () => number,
    submit: (envelopeXdr: string) => Promise<SubmittedTx>,
    report: ProgressReporter,
  ): Promise<{ contractId: string; createTxHash: string; wasm: Buffer }> {
    const wasm = await this.loadWasm(step, report);

    // komet-node only executes the code; the DWARF custom sections just bloat
    // the KORE config it re-parses per RPC call, so strip them for the upload.
    // The code section stays byte-identical, keeping trace `pos` aligned with
    // the full `wasm` used for debug artifacts.
    const uploadWasm = stripDebugSections(wasm);
    report(`Uploading wasm for "${step.id}" (${wasm.length} bytes, ${uploadWasm.length} stripped) ...`);
    const upload = txBuilder.buildUploadWasm(source, Buffer.from(uploadWasm), nextSeq());
    await submit(upload.envelopeXdr);

    // A deterministic salt (derived from the handle id) keeps the created
    // contract id reproducible across identical runs.
    const salt = createHash('sha256').update(step.id).digest();
    const create = txBuilder.buildCreateContract(source, upload.wasmHash, salt, nextSeq());
    report(`Creating contract "${step.id}" -> ${create.contractId} ...`);
    const created = await submit(create.envelopeXdr);

    return { contractId: create.contractId, createTxHash: created.hash, wasm };
  }

  /** Resolve the handle, encode args (with substitution), and invoke. */
  private async runInvoke(
    step: InvokeStep,
    txBuilder: SorobanTxBuilder,
    source: Keypair,
    sourceAddress: string,
    contracts: Record<string, string>,
    wasms: Record<string, Buffer>,
    specs: Record<string, Spec>,
    nextSeq: () => number,
    submit: (envelopeXdr: string) => Promise<SubmittedTx>,
    report: ProgressReporter,
  ): Promise<string> {
    const contractId = contracts[step.contract];
    if (contractId === undefined) {
      throw new Error(`invoke references unresolved contract handle "${step.contract}"`);
    }

    let spec = specs[step.contract];
    if (spec === undefined) {
      spec = await loadContractSpec(wasms[step.contract]);
      specs[step.contract] = spec;
    }

    const substituted = substitute(step.args, { sourceAddress, contracts });
    const scvals = encodeInvokeArgs(spec, step.function, substituted);
    report(`Invoking ${step.function} on "${step.contract}" ...`);
    const envelope = txBuilder.buildInvoke(source, contractId, step.function, scvals, nextSeq());
    const sent = await submit(envelope);
    return sent.hash;
  }

  /**
   * Fetch a submitted tx's final status. NEVER throws: a FAILED status is
   * recorded, not raised, so the sequence always runs to completion.
   */
  private async recordStatus(hash: string): Promise<string> {
    try {
      const result = await this.client.getTransaction(hash);
      return result.status;
    } catch {
      return 'UNKNOWN';
    }
  }

  /** Load a deploy's wasm: a prebuilt `wasm` path, or build a `contract` dir. */
  private async loadWasm(step: DeployStep, report: ProgressReporter): Promise<Buffer> {
    if (step.wasm) {
      return fs.readFile(step.wasm);
    }
    const builder = new ContractBuilder();
    const wasmPath = await builder.build(
      {
        contractDir: step.contract!,
        buildCommand: step.buildCommand,
        debugInfo: step.debugInfo,
      },
      report,
    );
    return fs.readFile(wasmPath);
  }
}
