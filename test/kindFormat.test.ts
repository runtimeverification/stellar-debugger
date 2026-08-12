/**
 * The two komet trace wire formats normalize onto one model (komet/trace.ts,
 * "Two wire formats").
 *
 * komet v0.1.87 gave every record a top-level `kind` and moved the operands that
 * used to ride inside `instr` into named fields. The parser reads both, because
 * a recorded trace on someone's disk does not get reformatted by a komet
 * upgrade, and because the `kind`-tagged VM records carry no `instr` at all — so
 * before this the first `callContract` in a v0.1.88 trace failed the whole
 * session with a TraceParseError.
 *
 * The strongest statement of "one model" is a fixture in each format that parses
 * to identical records, so the rest of the suite can keep asserting against
 * either without caring which komet produced it.
 */

import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import { toTraceRecord, parseTraceJsonl, TraceParseError, TraceEvent } from '../src/komet/trace';
import { executingContracts } from '../src/komet/executingContract';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const LEGACY = path.join(FIXTURES, 'ledger-globals.trace.jsonl');
const KIND = path.join(FIXTURES, 'ledger-globals.kind.trace.jsonl');
/**
 * A REAL trace, not a hand-written one: komet-node v0.1.88 tracing the `foo()`
 * invocation from its own README quickstart. The fixtures above are equivalent
 * by construction, which cannot catch a format detail nobody thought to write
 * down — this one is whatever the backend actually emits.
 */
const REAL = path.join(FIXTURES, 'foo-kind-v0.1.88.trace.jsonl');

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

describe('trace parsing — the kind-tagged format (komet >= v0.1.87)', () => {
  it('parses the same trace identically in both formats', async () => {
    const [legacy, kind] = await Promise.all([
      fs.readFile(LEGACY, 'utf8').then(parseTraceJsonl),
      fs.readFile(KIND, 'utf8').then(parseTraceJsonl),
    ]);
    assert.strictEqual(kind.length, legacy.length);
    assert.deepStrictEqual(kind, legacy);
  });

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
    // The shape that used to throw: kind-tagged records dropped both fields.
    const rec = toTraceRecord({ kind: 'endWasm', success: true, depth: 1, result: null }, 1);
    assert.strictEqual(rec.pos, null);
    assert.deepStrictEqual(rec.instr, ['endWasm']);
    assert.strictEqual(expectKind(rec.event, 'endWasm').success, true);
  });

  it('rebuilds contractData operands from their named fields', () => {
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
    assert.deepStrictEqual(rec.instr, ['contractData', 'put', 'temporary']);
    const event = expectKind(rec.event, 'contractData');
    assert.strictEqual(event.op, 'put');
    assert.strictEqual(event.durability, 'temporary');
  });

  it('rebuilds hostCall operands from their named fields', () => {
    const rec = toTraceRecord({ kind: 'hostCall', module: 'l', function: '_', locals: {} }, 1);
    assert.deepStrictEqual(rec.instr, ['hostCall', 'l', '_']);
    const event = expectKind(rec.event, 'hostCall');
    assert.strictEqual(event.module, 'l');
    assert.strictEqual(event.function, '_');
  });

  it('carries a tag it does not model through as a plain record', () => {
    // A komet release may add a record kind; it must not fail the session.
    const rec = toTraceRecord({ kind: 'somethingNew', whatever: 1 }, 1);
    assert.deepStrictEqual(rec.instr, ['somethingNew']);
    assert.strictEqual(rec.event, undefined);
  });

  it('still requires pos and instr on an instruction record', () => {
    assert.throws(() => toTraceRecord({ kind: 'instr', pos: 3, stack: [], locals: {} }, 1), TraceParseError);
    assert.throws(
      () => toTraceRecord({ kind: 'instr', instr: ['nop'], stack: [], locals: {} }, 1),
      TraceParseError,
    );
    // ... and on an older, untagged record, where instr is the only discriminator.
    assert.throws(() => toTraceRecord({ pos: 3, stack: [], locals: {} }, 1), TraceParseError);
  });

  it('rejects a non-string kind rather than guessing the format', () => {
    assert.throws(() => toTraceRecord({ kind: 7, pos: null, instr: ['nop'] }, 1), TraceParseError);
  });

  it('leaves a malformed VM payload to degrade, not to fail the record', () => {
    // Tolerance is the event parser's contract (traceEvents.ts header): the
    // record still parses, only its payload is dropped.
    const rec = toTraceRecord({ kind: 'callContract', from: CONTRACT }, 1);
    assert.deepStrictEqual(rec.instr, ['callContract']);
    assert.strictEqual(rec.event, undefined);
  });
});
