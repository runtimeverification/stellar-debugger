import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import { parseTraceJsonl } from '../src/komet/trace';
import { TraceModel } from '../src/debugAdapter/TraceModel';

const FIXTURE = path.join(__dirname, '..', '..', 'test', 'fixtures', 'add.trace.jsonl');

async function loadModel(): Promise<TraceModel> {
  const jsonl = await fs.readFile(FIXTURE, 'utf8');
  return new TraceModel(parseTraceJsonl(jsonl));
}

describe('TraceModel', () => {
  it('builds posToIndices from the trace', async () => {
    const model = await loadModel();
    assert.deepStrictEqual(model.posToIndices.get(100), [0]);
    assert.deepStrictEqual(model.posToIndices.get(200), [4]);
    // synthetic (null pos) records are not indexed by position
    assert.ok(!model.posToIndices.has(NaN));
  });

  it('steps forward and back with clamping', async () => {
    const model = await loadModel();
    assert.strictEqual(model.cursor, 0);
    assert.strictEqual(model.atStart(), true);
    assert.strictEqual(model.stepBack(), false); // clamped at start
    assert.strictEqual(model.cursor, 0);

    while (!model.atEnd()) {
      model.stepForward();
    }
    assert.strictEqual(model.cursor, model.length - 1);
    assert.strictEqual(model.stepForward(), false); // clamped at end
  });

  it('stepBack is the inverse of stepForward', async () => {
    const model = await loadModel();
    model.seek(3);
    model.stepForward();
    assert.strictEqual(model.cursor, 4);
    model.stepBack();
    assert.strictEqual(model.cursor, 3);
  });

  it('reconstructs call depth from call/return', async () => {
    const model = await loadModel();
    // index 3 is `call` (depth 0 at entry), 4/5 are inside the callee (depth 1)
    assert.strictEqual(model.depthAt[3], 0);
    assert.strictEqual(model.depthAt[4], 1);
    assert.strictEqual(model.depthAt[5], 1);
    // index 6 is back in the caller after the callee returned
    assert.strictEqual(model.depthAt[6], 0);
  });

  it('step over skips the callee entered by a call', async () => {
    const model = await loadModel();
    model.seek(3); // the `call` instruction
    model.stepOverForward();
    // should land back at caller depth, past the callee (index 6)
    assert.strictEqual(model.depthAt[model.cursor], 0);
    assert.strictEqual(model.cursor, 6);
  });

  it('navigates to breakpoint indices forward and backward', async () => {
    const model = await loadModel();
    const bps = new Set([2, 5]);
    model.seek(0);
    assert.strictEqual(model.nextIndexInSet(bps), 2);
    model.seek(6);
    assert.strictEqual(model.prevIndexInSet(bps), 5);
    model.seek(5);
    assert.strictEqual(model.nextIndexInSet(bps), null); // none after 5
  });
});
