/**
 * End-to-end integration against a REAL komet-node.
 *
 * Auto-skips unless KOMET_NODE_E2E=1 is set (and the komet-node venv is on
 * PATH so `python -m komet_node` runs). In the devcontainer:
 *
 *   source $KOMET_NODE_VENV/bin/activate
 *   KOMET_NODE_E2E=1 npm test
 *
 * Drives the full TurnkeyPipeline (spawn node -> seed -> deploy -> invoke with
 * trace) for `add(5, 6)` and asserts a real trace comes back and replays.
 */

import * as assert from 'assert';
import * as path from 'path';
import { TurnkeyPipeline } from '../src/pipeline/TurnkeyPipeline';

const WASM = path.join(__dirname, '..', '..', 'test', 'fixtures', 'sample_contract.wasm');
const enabled = process.env.KOMET_NODE_E2E === '1';

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
            command: process.env.KOMET_NODE_COMMAND ?? 'python -m komet_node',
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
});
