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
import { parseWasmSections } from '../src/wasm/sections';
import { MemoryImage } from '../src/debugAdapter/MemoryImage';
import { makeRuntimeState } from '../src/debugAdapter/runtimeState';
import { evalLocation } from '../src/dwarf/locexpr';

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
    await assert.rejects(
      () => run(),
      (err: Error) => {
        // Still flags the FAILED status and identifies the invocation...
        assert.match(err.message, /FAILED/);
        assert.match(err.message, /add/);
        // ...and pins the invocation to its transaction hash (mock's hashFor
        // yields a 64-char hex hash, so this stays non-brittle).
        assert.match(err.message, /tx [0-9a-f]{64}/);
        // ...but no longer parrots the (now-fixed) value-return limitation.
        assert.doesNotMatch(err.message, /no value|Void|update komet-node|stuck/i);
        return true;
      },
    );
  });
});

// End-to-end through the LIVE backend (TurnkeyPipeline) against a mock node, on the
// DWARF-bearing `increment` contract and a real komet trace with per-step memory:
//   - the wasm uploaded to the node is DEBUG-STRIPPED (the perf fix — komet-node does
//     not need DWARF; carrying it bloated the KORE config ~3x and timed out the RPC
//     path), while the FULL DWARF wasm still drives source + variable resolution;
//   - a shadow-stack (memory-backed) Rust variable is inspected and reads its value.
// This runs with no real node, so it is deterministic and always-on.
describe('TurnkeyPipeline debug-strip + memory-backed variable inspection', () => {
  const INCR_WASM = path.join(FIXTURES, 'increment-debug.wasm');
  const INCR_TRACE = path.join(FIXTURES, 'increment-debug.trace.jsonl');
  let mock: MockKometNode;
  let port: number;

  beforeEach(async () => {
    mock = new MockKometNode({ trace: await fs.readFile(INCR_TRACE, 'utf8') });
    port = await mock.start();
  });
  afterEach(async () => {
    await mock.stop();
  });

  async function runIncrement() {
    const pipeline = new TurnkeyPipeline();
    return pipeline.run(
      {
        wasmPath: INCR_WASM,
        function: 'increment',
        args: [{ value: 5, type: 'u32' }],
        node: { attach: true, host: '127.0.0.1', port },
      },
      () => undefined,
    );
  }

  it('uploads a debug-stripped wasm (no .debug*, smaller) while keeping full DWARF for resolution', async () => {
    const resolved = await runIncrement();

    const uploadEnv = mock.envelopes('sendTransaction')[1];
    const op = (TransactionBuilder.fromXDR(uploadEnv, Networks.TESTNET) as any).operations[0];
    const uploaded = Buffer.from(op.func.wasm() as Buffer);
    const full = await fs.readFile(INCR_WASM);

    // The uploaded module is strictly smaller and carries no DWARF sections...
    assert.ok(uploaded.length < full.length, `uploaded ${uploaded.length} not < full ${full.length}`);
    const names = parseWasmSections(uploaded).sections.filter((s) => s.id === 0).map((s) => s.name);
    assert.ok(!names.some((n) => n?.startsWith('.debug')), `uploaded wasm still has debug sections: ${names.join(', ')}`);
    // ...yet the code section is byte-identical, so trace `pos` still aligns.
    const up = parseWasmSections(uploaded).codeSection!;
    const fu = parseWasmSections(full).codeSection!;
    assert.deepStrictEqual(
      Buffer.from(uploaded.subarray(up.payloadStart, up.payloadEnd)),
      Buffer.from(full.subarray(fu.payloadStart, fu.payloadEnd)),
    );

    // The full DWARF wasm was still used for artifacts, so variables resolve.
    assert.ok(resolved.variables.hasVariables(), 'expected DWARF variable resolution from the full wasm');
  });

  it('resolves a shadow-stack Rust parameter (`by: u32 == 5`) from linear memory', async () => {
    const resolved = await runIncrement();
    const mem = new MemoryImage(resolved.model.records);

    let found: { display: string; typeName?: string } | undefined;
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
        // Only count it when the location actually resolves into linear memory.
        const loc = evalLocation(v.locationExpr, v.frameBaseExpr, state);
        if (!loc || loc.kind !== 'memory') {
          continue;
        }
        const decoded = resolved.variables.decodeVariable(v, state, pc);
        if (decoded.typeName === 'u32' && decoded.display === '5') {
          found = decoded;
          break;
        }
      }
    }
    assert.ok(found, 'expected the memory-backed `by: u32` to resolve to 5 somewhere in the trace');
  });
});
