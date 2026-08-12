import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import { toTraceRecord, parseTraceJsonl, TraceParseError, TraceEvent } from '../src/komet/trace';
import { strictParseTraceEvent } from '../src/komet/traceEvents';

/**
 * Run the STRICT parser over a raw record object the way `toTraceRecord` would,
 * so a test can pin a validation rule. Production parsing is tolerant (see the
 * "tolerance" block at the bottom).
 */
function strict(obj: Record<string, unknown>, lineNo = 1): TraceEvent | undefined {
  return strictParseTraceEvent(obj, obj.instr as unknown[], lineNo);
}

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const INCREMENT_TRACE = path.join(FIXTURES, 'increment-debug.trace.jsonl');

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
const ACCOUNT = { type: 'address', addrType: 'account', value: '61' };

describe('trace parsing — Soroban VM event payloads (docs/state-inspection.md)', () => {
  // ---------------------------------------------------------------- instructions

  it('leaves a plain instruction record without an event payload', () => {
    const rec = toTraceRecord({ pos: 3, instr: ['const', 'i32', 1048576], stack: [], locals: {} }, 1);
    assert.strictEqual(rec.event, undefined);
  });

  // ---------------------------------------------------------------- callContract

  it('parses a callContract event with its callee storage baseline (L1, L6)', () => {
    const rec = toTraceRecord(
      {
        pos: null,
        instr: ['callContract'],
        from: ACCOUNT,
        to: CONTRACT,
        function: 'increment',
        args: [{ type: 'u32', value: 5 }],
        depth: 1,
        storage: [
          {
            durability: 'instance',
            key: { type: 'symbol', value: 'COUNTER' },
            value: { type: 'u32', value: 4 },
            liveUntil: 100,
          },
        ],
      },
      1,
    );
    const event = expectKind(rec.event, 'callContract');
    assert.deepStrictEqual(event.from, { addrType: 'account', value: '61' });
    assert.deepStrictEqual(event.to, { addrType: 'contract', value: '63' });
    assert.strictEqual(event.function, 'increment');
    assert.strictEqual(event.depth, 1);
    assert.strictEqual(event.args.length, 1);
    assert.strictEqual(event.storage.length, 1);
    assert.strictEqual(event.storage[0].durability, 'instance');
    assert.strictEqual(event.storage[0].liveUntil, 100);
    assert.deepStrictEqual(event.storage[0].key, { type: 'symbol', value: 'COUNTER' });
  });

  it('accepts an empty callContract storage baseline', () => {
    const rec = toTraceRecord(
      {
        pos: null,
        instr: ['callContract'],
        from: ACCOUNT,
        to: CONTRACT,
        function: 'increment',
        args: [],
        depth: 1,
        storage: [],
      },
      1,
    );
    assert.deepStrictEqual(expectKind(rec.event, 'callContract').storage, []);
  });

  it('rejects a callContract whose storage entry has no liveUntil', () => {
    assert.throws(
      () =>
        strict(
          {
            pos: null,
            instr: ['callContract'],
            from: ACCOUNT,
            to: CONTRACT,
            function: 'f',
            args: [],
            depth: 1,
            storage: [{ durability: 'instance', key: { type: 'void' }, value: { type: 'void' } }],
          },
          7,
        ),
      /trace line 7/,
    );
  });

  it('rejects a callContract with an unknown durability', () => {
    assert.throws(
      () =>
        strict({
          pos: null,
          instr: ['callContract'],
          from: ACCOUNT,
          to: CONTRACT,
          function: 'f',
          args: [],
          depth: 1,
          storage: [
            { durability: 'archival', key: { type: 'void' }, value: { type: 'void' }, liveUntil: 1 },
          ],
        }),
      TraceParseError,
    );
  });

  // ---------------------------------------------------------------- endWasm

  it('parses a successful endWasm with a result (L5)', () => {
    const rec = toTraceRecord(
      { pos: null, instr: ['endWasm'], success: true, depth: 1, result: { type: 'u32', value: 5 } },
      1,
    );
    const event = expectKind(rec.event, 'endWasm');
    assert.strictEqual(event.success, true);
    assert.strictEqual(event.depth, 1);
    assert.deepStrictEqual(event.result, { type: 'u32', value: 5 });
  });

  it('parses a failed endWasm and a void endWasm (null result)', () => {
    const failed = toTraceRecord(
      {
        pos: null,
        instr: ['endWasm'],
        success: false,
        depth: 2,
        result: { type: 'error', errType: 'contract', code: 3 },
      },
      1,
    );
    assert.strictEqual(expectKind(failed.event, 'endWasm').success, false);

    const voidResult = toTraceRecord(
      { pos: null, instr: ['endWasm'], success: true, depth: 1, result: null },
      1,
    );
    assert.strictEqual(expectKind(voidResult.event, 'endWasm').result, null);
  });

  // Some komet builds spell the trap-path exit marker `endWasm-error`; it is the
  // same exit, so it parses to an `endWasm` event and closes the call like any
  // other (see komet/executingContract.ts).
  it('treats an endWasm-error tag as a failed call exit', () => {
    const rec = toTraceRecord(
      { pos: null, instr: ['endWasm-error'], success: false, depth: 1, result: null },
      1,
    );
    assert.strictEqual(expectKind(rec.event, 'endWasm').success, false);
  });

  // ---------------------------------------------------------------- contractData

  it('normalizes a contractData put into key + value (L2)', () => {
    const rec = toTraceRecord(
      {
        pos: null,
        instr: ['contractData', 'put', 'instance'],
        contract: CONTRACT,
        args: [{ type: 'symbol', value: 'COUNTER' }, { type: 'u32', value: 5 }],
      },
      1,
    );
    const event = expectKind(rec.event, 'contractData');
    assert.strictEqual(event.op, 'put');
    assert.strictEqual(event.durability, 'instance');
    assert.deepStrictEqual(event.contract, { addrType: 'contract', value: '63' });
    assert.deepStrictEqual(event.key, { type: 'symbol', value: 'COUNTER' });
    assert.deepStrictEqual(event.value, { type: 'u32', value: 5 });
  });

  it('normalizes a contractData del into a key with no value (L2)', () => {
    const rec = toTraceRecord(
      {
        pos: null,
        instr: ['contractData', 'del', 'temporary'],
        contract: CONTRACT,
        args: [{ type: 'symbol', value: 'foo' }],
      },
      1,
    );
    const event = expectKind(rec.event, 'contractData');
    assert.strictEqual(event.op, 'del');
    assert.strictEqual(event.durability, 'temporary');
    assert.strictEqual(event.value, undefined);
  });

  it('rejects a contractData put with no value argument', () => {
    assert.throws(
      () =>
        strict(
          {
            pos: null,
            instr: ['contractData', 'put', 'persistent'],
            contract: CONTRACT,
            args: [{ type: 'symbol', value: 'foo' }],
          },
          4,
        ),
      /trace line 4/,
    );
  });

  it('ignores a contractData op it does not model', () => {
    const rec = toTraceRecord(
      {
        pos: null,
        instr: ['contractData', 'bumpish', 'persistent'],
        contract: CONTRACT,
        args: [{ type: 'symbol', value: 'foo' }],
      },
      1,
    );
    assert.strictEqual(rec.event, undefined);
  });

  it('parses read ops when a producer emits them', () => {
    const rec = toTraceRecord(
      {
        pos: null,
        instr: ['contractData', 'get', 'persistent'],
        contract: CONTRACT,
        args: [{ type: 'symbol', value: 'foo' }],
        result: { type: 'u32', value: 9 },
      },
      1,
    );
    const event = expectKind(rec.event, 'contractData');
    assert.strictEqual(event.op, 'get');
    assert.strictEqual(event.value, undefined);
    assert.deepStrictEqual(event.result, { type: 'u32', value: 9 });
  });

  // ---------------------------------------------------------------- ledger baseline

  it('parses a ledger baseline record (L1, L9, L10)', () => {
    const rec = toTraceRecord(
      {
        pos: null,
        instr: ['ledger'],
        sequence: 123,
        timestamp: 1712345678,
        accounts: [{ account: ACCOUNT, balance: 9876543210 }],
        contracts: [
          {
            contract: CONTRACT,
            wasmHash: 'ab12',
            liveUntil: 100,
            storage: [
              {
                durability: 'persistent',
                key: { type: 'symbol', value: 'k' },
                value: { type: 'u32', value: 1 },
                liveUntil: 50,
              },
            ],
          },
        ],
        codes: [{ hash: 'ab12', liveUntil: 200 }],
      },
      1,
    );
    const event = expectKind(rec.event, 'ledger');
    assert.strictEqual(event.sequence, 123);
    assert.strictEqual(event.timestamp, 1712345678);
    assert.deepStrictEqual(event.accounts, [
      { account: { addrType: 'account', value: '61' }, balance: 9876543210 },
    ]);
    assert.strictEqual(event.contracts[0].wasmHash, 'ab12');
    assert.strictEqual(event.contracts[0].storage[0].durability, 'persistent');
    assert.deepStrictEqual(event.codes, [{ hash: 'ab12', liveUntil: 200 }]);
  });

  it('defaults a ledger baseline\'s collections to empty', () => {
    const rec = toTraceRecord({ pos: null, instr: ['ledger'], sequence: 1, timestamp: 2 }, 1);
    const event = expectKind(rec.event, 'ledger');
    assert.deepStrictEqual(event.accounts, []);
    assert.deepStrictEqual(event.contracts, []);
    assert.deepStrictEqual(event.codes, []);
  });

  // ---------------------------------------------------------------- TTL / metadata

  it('parses the three contractTtl variants (L7)', () => {
    const data = toTraceRecord(
      {
        pos: null,
        instr: ['contractTtl', 'data'],
        contract: CONTRACT,
        durability: 'persistent',
        key: { type: 'symbol', value: 'k' },
        liveUntil: 500,
      },
      1,
    );
    const dataEvent = expectKind(data.event, 'contractTtl');
    assert.strictEqual(dataEvent.target, 'data');
    assert.strictEqual(dataEvent.liveUntil, 500);

    const instance = toTraceRecord(
      { pos: null, instr: ['contractTtl', 'instance'], contract: CONTRACT, liveUntil: 600 },
      1,
    );
    assert.strictEqual(expectKind(instance.event, 'contractTtl').target, 'instance');

    const code = toTraceRecord(
      { pos: null, instr: ['contractTtl', 'code'], hash: 'ab12', liveUntil: 700 },
      1,
    );
    const codeEvent = expectKind(code.event, 'contractTtl');
    assert.strictEqual(codeEvent.target, 'code');
    assert.strictEqual(codeEvent.target === 'code' ? codeEvent.hash : null, 'ab12');
  });

  it('parses contractCode and deployContract events (L8)', () => {
    const updated = toTraceRecord(
      { pos: null, instr: ['contractCode'], contract: CONTRACT, wasmHash: 'cd34' },
      1,
    );
    assert.strictEqual(expectKind(updated.event, 'contractCode').wasmHash, 'cd34');

    const deployed = toTraceRecord(
      { pos: null, instr: ['deployContract'], contract: CONTRACT, wasmHash: 'cd34', liveUntil: 42 },
      1,
    );
    const event = expectKind(deployed.event, 'deployContract');
    assert.strictEqual(event.liveUntil, 42);
  });

  it('parses account and ledgerInfo events (L9, L10)', () => {
    const account = toTraceRecord(
      { pos: null, instr: ['account', 'set'], account: ACCOUNT, balance: 17 },
      1,
    );
    assert.strictEqual(expectKind(account.event, 'account').balance, 17);

    const info = toTraceRecord(
      { pos: null, instr: ['ledgerInfo'], sequence: 9, timestamp: 10 },
      1,
    );
    assert.strictEqual(expectKind(info.event, 'ledgerInfo').sequence, 9);
  });

  // ---------------------------------------------------------------- addObject / hostCall

  it('parses an addObject event (L11)', () => {
    const rec = toTraceRecord(
      { pos: null, instr: ['addObject'], value: { type: 'u32', value: 8 }, index: 3 },
      1,
    );
    const event = expectKind(rec.event, 'addObject');
    assert.strictEqual(event.index, 3);
    assert.deepStrictEqual(event.value, { type: 'u32', value: 8 });
  });

  it('parses a hostCall event, whose tag carries module and function', () => {
    const rec = toTraceRecord(
      { pos: null, instr: ['hostCall', 'l', '_'], locals: { '0': ['i64', 253576579652878] } },
      1,
    );
    const event = expectKind(rec.event, 'hostCall');
    assert.strictEqual(event.module, 'l');
    assert.strictEqual(event.function, '_');
    // The locals of the host call are still available through the record itself.
    assert.deepStrictEqual(rec.locals['0'], ['i64', 253576579652878]);
  });

  // ---------------------------------------------------------------- tolerance

  // Forward compatibility: a komet release that adds an event tag must not break
  // an older adapter. Unknown tags parse as ordinary records with no payload.
  it('ignores an unknown event tag instead of throwing', () => {
    const rec = toTraceRecord(
      { pos: null, instr: ['somethingNew'], mystery: 42 },
      1,
    );
    assert.strictEqual(rec.event, undefined);
    assert.strictEqual(rec.instr[0], 'somethingNew');
  });

  // The STRICT parser pins the payload contract, so producer drift is
  // diagnosable and a validation tool has something to call.
  it('strict parsing rejects a known event tag with a malformed payload', () => {
    assert.throws(
      () => strict({ pos: null, instr: ['addObject'], value: { type: 'u32' } }, 9),
      /trace line 9/,
    );
    assert.throws(
      () => strict({ pos: null, instr: ['endWasm'], depth: 1, result: null }),
      TraceParseError,
    );
    assert.throws(
      () => strict({ pos: null, instr: ['ledgerInfo'], sequence: 'soon' }),
      TraceParseError,
    );
  });

  it('strict parsing rejects an address that is not a hex string', () => {
    assert.throws(
      () =>
        strict({
          pos: null,
          instr: ['account', 'set'],
          account: { type: 'address', addrType: 'account', value: 'zz' },
          balance: 1,
        }),
      TraceParseError,
    );
  });

  // Production parsing is tolerant: the state views are auxiliary, so a payload
  // this adapter cannot read degrades to "no payload" (G4/L14) and stepping,
  // breakpoints and source mapping are unaffected.
  it('tolerates a malformed payload rather than failing the record', () => {
    const malformed: Record<string, unknown>[] = [
      { pos: null, instr: ['addObject'], value: { type: 'u32' } },
      { pos: null, instr: ['endWasm'], depth: 1, result: null },
      { pos: null, instr: ['ledgerInfo'], sequence: 'soon' },
      // The minimal partial callContract that mocks and older fixtures build.
      { pos: null, instr: ['callContract'], from: {}, to: {}, function: 'add', args: [] },
    ];
    for (const obj of malformed) {
      const rec = toTraceRecord(obj, 1);
      assert.strictEqual(rec.event, undefined, `expected no payload for ${JSON.stringify(obj)}`);
      // The record itself still parses, so replay is unaffected.
      assert.strictEqual(rec.pos, null);
      assert.strictEqual(rec.instr[0], (obj.instr as string[])[0]);
    }
  });

  // A malformed CORE field is still a hard error — stepping cannot work without
  // pos/instr/stack/locals, so the tolerance above must not have widened that.
  it('still fails loudly on a malformed core field', () => {
    assert.throws(
      () => toTraceRecord({ pos: 'nope', instr: ['callContract'] }, 1),
      TraceParseError,
    );
    assert.throws(
      () => toTraceRecord({ pos: null, instr: ['endWasm'], stack: [['i64']] }, 1),
      TraceParseError,
    );
  });

  // ---------------------------------------------------------------- real fixture

  it('parses every event record in the increment fixture', async () => {
    const jsonl = await fs.readFile(INCREMENT_TRACE, 'utf8');
    const records = parseTraceJsonl(jsonl);
    const events = records.map((r) => r.event).filter((e): e is TraceEvent => e !== undefined);

    const kinds = new Set(events.map((e) => e.kind));
    assert.ok(kinds.has('callContract'), 'fixture should carry callContract');
    assert.ok(kinds.has('endWasm'), 'fixture should carry endWasm');
    assert.ok(kinds.has('contractData'), 'fixture should carry contractData');
    assert.ok(kinds.has('hostCall'), 'fixture should carry hostCall');

    // The fixture's write is an instance-storage put of COUNTER = 5.
    const put = events.find((e) => e.kind === 'contractData');
    assert.ok(put && put.kind === 'contractData');
    assert.strictEqual(put.op, 'put');
    assert.strictEqual(put.durability, 'instance');
    assert.deepStrictEqual(put.key, { type: 'symbol', value: 'COUNTER' });

    // Most records are instructions and carry no event payload.
    assert.ok(records.filter((r) => r.event === undefined).length > events.length);
  });
});
