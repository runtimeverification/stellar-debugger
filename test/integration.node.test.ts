/**
 * End-to-end integration against a REAL komet-node.
 *
 * These are the ONLY tests that can catch a breaking change in komet-node's
 * JSON-RPC surface or trace format — a mock, stub, or pre-recorded fixture, by
 * construction, keeps testing yesterday's format. So they are MANDATORY and run
 * by default as part of `npm test` (the devcontainer and CI both install the
 * node via `kup install komet-node`). If `komet-node` is not on PATH the suite
 * FAILS LOUDLY rather than skipping silently — set KOMET_NODE_E2E=0 to opt out
 * only where the node genuinely cannot be installed.
 *
 * Drives the full TurnkeyPipeline (spawn node -> seed -> deploy -> invoke with
 * trace) for `add(5, 6)` and `increment(5)`, asserting a real trace comes back,
 * carries the current record shape, and replays.
 */

import * as assert from 'assert';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { TurnkeyPipeline } from '../src/pipeline/TurnkeyPipeline';
import { MemoryImage } from '../src/debugAdapter/MemoryImage';
import { makeRuntimeState } from '../src/debugAdapter/runtimeState';
import { evalLocation } from '../src/dwarf/locexpr';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const WASM = path.join(FIXTURES, 'sample_contract.wasm');
const INCREMENT_WASM = path.join(FIXTURES, 'increment-debug.wasm');
const KOMET_NODE_COMMAND = process.env.KOMET_NODE_COMMAND ?? 'komet-node';
const optedOut = process.env.KOMET_NODE_E2E === '0';

function nodeConfig() {
  return {
    attach: false as const,
    command: KOMET_NODE_COMMAND,
    port: Number(process.env.KOMET_NODE_PORT ?? 8000),
  };
}

describe('TurnkeyPipeline (real komet-node)', function () {
  this.timeout(180_000);

  before(function () {
    if (optedOut) {
      this.skip();
      return;
    }
    // Fail loudly when the node is missing — a silent skip is exactly how a
    // breaking format change slips through unnoticed.
    const probe = spawnSync(KOMET_NODE_COMMAND, ['--help'], { stdio: 'ignore', timeout: 10_000 });
    if (probe.error) {
      throw new Error(
        `komet-node not found on PATH (command: '${KOMET_NODE_COMMAND}'). The real-node ` +
          "end-to-end tests are mandatory — install it with 'kup install komet-node', or set " +
          'KOMET_NODE_E2E=0 to opt out only where the node genuinely cannot be installed.',
      );
    }
  });

  it('spawns the node, deploys, and traces add(5, 6)', async () => {
    const pipeline = new TurnkeyPipeline();
    try {
      const resolved = await pipeline.run(
        {
          wasmPath: WASM,
          function: 'add',
          args: [
            { value: 5, type: 'u32' },
            { value: 6, type: 'u32' },
          ],
          // attach:false -> the pipeline spawns komet-node itself.
          node: nodeConfig(),
        },
        (msg) => console.log(msg),
      );

      const records = resolved.model.records;
      assert.ok(records.length > 0, 'expected a non-empty trace');

      // Assert the CURRENT trace shape end-to-end: the node returns an array of
      // records, real wasm instructions carry a byte position, and a contract
      // invocation is bracketed by Soroban VM events (`callContract` on entry,
      // `endWasm` on exit). This pins the exact format whose silent change broke
      // the live pipeline — a mock/fixture could never have caught it.
      assert.ok(
        records.some((r) => r.pos !== null),
        'expected at least one real (byte-positioned) instruction record',
      );
      assert.ok(
        records.some((r) => r.instr[0] === 'callContract'),
        'expected a callContract VM event at the invocation boundary',
      );
      assert.strictEqual(
        records[records.length - 1].instr[0],
        'endWasm',
        `expected the trace to end with an endWasm event, got ${JSON.stringify(records[records.length - 1].instr)}`,
      );
    } finally {
      await pipeline.dispose();
    }
  });

  // Full-stack variable inspection: a real komet-node traces increment(5) (its per-step
  // memory now rides in the trace), and a shadow-stack Rust parameter is resolved from
  // that memory. The DWARF wasm is uploaded debug-STRIPPED (perf fix), so this completes
  // in well under the timeout despite the contract's size.
  it('traces increment(5) live and inspects the memory-backed `by: u32 == 5`', async () => {
    const pipeline = new TurnkeyPipeline();
    try {
      const resolved = await pipeline.run(
        { wasmPath: INCREMENT_WASM, function: 'increment', args: [{ value: 5, type: 'u32' }], node: nodeConfig() },
        (msg) => console.log(msg),
      );
      assert.ok(resolved.model.length > 0, 'expected a non-empty trace');
      assert.ok(
        resolved.model.records.some((r) => r.mem !== undefined),
        'expected the live trace to carry per-step memory snapshots',
      );
      assert.ok(resolved.variables.hasVariables(), 'expected DWARF variable resolution');

      const mem = new MemoryImage(resolved.model.records);
      let found = false;
      for (let c = 0; c < resolved.model.records.length && !found; c++) {
        const pc = resolved.positions[c];
        if (pc == null) {
          continue;
        }
        const state = makeRuntimeState(resolved.model.records[c], mem, c);
        let vars;
        try {
          vars = resolved.variables.variablesInScope(pc);
        } catch {
          continue;
        }
        for (const v of vars) {
          if (v.name !== 'by' || !v.locationExpr) {
            continue;
          }
          const loc = evalLocation(v.locationExpr, v.frameBaseExpr, state);
          if (!loc || loc.kind !== 'memory') {
            continue;
          }
          const decoded = resolved.variables.decodeVariable(v, state, pc);
          if (decoded.typeName === 'u32' && decoded.display === '5') {
            found = true;
            break;
          }
        }
      }
      assert.ok(found, 'expected the memory-backed `by: u32` to resolve to 5 in the live trace');
    } finally {
      await pipeline.dispose();
    }
  });
});
