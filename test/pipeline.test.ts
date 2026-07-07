import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import {
  Networks,
  TransactionBuilder,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { TurnkeyPipeline } from '../src/pipeline/TurnkeyPipeline';
import { MockKometNode } from './support/mockKometNode';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const WASM = path.join(FIXTURES, 'sample_contract.wasm');
const TRACE = path.join(FIXTURES, 'add.trace.jsonl');

describe('TurnkeyPipeline (against mock komet-node)', () => {
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

  function run() {
    const pipeline = new TurnkeyPipeline();
    return pipeline.run(
      {
        wasmPath: WASM,
        function: 'add',
        args: [
          { value: 5, type: 'u32' },
          { value: 6, type: 'u32' },
        ],
        node: { attach: true, host: '127.0.0.1', port },
      },
      () => undefined,
    );
  }

  it('drives the full deploy+invoke sequence and returns a replayable trace', async () => {
    const resolved = await run();

    // The trace was parsed into a replayable model.
    assert.ok(resolved.model.length > 0);
    assert.strictEqual(resolved.model.length, trace.trim().split('\n').length);

    // Four submissions (seed account, upload wasm, create contract, invoke),
    // then one trace fetched by hash.
    assert.strictEqual(mock.envelopes('sendTransaction').length, 4);
    assert.strictEqual(mock.calls('traceTransaction'), 1);
  });

  it('uploads the actual wasm bytes', async () => {
    await run();
    const uploadEnv = mock.envelopes('sendTransaction')[1];
    const tx = TransactionBuilder.fromXDR(uploadEnv, Networks.TESTNET);
    const op = (tx as any).operations[0];
    assert.strictEqual(op.func.switch().name, 'hostFunctionTypeUploadContractWasm');
    const uploaded: Buffer = op.func.wasm();
    const expected = await fs.readFile(WASM);
    assert.deepStrictEqual(Buffer.from(uploaded), expected);
  });

  it('invokes the named function with the given args', async () => {
    await run();
    const invokeEnv = mock.envelopes('sendTransaction')[3];
    const tx = TransactionBuilder.fromXDR(invokeEnv, Networks.TESTNET);
    const op = (tx as any).operations[0];
    const invoke = op.func.invokeContract();
    assert.strictEqual(invoke.functionName().toString(), 'add');
    const args = invoke.args().map((a: xdr.ScVal) => Number(scValToNative(a)));
    assert.deepStrictEqual(args, [5, 6]);
  });

  it('surfaces a FAILED invocation as an error', async () => {
    await mock.stop();
    mock = new MockKometNode({ trace, traceStatus: 'FAILED' });
    port = await mock.start();
    await assert.rejects(() => run(), /FAILED/);
  });
});
