/**
 * The record contract of a komet trace (komet/trace.ts, "Record kinds").
 *
 * Every record names itself with a top-level `kind`: `"instr"` for an executed
 * wasm instruction, or the operation name for a Soroban VM record. Only
 * instruction records carry `pos`/`instr`; a VM record's operands are named
 * fields of the record itself.
 *
 * The parser fails loudly on a record that does not state a `kind`, which is
 * what makes a backend format change show up as a clear error rather than as a
 * silently empty view.
 */

import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import { toTraceRecord, parseTraceJsonl, TraceParseError, TraceEvent } from '../src/komet/trace';
import { executingContracts } from '../src/komet/executingContract';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
/**
 * A REAL trace, not a hand-written one: komet-node v0.1.88 tracing the `foo()`
 * invocation from its own README quickstart. Fixtures built by hand can only
 * pin what someone thought to write down — this one is whatever the backend
 * actually emits.
 */
const REAL = path.join(FIXTURES, 'foo-real-v0.1.88.trace.jsonl');

/** Narrow an event to a kind, failing the test when it is not that kind. */
function expectKind<K extends TraceEvent['kind']>(
  event: TraceEvent | undefined,
  kind: K,
): Extract<TraceEvent, { kind: K }> {
  assert.ok(event, 'expected an event payload');
  assert.strictEqual(event.kind, kind);
  return event as Extract<TraceEvent, { kind: K }>;
}

const CONTRACT = { type: 'address', addrType: 'contract', value: '63' };

describe('trace parsing — the record contract', () => {
  it('reads a real komet-node v0.1.88 trace end to end', async () => {
    const records = parseTraceJsonl(await fs.readFile(REAL, 'utf8'));

    // The shape of the foo() invocation: a ledger baseline, the call frame, the
    // module's three global initializers plus the two-instruction body, the exit.
    assert.deepStrictEqual(
      records.map((rec) => rec.event?.kind ?? rec.instr[0]),
      ['ledger', 'callContract', 'const', 'const', 'const', 'block', 'const', 'endWasm'],
    );

    // Instruction records keep their position and carry the globals allocated so
    // far — one more per initializer that has run.
    const instructions = records.filter((rec) => rec.event === undefined);
    assert.deepStrictEqual(
      instructions.map((rec) => Object.keys(rec.globals ?? {}).length),
      [0, 1, 2, 3, 3],
    );
    assert.deepStrictEqual(
      instructions.map((rec) => rec.pos),
      [3, 11, 19, null, 3],
    );

    // A single contract runs the whole trace, so the callee tags every record
    // from its own call frame onward; the ledger baseline precedes any call.
    const callee = expectKind(records[1].event, 'callContract').to.value;
    assert.deepStrictEqual(executingContracts(records), [null, ...Array(7).fill(callee)]);
  });

  it('parses an instruction record, which keeps pos/instr alongside its kind', () => {
    const rec = toTraceRecord(
      { kind: 'instr', pos: 3, instr: ['const', 'i32', 7], stack: [], locals: {}, globals: {} },
      1,
    );
    assert.strictEqual(rec.pos, 3);
    assert.deepStrictEqual(rec.instr, ['const', 'i32', 7]);
    assert.strictEqual(rec.event, undefined);
  });

  it('accepts a VM record that carries no pos and no instr', () => {
    const rec = toTraceRecord({ kind: 'endWasm', success: true, depth: 1, result: null }, 1);
    assert.strictEqual(rec.pos, null);
    // A VM record has no instruction, so `instr` names the record instead.
    assert.deepStrictEqual(rec.instr, ['endWasm']);
    assert.strictEqual(expectKind(rec.event, 'endWasm').success, true);
  });

  it('reads a storage write\'s operands from its named fields', () => {
    const rec = toTraceRecord(
      {
        kind: 'contractData',
        operation: 'put',
        durability: 'temporary',
        contract: CONTRACT,
        args: [{ type: 'symbol', value: 'k' }, { type: 'u32', value: 1 }],
      },
      1,
    );
    const event = expectKind(rec.event, 'contractData');
    assert.strictEqual(event.op, 'put');
    assert.strictEqual(event.durability, 'temporary');
  });

  it('reads a host call\'s module and function from its named fields', () => {
    const rec = toTraceRecord({ kind: 'hostCall', module: 'l', function: '_', locals: {} }, 1);
    const event = expectKind(rec.event, 'hostCall');
    assert.strictEqual(event.module, 'l');
    assert.strictEqual(event.function, '_');
  });

  it('carries a kind it does not model through as a plain record', () => {
    // A komet release may add a record kind; it must not fail the session.
    const rec = toTraceRecord({ kind: 'somethingNew', whatever: 1 }, 1);
    assert.deepStrictEqual(rec.instr, ['somethingNew']);
    assert.strictEqual(rec.event, undefined);
  });

  it('rejects a record that states no kind', () => {
    // The pre-v0.1.87 shape, and any producer that forgets the field: a trace
    // this parser cannot classify must fail loudly, not parse as something else.
    assert.throws(() => toTraceRecord({ pos: 3, instr: ['nop'], stack: [], locals: {} }, 1), TraceParseError);
    assert.throws(() => toTraceRecord({ kind: 7, pos: null, instr: ['nop'] }, 1), TraceParseError);
    assert.throws(() => toTraceRecord({ kind: '', pos: null, instr: ['nop'] }, 1), TraceParseError);
  });

  it('still requires pos and instr on an instruction record', () => {
    assert.throws(() => toTraceRecord({ kind: 'instr', pos: 3, stack: [], locals: {} }, 1), TraceParseError);
    assert.throws(
      () => toTraceRecord({ kind: 'instr', instr: ['nop'], stack: [], locals: {} }, 1),
      TraceParseError,
    );
  });

  it('leaves a malformed VM payload to degrade, not to fail the record', () => {
    // Tolerance is the event parser's contract (traceEvents.ts header): the
    // record still parses, only its payload is dropped.
    const rec = toTraceRecord({ kind: 'callContract', from: CONTRACT }, 1);
    assert.deepStrictEqual(rec.instr, ['callContract']);
    assert.strictEqual(rec.event, undefined);
  });
});
