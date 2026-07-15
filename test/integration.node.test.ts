/**
 * End-to-end integration against a REAL komet-node.
 *
 * Auto-skips unless KOMET_NODE_E2E=1 is set (and `komet-node` is on PATH, as
 * installed by `kup install komet-node`). In the devcontainer:
 *
 *   KOMET_NODE_E2E=1 npm test
 *
 * Drives the full TurnkeyPipeline (spawn node -> seed -> deploy -> invoke with
 * trace) for `add(5, 6)` and asserts a real trace comes back and replays.
 */

import * as assert from 'assert';
import * as path from 'path';
import { TurnkeyPipeline } from '../src/pipeline/TurnkeyPipeline';
import { MemoryImage } from '../src/debugAdapter/MemoryImage';
import { makeRuntimeState } from '../src/debugAdapter/runtimeState';
import { evalLocation } from '../src/dwarf/locexpr';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const WASM = path.join(FIXTURES, 'sample_contract.wasm');
const INCREMENT_WASM = path.join(FIXTURES, 'increment-debug.wasm');
const enabled = process.env.KOMET_NODE_E2E === '1';

function nodeConfig() {
  return {
    attach: false as const,
    command: process.env.KOMET_NODE_COMMAND ?? 'komet-node',
    port: Number(process.env.KOMET_NODE_PORT ?? 8000),
  };
}

(enabled ? describe : describe.skip)('TurnkeyPipeline (real komet-node)', function () {
  this.timeout(180_000);

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
          node: {
            attach: false,
            command: process.env.KOMET_NODE_COMMAND ?? 'komet-node',
            port: Number(process.env.KOMET_NODE_PORT ?? 8000),
          },
        },
        (msg) => console.log(msg),
      );

      assert.ok(resolved.model.length > 0, 'expected a non-empty trace');

      // The final record's value stack should contain the result, 11.
      resolved.model.seek(resolved.model.length - 1);
      const flat = JSON.stringify(resolved.model.current.stack);
      assert.ok(flat.includes('11'), `expected 11 on the final stack, got ${flat}`);
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
