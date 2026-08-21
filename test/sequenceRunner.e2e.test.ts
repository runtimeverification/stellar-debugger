/**
 * The multi-transaction pipeline, end-to-end against a REAL komet-node.
 *
 * These are the ONLY tests that can catch a breaking change in komet-node's
 * JSON-RPC surface, its trace format, or its cross-transaction ledger
 * semantics — a mock or a pre-recorded fixture, by construction, keeps testing
 * yesterday's behaviour. So they are MANDATORY and run by default (the
 * devcontainer and CI install the node via `kup install komet-node`). If
 * `komet-node` is not on PATH the suite FAILS LOUDLY rather than skipping
 * silently — set KOMET_NODE_E2E=0 to opt out only where the node genuinely
 * cannot be installed. (Same convention as test/integration.node.test.ts.)
 *
 * Everything is driven through `LiveBackend.resolve(config, report)`, which
 * normalizes the `transactions` config and executes it through the
 * `SequenceRunner` against the spawned node. The scenarios pinned here:
 *
 *   1. deploy ctor_probe -> invoke __constructor(admin:${sourceAddress}) ->
 *      invoke admin_set(_nonce:1), trace "last": a non-empty, replayable trace
 *      comes back AND the constructor's storage write persisted to the later tx.
 *   2. deploy composite -> invoke supply with a real Vec<(AssetKey,i128)>: the
 *      txBuilder spec-encodes the argument as an SCV_VEC, but the current real
 *      komet-node only accepts SCALAR call arguments (its scval_to_json raises
 *      NotImplementedError for vec/map), so the run is REJECTED. This pins that
 *      node limitation until komet-node gains vec/map call-arg support.
 *   3. a sequence whose TRACED last step deliberately traps does NOT throw, and
 *      its trace is still fetched non-empty (blocker #1: a reverting tx stays
 *      debuggable).
 *   4. two byte-identical invokes both EXECUTE on the real node (distinct
 *      hashes, not deduped).
 *
 * The port is 8056 so a full `npm test` run does not collide with
 * integration.node.test.ts (port 8000).
 */

import * as assert from 'assert';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { Keypair } from '@stellar/stellar-sdk';
import { LiveBackend } from '../src/debugAdapter/backends/LiveBackend';
import { SorobanLaunchArgs } from '../src/debugAdapter/types';
import { TraceEvent } from '../src/komet/trace';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const CTOR_WASM = path.join(FIXTURES, 'ctor_probe.wasm');
const COMPOSITE_WASM = path.join(FIXTURES, 'composite.wasm');

const KOMET_NODE_COMMAND = process.env.KOMET_NODE_COMMAND ?? 'komet-node';
const optedOut = process.env.KOMET_NODE_E2E === '0';
// Port 8056 keeps this suite off integration.node.test.ts's port 8000.
const PORT = Number(process.env.KOMET_NODE_E2E_PORT ?? 8056);
// How long the presence probe waits for `<command> --help` to return. The kup
// binary answers instantly, but a locally-built dev node (run from source) can
// take ~15s to import its K/pyk machinery on a cold start, so the default is
// generous and overridable for slower environments.
const PROBE_TIMEOUT_MS = Number(process.env.KOMET_NODE_PROBE_TIMEOUT_MS ?? 30_000);

// A deterministic source account, so `${sourceAddress}` (and the whole run) is
// reproducible — never `Keypair.random()`.
const SOURCE_SECRET = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 42)).secret();

// --- The `transactions` config shape, typed locally so these tests state it
// independently of the pipeline's own types (cast at the call site). ----------
interface DeployTx {
  kind: 'deploy';
  id: string;
  wasm: string;
}
interface InvokeTx {
  kind: 'invoke';
  contract: string;
  function: string;
  args?: unknown;
  id?: string;
}
interface TxConfig {
  type: 'stellar';
  request: 'launch';
  sourceSecret?: string;
  node: { attach: false; command: string; port: number };
  transactions: (DeployTx | InvokeTx)[];
  trace?: 'last' | number | string;
}

function nodeSettings() {
  return { attach: false as const, command: KOMET_NODE_COMMAND, port: PORT };
}

/** Bridge to the not-yet-generalized `run` signature (expected red). */
function asRunArgs(config: TxConfig): SorobanLaunchArgs {
  return config as unknown as SorobanLaunchArgs;
}

/**
 * The boolean an invoked function returned, read off the replay model: the
 * value pushed immediately before the terminal `endWasm` record. `admin_set`
 * returns `has(ADMIN)`, so this is `true` exactly when the constructor's
 * storage write is visible to this transaction. komet spells the bool as an
 * i32 on the stack (1 = true, 0 = false).
 */
function invocationReturnedTrue(model: { records: { instr: [string, ...unknown[]]; stack: [string, unknown][] }[] }): boolean {
  const recs = model.records;
  let endIdx = -1;
  for (let i = recs.length - 1; i >= 0; i--) {
    if (recs[i].instr[0] === 'endWasm') {
      endIdx = i;
      break;
    }
  }
  assert.ok(endIdx > 0, 'expected an endWasm record preceded by the return-value computation');
  const pre = recs[endIdx - 1];
  assert.ok(pre.stack.length > 0, 'expected the boolean result on the stack before endWasm');
  const top = pre.stack[pre.stack.length - 1];
  return top[1] === 1 || top[1] === true;
}

describe('SequenceRunner e2e', function () {
  this.timeout(300_000);

  // Every spawned pipeline is tracked so `after` can guarantee the node is
  // killed even if an assertion (or the missing wiring) aborts a test midway.
  const active: LiveBackend[] = [];

  async function runSequence(config: TxConfig) {
    const pipeline = new LiveBackend();
    active.push(pipeline);
    try {
      return await pipeline.resolve(asRunArgs(config), (msg) => console.log(msg));
    } finally {
      await pipeline.dispose();
      const i = active.indexOf(pipeline);
      if (i >= 0) {
        active.splice(i, 1);
      }
    }
  }

  before(function () {
    if (optedOut) {
      this.skip();
      return;
    }
    // Fail loudly when the node is missing — a silent skip is exactly how a
    // breaking change slips through unnoticed.
    const probe = spawnSync(KOMET_NODE_COMMAND, ['--help'], { stdio: 'ignore', timeout: PROBE_TIMEOUT_MS });
    if (probe.error) {
      throw new Error(
        `komet-node not found on PATH (command: '${KOMET_NODE_COMMAND}'). The real-node ` +
          "end-to-end tests are mandatory — install it with 'kup install komet-node', or set " +
          'KOMET_NODE_E2E=0 to opt out only where the node genuinely cannot be installed.',
      );
    }
  });

  after(async () => {
    // Safety net: dispose anything a failed test left running.
    for (const pipeline of active.splice(0)) {
      await pipeline.dispose();
    }
  });

  // ------------------------------------------------------------------------
  // Scenario 1: constructor-as-invoke + cross-transaction state persistence.
  // ------------------------------------------------------------------------
  it('deploys ctor_probe, runs __constructor then admin_set, and the constructor state persists into the traced tx', async () => {
    const resolved = await runSequence({
      type: 'stellar',
      request: 'launch',
      sourceSecret: SOURCE_SECRET,
      node: nodeSettings(),
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
      trace: 'last',
    });

    const records = resolved.model.records;

    // A real, non-empty, replayable trace of the LAST tx (admin_set): it is
    // bracketed by the Soroban VM events, carries at least one byte-positioned
    // instruction, and its per-record positions line up with the model.
    assert.ok(records.length > 0, 'expected a non-empty trace for the traced admin_set tx');
    assert.strictEqual(resolved.positions.length, records.length, 'positions must be parallel to records');
    assert.ok(
      records.some((r) => r.instr[0] === 'callContract'),
      'expected a callContract VM event at the invocation boundary',
    );
    assert.ok(
      records.some((_, i) => resolved.positions[i] !== null),
      'expected at least one real (byte-positioned) instruction — a replayable trace',
    );
    assert.strictEqual(
      records[records.length - 1].instr[0],
      'endWasm',
      'expected the traced tx to end with an endWasm event',
    );

    // Persistence proof: admin_set returns has(ADMIN). Because __constructor ran
    // in an EARLIER tx against the same accumulating ledger, this later tx sees
    // ADMIN set — so the returned boolean is true.
    assert.strictEqual(
      invocationReturnedTrue(resolved.model),
      true,
      'expected admin_set to observe the ADMIN written by the earlier __constructor tx (state persisted)',
    );
  });

  // ------------------------------------------------------------------------
  // Scenario 2: a spec-encoded Vec call argument EXECUTES on the real node.
  //
  // The composite fixture's only entry point is supply(Vec<(AssetKey,i128)>), so
  // this is the end-to-end proof that a composite call argument survives the
  // whole path: the txBuilder spec-encodes it as an SCV_VEC, komet-node decodes
  // it (scval_to_json recurses over vec/map, and #decodeArg has matching rules),
  // and the invocation runs. It used to reject — vec/map raised
  // NotImplementedError server-side before komet-node gained composite argument
  // support — so this scenario also pins that the capability has not regressed.
  // ------------------------------------------------------------------------
  it('traces a supply invocation whose argument is a Vec<(AssetKey,i128)>', async () => {
    const resolved = await runSequence({
      type: 'stellar',
      request: 'launch',
      sourceSecret: SOURCE_SECRET,
      node: nodeSettings(),
      transactions: [
        { kind: 'deploy', id: 'pool', wasm: COMPOSITE_WASM },
        {
          kind: 'invoke',
          contract: 'pool',
          function: 'supply',
          // Vec<(AssetKey, i128)>: a unit variant and an integer-carrying
          // variant, i128 values as strings — encoded via the contract spec.
          args: {
            requests: [
              [{ tag: 'Native' }, '1000'],
              [{ tag: 'Other', values: [7] }, '-5'],
            ],
          },
        },
      ],
      trace: 'last',
    });

    const records = resolved.model.records;
    assert.ok(records.length > 0, 'expected a non-empty trace');

    // The call frame echoes the decoded arguments, so a composite that were
    // silently dropped or flattened would show up here.
    const call = records.find((rec) => rec.event?.kind === 'callContract');
    assert.ok(call, 'expected a callContract VM event at the invocation boundary');
    const event = call.event as Extract<TraceEvent, { kind: 'callContract' }>;
    assert.strictEqual(event.function, 'supply');
    assert.strictEqual(event.args.length, 1, 'supply takes one argument');
    assert.strictEqual(event.args[0].type, 'vec');
    assert.strictEqual(
      (event.args[0].value as unknown[]).length,
      2,
      'the vec carries both (AssetKey, i128) entries',
    );

    // And it is a replayable trace, not just an accepted transaction.
    assert.ok(
      records.some((_, i) => resolved.positions[i] !== null),
      'expected at least one real (byte-positioned) instruction',
    );
  });

  // ------------------------------------------------------------------------
  // Scenario 3: no-throw on a FAILED traced step (blocker #1). The last step
  // deliberately traps — the fixture's `boom` panics unconditionally — so komet
  // returns status FAILED; the pipeline must NOT throw, and the trap's trace
  // must still come back.
  // ------------------------------------------------------------------------
  it('does not throw when the traced last step traps, and still returns its non-empty trace', async () => {
    const resolved = await runSequence({
      type: 'stellar',
      request: 'launch',
      sourceSecret: SOURCE_SECRET,
      node: nodeSettings(),
      transactions: [
        { kind: 'deploy', id: 'probe', wasm: CTOR_WASM },
        {
          kind: 'invoke',
          contract: 'probe',
          function: '__constructor',
          args: { admin: '${sourceAddress}' },
        },
        // Deliberate trap: `boom` panics unconditionally -> tx FAILED on the node.
        { kind: 'invoke', contract: 'probe', function: 'boom', args: { _nonce: 1 } },
      ],
      trace: 'last',
    });

    // The mere fact that `run` resolved (did not reject) IS the no-throw
    // guarantee — the old pipeline threw on FAILED before fetching the trace.
    assert.ok(
      resolved.model.records.length > 0,
      'expected the FAILED (trapping) tx to still yield a non-empty, debuggable trace',
    );
  });

  // ------------------------------------------------------------------------
  // Scenario 4: anti-dedup on the REAL node. Two byte-identical admin_set(1)
  // requests straddle the constructor. Their envelopes differ ONLY by the
  // runner's incrementing sequence number, so komet-node cannot fold them into
  // one cached receipt. Proof through the traced result: the LAST admin_set
  // (identical to the FIRST) observes ADMIN as SET — which is only possible if
  // it genuinely re-executed AFTER the constructor. Had it been deduped into
  // the first (pre-constructor) call, komet would have served that cached
  // receipt and the boolean would be false.
  // ------------------------------------------------------------------------
  it('executes two byte-identical invokes independently (distinct hashes, not deduped)', async () => {
    const resolved = await runSequence({
      type: 'stellar',
      request: 'launch',
      sourceSecret: SOURCE_SECRET,
      node: nodeSettings(),
      transactions: [
        { kind: 'deploy', id: 'probe', wasm: CTOR_WASM },
        // First identical admin_set(1): runs BEFORE the constructor -> false.
        { kind: 'invoke', contract: 'probe', function: 'admin_set', args: { _nonce: 1 } },
        {
          kind: 'invoke',
          contract: 'probe',
          function: '__constructor',
          args: { admin: '${sourceAddress}' },
        },
        // Second, byte-identical admin_set(1): must re-execute AFTER the
        // constructor -> true. A deduped call would return the cached false.
        { kind: 'invoke', contract: 'probe', function: 'admin_set', args: { _nonce: 1 } },
      ],
      trace: 'last',
    });

    assert.strictEqual(
      invocationReturnedTrue(resolved.model),
      true,
      'the second byte-identical admin_set must re-execute (post-constructor state) — proving it was not deduped into the first',
    );
  });
});
