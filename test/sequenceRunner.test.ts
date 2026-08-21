/**
 * The sequence runner core, exercised against the MOCK komet-node
 * (test/support/mockKometNode.ts) — NO real komet-node, NO network.
 *
 * A `SequenceRunner` executes a normalized `{ steps, trace }` (from
 * `normalizeConfig`) against a `KometClient` — seed source -> per deploy: upload
 * + create -> per invoke: build + send -> fetch the traced tx's trace ->
 * `buildDebugArtifacts` — and returns a `ResolvedTrace`:
 *
 *   const runner = new SequenceRunner(new KometClient({ host, port }));
 *   const resolved = await runner.run(
 *     normalizeConfig(raw),          // { steps, trace }
 *     { sourceSecret? },             // deterministic source options
 *     report,                        // progress reporter
 *   );
 *
 * Behaviour is verified through the traffic the mock RECORDS (submitted
 * envelopes, in order, and the hash passed to traceTransaction), decoded with
 * `@stellar/stellar-sdk`. The mock hashes submissions positionally
 * (`hashFor(n)` = the 1-based send order, hex, left-padded to 64), so the hash
 * of the k-th `sendTransaction` is `(k+1).toString(16).padStart(64,'0')`.
 *
 * Fixtures are the committed wasms; compiled tests live in out/test/, so the
 * fixture dir is two levels up under the source tree.
 */

import * as assert from 'assert';
import * as path from 'path';
import {
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { normalizeConfig } from '../src/pipeline/config';
import { SequenceRunner } from '../src/pipeline/SequenceRunner';
import { KometClient } from '../src/komet/KometClient';
import { MockKometNode } from './support/mockKometNode';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const COMPOSITE_WASM = path.join(FIXTURES, 'composite.wasm');
const CTOR_WASM = path.join(FIXTURES, 'ctor_probe.wasm');

// A deterministic source; its secret lets the source-account tests assert the
// exact seeded public key. Derived from a fixed seed, never `Keypair.random()`.
const SOURCE = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3));
const SOURCE_SECRET = SOURCE.secret();
const SOURCE_PUBKEY = SOURCE.publicKey();

// A tiny synthetic trace the mock serves for whichever tx is traced. Its length
// is the only property these tests read (which is deterministic regardless of
// the traced wasm), so it stays small and fixture-independent.
const TRACE = [
  '{"kind":"callContract","function":"run","args":[],"depth":1}',
  '{"kind":"instr","pos":3,"instr":["const","i32",1],"stack":[],"locals":{}}',
  '{"kind":"instr","pos":5,"instr":["return"],"stack":[["u32",1]],"locals":{}}',
  '{"kind":"endWasm","success":true,"result":{"type":"u32","value":1}}',
].join('\n');
const TRACE_LEN = 4;

// The mock reports Networks.TESTNET from getNetwork, so envelopes are signed and
// decoded under that passphrase.
const NET = Networks.TESTNET;

interface DecodedSend {
  index: number;
  /** The hash the mock returned for this submission (positional). */
  hash: string;
  /** Canonical kind: createAccount | uploadWasm | createContract | invoke. */
  kind: string;
  /** Raw base64 XDR envelope, for byte-identity comparisons. */
  envelope: string;
  /** The transaction sequence number, as a string. */
  sequence: string;
  /** Invoke only: function name. */
  fn?: string;
  /** Invoke only: the resolved target contract address ("C..."). */
  target?: string;
  /** Invoke only: the call args, decoded to native. */
  args?: unknown[];
}

/** The hash the mock returns for the k-th (0-based) sendTransaction. */
function sendHash(k: number): string {
  return (k + 1).toString(16).padStart(64, '0');
}

function classify(op: any): string {
  if (op.type === 'createAccount') {
    return 'createAccount';
  }
  if (op.type === 'invokeHostFunction') {
    const name = op.func.switch().name as string;
    if (name === 'hostFunctionTypeUploadContractWasm') {
      return 'uploadWasm';
    }
    if (name === 'hostFunctionTypeCreateContractV2') {
      return 'createContract';
    }
    if (name === 'hostFunctionTypeInvokeContract') {
      return 'invoke';
    }
    return name;
  }
  return op.type;
}

/** Decode every submitted envelope, in submission order, with its mock hash. */
function decodeSends(mock: MockKometNode): DecodedSend[] {
  return mock.envelopes('sendTransaction').map((envelope, index) => {
    const tx = TransactionBuilder.fromXDR(envelope, NET) as any;
    const op = tx.operations[0];
    const kind = classify(op);
    const base: DecodedSend = {
      index,
      hash: sendHash(index),
      kind,
      envelope,
      sequence: tx.sequence,
    };
    if (kind === 'invoke') {
      const ic = op.func.invokeContract();
      base.fn = ic.functionName().toString();
      base.target = scValToNative(xdr.ScVal.scvAddress(ic.contractAddress())) as string;
      base.args = ic.args().map((a: xdr.ScVal) => scValToNative(a));
    }
    return base;
  });
}

function invokeSends(mock: MockKometNode): DecodedSend[] {
  return decodeSends(mock).filter((s) => s.kind === 'invoke');
}

/** The single hash the runner passed to traceTransaction. */
function tracedHash(mock: MockKometNode): string {
  const calls = mock.received.filter((r) => r.method === 'traceTransaction');
  assert.strictEqual(calls.length, 1, 'expected exactly one traceTransaction call');
  return calls[0].params.hash;
}

/** assert.deepStrictEqual as a predicate (handles bigint, which JSON cannot). */
function deepEqual(a: unknown, b: unknown): boolean {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

describe('SequenceRunner', () => {
  let mocks: MockKometNode[] = [];

  afterEach(async () => {
    await Promise.all(mocks.map((m) => m.stop()));
    mocks = [];
  });

  interface RunOpts {
    sourceSecret?: string;
    traceStatus?: string;
  }

  /** Start a fresh mock, run the (normalized) config, return both for inspection. */
  async function runSeq(raw: unknown, opts: RunOpts = {}) {
    const mock = new MockKometNode({ trace: TRACE, traceStatus: opts.traceStatus });
    mocks.push(mock);
    const port = await mock.start();
    const client = new KometClient({ host: '127.0.0.1', port });
    const runner = new SequenceRunner(client);
    const resolved = await runner.run(
      normalizeConfig(raw as any),
      { sourceSecret: opts.sourceSecret },
      () => undefined,
    );
    return { mock, resolved };
  }

  // ------------------------------------------------------------------------
  // 1. Steps execute IN ORDER; a deploy registers a handle later invokes use.
  // ------------------------------------------------------------------------
  describe('ordered execution + handle registration', () => {
    const raw = {
      type: 'stellar',
      request: 'launch',
      transactions: [
        { kind: 'deploy', id: 'probe', wasm: CTOR_WASM },
        {
          kind: 'invoke',
          contract: 'probe',
          function: '__constructor',
          args: { admin: '${sourceAddress}' },
        },
        { kind: 'invoke', contract: 'probe', function: 'admin_set', args: { _nonce: 1 } },
      ],
    };

    it('submits seed -> upload -> create -> invoke -> invoke, in that order', async () => {
      const { mock } = await runSeq(raw, { sourceSecret: SOURCE_SECRET });
      assert.deepStrictEqual(
        decodeSends(mock).map((s) => s.kind),
        ['createAccount', 'uploadWasm', 'createContract', 'invoke', 'invoke'],
      );
    });

    it('resolves both invokes to the SAME contract id registered by the deploy', async () => {
      const { mock } = await runSeq(raw, { sourceSecret: SOURCE_SECRET });
      const invokes = invokeSends(mock);
      assert.strictEqual(invokes.length, 2);
      // A single deploy handle -> one live contract id, shared by both invokes.
      assert.strictEqual(invokes[0].target, invokes[1].target);
      assert.ok(
        StrKey.isValidContract(invokes[0].target as string),
        `expected a valid "C..." contract id, got ${invokes[0].target}`,
      );
    });

    it('substitutes ${sourceAddress} into the __constructor invoke args', async () => {
      const { mock } = await runSeq(raw, { sourceSecret: SOURCE_SECRET });
      const ctor = invokeSends(mock).find((s) => s.fn === '__constructor');
      assert.ok(ctor, 'expected a __constructor invoke');
      // The single `admin` arg resolves to the seeded source public key.
      assert.deepStrictEqual(ctor!.args, [SOURCE_PUBKEY]);
    });
  });

  // ------------------------------------------------------------------------
  // 2. Substitution (${sourceAddress} / ${contract:id}) THEN spec-encoding of
  //    composite args, end-to-end through the runner (composite.wasm).
  // ------------------------------------------------------------------------
  describe('substitution + spec-driven composite encoding (composite.wasm)', () => {
    it('substitutes both token kinds and spec-encodes the composite Vec<(AssetKey,i128)>', async () => {
      const raw = {
        type: 'stellar',
        request: 'launch',
        transactions: [
          { kind: 'deploy', id: 'pool', wasm: COMPOSITE_WASM },
          {
            kind: 'invoke',
            contract: 'pool',
            function: 'supply',
            args: {
              // ${sourceAddress} -> the seeded G-address;
              // ${contract:pool} -> pool's own derived C-address (the invoke target).
              requests: [
                [{ tag: 'Stellar', values: ['${sourceAddress}'] }, '1'],
                [{ tag: 'Stellar', values: ['${contract:pool}'] }, '2'],
              ],
            },
          },
        ],
      };

      const { mock } = await runSeq(raw, { sourceSecret: SOURCE_SECRET });
      const supply = invokeSends(mock).find((s) => s.fn === 'supply');
      assert.ok(supply, 'expected a supply invoke');

      // Encoded as a single top-level composite arg, round-tripping to the
      // spec's native shape: unit-tag payloads are `['Stellar', <addr>]`, i128s
      // are bigint. ${contract:pool} resolved to the invoke's own target id.
      assert.deepStrictEqual(supply!.args, [
        [
          [['Stellar', SOURCE_PUBKEY], 1n],
          [['Stellar', supply!.target], 2n],
        ],
      ]);
      assert.ok(StrKey.isValidContract(supply!.target as string));
    });
  });

  // ------------------------------------------------------------------------
  // 3. Anti-dedup: two byte-identical invokes yield DIFFERENT envelopes/hashes
  //    (distinct sequence numbers), so komet-node cannot dedup the second.
  // ------------------------------------------------------------------------
  describe('anti-dedup (distinct sequence numbers per tx)', () => {
    it('two identical invoke requests produce different envelopes and sequence numbers', async () => {
      const identicalInvoke = {
        kind: 'invoke',
        contract: 'pool',
        function: 'supply',
        args: { requests: [[{ tag: 'Native' }, '1000']] },
      };
      const raw = {
        type: 'stellar',
        request: 'launch',
        transactions: [
          { kind: 'deploy', id: 'pool', wasm: COMPOSITE_WASM },
          { ...identicalInvoke },
          { ...identicalInvoke },
        ],
      };

      const { mock } = await runSeq(raw, { sourceSecret: SOURCE_SECRET });
      const invokes = invokeSends(mock);
      assert.strictEqual(invokes.length, 2);

      // Same call, same args: byte-for-byte identical INTENT ...
      // args = [ <requests vec> ]; the vec holds one tuple [ <AssetKey>, <i128> ];
      // the unit variant Native decodes to ['Native'], the i128 to a bigint.
      assert.strictEqual(invokes[0].fn, invokes[1].fn);
      assert.ok(deepEqual(invokes[0].args, [[[['Native'], 1000n]]]));
      assert.ok(deepEqual(invokes[0].args, invokes[1].args));

      // ... yet DIFFERENT envelopes, driven by distinct sequence numbers, so the
      // node sees two distinct hashes rather than deduping the second.
      assert.notStrictEqual(invokes[0].sequence, invokes[1].sequence);
      assert.notStrictEqual(invokes[0].envelope, invokes[1].envelope);
      assert.notStrictEqual(invokes[0].hash, invokes[1].hash);
    });
  });

  // ------------------------------------------------------------------------
  // 4. A FAILED step never throws/aborts; the sequence completes and the traced
  //    step's trace is STILL fetched (blocker #1 — a reverting tx stays
  //    debuggable). The mock's traceStatus override marks getTransaction FAILED.
  // ------------------------------------------------------------------------
  describe('no-throw on FAILED + trace still fetched', () => {
    const raw = {
      type: 'stellar',
      request: 'launch',
      transactions: [
        { kind: 'deploy', id: 'pool', wasm: COMPOSITE_WASM },
        {
          kind: 'invoke',
          contract: 'pool',
          function: 'supply',
          args: { requests: [[{ tag: 'Native' }, '1000']] },
        },
      ],
    };

    it('completes the run without throwing even though every step reports FAILED', async () => {
      await assert.doesNotReject(() => runSeq(raw, { sourceSecret: SOURCE_SECRET, traceStatus: 'FAILED' }));
    });

    it('still fetches the traced step trace and returns a valid replayable model', async () => {
      const { mock, resolved } = await runSeq(raw, {
        sourceSecret: SOURCE_SECRET,
        traceStatus: 'FAILED',
      });
      // The trace was fetched despite the FAILED status ...
      assert.strictEqual(mock.calls('traceTransaction'), 1);
      // ... and parsed into a replayable model of the expected length.
      assert.strictEqual(resolved.model.length, TRACE_LEN);
    });
  });

  // ------------------------------------------------------------------------
  // 5. Trace selection: by "last" (default), by index, and by an invoke id,
  //    each fetching the trace of the CORRECT submitted tx.
  // ------------------------------------------------------------------------
  describe('trace selection resolves to the right submitted tx', () => {
    // Two invokes with DISTINCT args (Other 1 / Other 2) so each maps to an
    // identifiable submitted tx; each also carries an `id`.
    const raw = {
      type: 'stellar',
      request: 'launch',
      transactions: [
        { kind: 'deploy', id: 'pool', wasm: COMPOSITE_WASM },
        {
          kind: 'invoke',
          id: 'first',
          contract: 'pool',
          function: 'supply',
          args: { requests: [[{ tag: 'Other', values: [1] }, '1']] },
        },
        {
          kind: 'invoke',
          id: 'second',
          contract: 'pool',
          function: 'supply',
          args: { requests: [[{ tag: 'Other', values: [2] }, '2']] },
        },
      ],
    };

    const FIRST_ARGS = [[[['Other', 1], 1n]]];
    const SECOND_ARGS = [[[['Other', 2], 2n]]];

    /** The mock hash of the invoke send whose decoded args match `expected`. */
    function hashOfInvoke(mock: MockKometNode, expected: unknown): string {
      const match = invokeSends(mock).find((s) => deepEqual(s.args, expected));
      assert.ok(match, `no submitted invoke matched args ${JSON.stringify(expected, bigintSafe)}`);
      return match!.hash;
    }

    it('"last" (default) traces the final invoke', async () => {
      const { mock } = await runSeq(raw); // no `trace` -> default "last"
      assert.strictEqual(tracedHash(mock), hashOfInvoke(mock, SECOND_ARGS));
    });

    it('an integer index traces exactly that step', async () => {
      // Step 1 is the `first` invoke (step 0 is the deploy).
      const { mock } = await runSeq({ ...raw, trace: 1 });
      assert.strictEqual(tracedHash(mock), hashOfInvoke(mock, FIRST_ARGS));
    });

    it('an invoke `id` selector traces the invoke with that id', async () => {
      const { mock: m1 } = await runSeq({ ...raw, trace: 'first' });
      assert.strictEqual(tracedHash(m1), hashOfInvoke(m1, FIRST_ARGS));

      const { mock: m2 } = await runSeq({ ...raw, trace: 'second' });
      assert.strictEqual(tracedHash(m2), hashOfInvoke(m2, SECOND_ARGS));
    });
  });

  // ------------------------------------------------------------------------
  // 6. Deterministic source: same config -> same source address, never random.
  // ------------------------------------------------------------------------
  describe('deterministic source account', () => {
    const raw = {
      type: 'stellar',
      request: 'launch',
      transactions: [
        { kind: 'deploy', id: 'pool', wasm: COMPOSITE_WASM },
        {
          kind: 'invoke',
          contract: 'pool',
          function: 'supply',
          args: { requests: [[{ tag: 'Native' }, '1000']] },
        },
      ],
    };

    /** The seeded source public key = the CreateAccount destination (first send). */
    function seededSource(mock: MockKometNode): string {
      const first = mock.envelopes('sendTransaction')[0];
      const op = (TransactionBuilder.fromXDR(first, NET) as any).operations[0];
      assert.strictEqual(op.type, 'createAccount');
      return op.destination as string;
    }

    it('uses the provided sourceSecret verbatim', async () => {
      const { mock } = await runSeq(raw, { sourceSecret: SOURCE_SECRET });
      assert.strictEqual(seededSource(mock), SOURCE_PUBKEY);
    });

    it('derives a STABLE source when no secret is given (never Keypair.random)', async () => {
      const { mock: a } = await runSeq(raw);
      const { mock: b } = await runSeq(raw);
      const sa = seededSource(a);
      const sb = seededSource(b);
      assert.ok(StrKey.isValidEd25519PublicKey(sa), `expected a valid "G..." source, got ${sa}`);
      // Same config -> same source across independent runs (a random keypair
      // would differ here).
      assert.strictEqual(sa, sb);
    });
  });
});

/** JSON.stringify replacer that renders bigint (for error messages only). */
function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? `${value}n` : value;
}
