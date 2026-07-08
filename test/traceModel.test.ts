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
  it('exposes the trace length and record access via the cursor', async () => {
    const model = await loadModel();
    assert.strictEqual(model.isEmpty, false);
    assert.strictEqual(model.length, 8);
    assert.strictEqual(model.cursor, 0);
    assert.deepStrictEqual(model.current.instr, ['local.get', 0]);
  });

  it('reports an empty trace as empty', () => {
    const model = new TraceModel([]);
    assert.strictEqual(model.isEmpty, true);
    assert.strictEqual(model.length, 0);
  });

  it('seek moves the cursor and clamps to the trace range', async () => {
    const model = await loadModel();
    assert.strictEqual(model.seek(4), 4);
    assert.strictEqual(model.cursor, 4);
    assert.deepStrictEqual(model.current.instr, ['local.get', 0]);
    assert.strictEqual(model.current.pos, 200);

    assert.strictEqual(model.seek(-3), 0);
    assert.strictEqual(model.cursor, 0);
    assert.strictEqual(model.seek(999), model.length - 1);
    assert.strictEqual(model.cursor, 7);
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
