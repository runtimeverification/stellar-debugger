import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Keypair } from '@stellar/stellar-sdk';
import { LiveBackend } from '../src/debugAdapter/backends/LiveBackend';
import { MockKometNode } from './support/mockKometNode';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const WASM = path.join(FIXTURES, 'sample_contract.wasm');
const TRACE = path.join(FIXTURES, 'add.trace.jsonl');

// A deterministic source secret so the `sourceSecret` branch of the pipeline
// (Keypair.fromSecret vs Keypair.random) is exercised without randomness.
const FIXED_SECRET = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).secret();

describe('LiveBackend (against mock komet-node)', () => {
  let mock: MockKometNode;
  let port: number;
  let trace: string;

  before(async () => {
    trace = await fs.readFile(TRACE, 'utf8');
  });

  beforeEach(async () => {
    mock = new MockKometNode({ trace });
    port = await mock.start();
  });

  afterEach(async () => {
    await mock.stop();
  });

  it('resolves a replayable trace via the turnkey pipeline (attach mode)', async () => {
    const backend = new LiveBackend();
    const resolved = await backend.resolve(
      {
        wasmPath: WASM,
        function: 'add',
        args: [
          { value: 5, type: 'u32' },
          { value: 6, type: 'u32' },
        ],
        sourceSecret: FIXED_SECRET,
        node: { attach: true, host: '127.0.0.1', port },
      },
      () => undefined,
    );

    assert.ok(resolved.model.length > 0);
    // The fixed secret was used to seed + sign every submission.
    assert.strictEqual(mock.calls('traceTransaction'), 1);

    // dispose() is a no-op in attach mode (no spawned process) and must not throw.
    await backend.dispose();
  });
});
