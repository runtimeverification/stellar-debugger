/**
 * The sequence runner: execute a canonical `{ steps, trace }` (produced by
 * `normalizeConfig`) as an ordered sequence of transactions against one
 * accumulating komet-node ledger, then resolve the traced tx into a replayable
 * `ResolvedTrace`.
 *
 *   seed source (CreateAccount) ->
 *   per deploy: load wasm -> strip debug sections -> upload -> create contract
 *               (registering the handle id) ->
 *   per invoke: resolve handle -> substitute(args) -> spec-encode -> invoke ->
 *   fetch the TRACED step's trace by hash -> toTraceRecords -> TraceModel ->
 *   buildDebugArtifacts -> ResolvedTrace.
 *
 * Two behaviors the runner guarantees:
 *   1. It NEVER throws on a FAILED tx. Every step runs, each tx's status is
 *      reported to the debug console, and the traced step's trace is fetched
 *      regardless of its status — a reverting tx stays debuggable.
 *   2. Every envelope carries its own account sequence (`SorobanTxBuilder`), so
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
import { encodeInvokeArgs, substitute } from '../soroban/specEncode';
import { DeployStep, InvokeStep, NormalizedConfig } from './config';

/** Options controlling how the sequence is run. */
export interface RunOptions {
  /** Deterministic source secret; a stable derived key is used when omitted. */
  sourceSecret?: string;
}

/** A live contract behind a deploy handle. */
interface Deployed {
  contractId: string;
  /** The full (unstripped) wasm: debug artifacts and arg encoding both use it. */
  wasm: Buffer;
}

/** A submitted step: the tx whose trace represents it, and its symbol source. */
interface Submitted {
  hash: string;
  wasm: Buffer;
}

/** The state one run threads through its steps. */
interface RunContext {
  txBuilder: SorobanTxBuilder;
  source: Keypair;
  sourceAddress: string;
  /** Live contracts by handle id, filled as deploy steps execute. */
  deployed: Map<string, Deployed>;
  /** Submit an envelope, report the status it settles on, and return its hash. */
  submit: (what: string, envelopeXdr: string) => Promise<string>;
  report: ProgressReporter;
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

    /**
     * Submit one envelope and report the status komet-node settled on. A FAILED
     * (or unreachable) status is REPORTED, never raised: the sequence always
     * runs to completion so the traced step stays debuggable.
     */
    const submit = async (what: string, envelopeXdr: string): Promise<string> => {
      const { hash } = await this.client.sendTransaction(envelopeXdr);
      let status: string;
      try {
        status = (await this.client.getTransaction(hash)).status;
      } catch {
        status = 'UNKNOWN';
      }
      report(`${what}: ${status} (tx ${hash})`);
      return hash;
    };

    const ctx: RunContext = {
      txBuilder,
      source,
      sourceAddress,
      deployed: new Map(),
      submit,
      report,
    };

    // Seed the source account (self-seed; komet boots from empty state).
    await submit('Seeding source account (CreateAccount)', txBuilder.buildCreateAccount(source));

    /** Parallel to `config.steps`: what each step submitted. */
    const submitted: Submitted[] = [];
    for (const step of config.steps) {
      submitted.push(
        step.kind === 'deploy' ? await this.deploy(step, ctx) : await this.invoke(step, ctx),
      );
    }

    // Fetch the traced step's trace regardless of its status (blocker #1: a
    // reverting tx stays debuggable).
    const traced = submitted[config.trace];
    report(`Fetching trace for transaction ${traced.hash} ...`);
    const trace = await this.client.traceTransaction(traced.hash);

    const model = new TraceModel(toTraceRecords(trace));
    return { model, ...buildDebugArtifacts(traced.wasm, model, report) };
  }

  /** Upload + create a contract, registering its handle. */
  private async deploy(step: DeployStep, ctx: RunContext): Promise<Submitted> {
    const { txBuilder, source, submit, report } = ctx;
    const wasm = await this.loadWasm(step, report);

    // komet-node only executes the code; the DWARF custom sections just bloat
    // the KORE config it re-parses per RPC call, so strip them for the upload.
    // The code section stays byte-identical, keeping trace `pos` aligned with
    // the full `wasm` used for debug artifacts.
    const uploadWasm = stripDebugSections(wasm);
    report(`Uploading wasm for "${step.id}" (${wasm.length} bytes, ${uploadWasm.length} stripped) ...`);
    const upload = txBuilder.buildUploadWasm(source, Buffer.from(uploadWasm));
    await submit(`Upload "${step.id}"`, upload.envelopeXdr);

    // A deterministic salt (derived from the handle id) keeps the created
    // contract id reproducible across identical runs.
    const salt = createHash('sha256').update(step.id).digest();
    const create = txBuilder.buildCreateContract(source, upload.wasmHash, salt);
    ctx.deployed.set(step.id, { contractId: create.contractId, wasm });
    const hash = await submit(`Create "${step.id}" -> ${create.contractId}`, create.envelopeXdr);

    return { hash, wasm };
  }

  /** Resolve the handle, encode args (with substitution), and invoke. */
  private async invoke(step: InvokeStep, ctx: RunContext): Promise<Submitted> {
    const { txBuilder, source, sourceAddress, deployed, submit } = ctx;
    const target = deployed.get(step.contract);
    if (target === undefined) {
      throw new Error(`invoke references unresolved contract handle "${step.contract}"`);
    }

    const contracts = Object.fromEntries(
      [...deployed].map(([id, { contractId }]) => [id, contractId]),
    );
    const args = substitute(step.args, { sourceAddress, contracts });
    const scvals = await encodeInvokeArgs(target.wasm, step.function, args);
    const envelope = txBuilder.buildInvoke(source, target.contractId, step.function, scvals);
    const hash = await submit(`Invoke ${step.function} on "${step.contract}"`, envelope);

    return { hash, wasm: target.wasm };
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
