import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import { parseTraceJsonl, toTraceRecords, TraceRecord } from '../src/komet/trace';
import { LedgerImage } from '../src/debugAdapter/LedgerImage';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const INCREMENT_TRACE = path.join(FIXTURES, 'increment-debug.trace.jsonl');
const ADDER_TRACE = path.join(FIXTURES, 'adder-debug.trace.jsonl');

const A = { type: 'address', addrType: 'account', value: '61' };
const C = { type: 'address', addrType: 'contract', value: '63' };
const C2 = { type: 'address', addrType: 'contract', value: '64' };

const sym = (s: string) => ({ type: 'symbol', value: s });
const u32 = (n: number) => ({ type: 'u32', value: n });

/** A no-op instruction record, the filler between events. */
function nop(pos = 1): Record<string, unknown> {
  return { kind: 'instr', pos, instr: ['nop'], stack: [], locals: {} };
}

function call(to: Record<string, unknown> = C, depth = 1, storage: unknown[] = []) {
  return { kind: 'callContract', from: A, to, function: 'f', args: [], depth, storage };
}

function end(success = true, depth = 1) {
  return { kind: 'endWasm', success, depth, result: null };
}

function put(key: string, value: number, durability = 'instance', contract = C) {
  return {
    kind: 'contractData', operation: 'put', durability,
    contract,
    args: [sym(key), u32(value)],
  };
}

function del(key: string, durability = 'instance', contract = C) {
  return { kind: 'contractData', operation: 'del', durability, contract, args: [sym(key)] };
}

function build(objs: Record<string, unknown>[]): TraceRecord[] {
  return toTraceRecords(objs);
}

/** Storage of `contract` at `cursor`, as "durability:key=value" strings. */
function storage(image: LedgerImage, cursor: number, contract?: string): string[] {
  return image
    .storageAt(cursor, contract)
    .map((e) => `${e.durability}:${String(e.key.value)}=${String(e.value.value)}`);
}

describe('LedgerImage (docs/state-inspection.md, L1–L15)', () => {
  // ------------------------------------------------------------------ L14

  it('L14: reports no ledger for a trace with no ledger information', () => {
    const image = new LedgerImage(build([nop(), nop()]));
    assert.strictEqual(image.hasLedger(), false);
    // No query throws; each reports "unavailable" rather than a fabricated ledger.
    assert.deepStrictEqual(image.storageAt(0), []);
    assert.deepStrictEqual(image.accountsAt(0), []);
    assert.deepStrictEqual(image.contractsAt(0), []);
    assert.strictEqual(image.ledgerInfoAt(0), undefined);
    assert.deepStrictEqual(image.hostObjectsAt(0), []);
    assert.deepStrictEqual(image.callStackAt(0), []);
  });

  it('L14: reports a ledger once any ledger-bearing event appears', () => {
    assert.strictEqual(new LedgerImage(build([call(), nop()])).hasLedger(), true);
    assert.strictEqual(new LedgerImage(build([put('k', 1), nop()])).hasLedger(), true);
  });

  // ------------------------------------------------------------------ L1

  it('L1: seeds storage from a callContract baseline, inclusive at that record', () => {
    const records = build([
      call(C, 1, [
        { durability: 'instance', key: sym('COUNTER'), value: u32(4), liveUntil: 100 },
      ]),
      nop(),
    ]);
    const image = new LedgerImage(records);
    // L15: a baseline is a snapshot, so it is already in effect AT its record.
    assert.deepStrictEqual(storage(image, 0), ['instance:COUNTER=4']);
    assert.deepStrictEqual(storage(image, 1), ['instance:COUNTER=4']);
    assert.strictEqual(image.storageAt(0)[0].liveUntil, 100);
  });

  it('L1: a ledger baseline seeds storage, accounts, contracts, codes and info', () => {
    const records = build([
      {
        kind: 'ledger',
        sequence: 7,
        timestamp: 1700,
        accounts: [{ account: A, balance: 500 }],
        contracts: [
          {
            contract: C,
            wasmHash: 'ab12',
            liveUntil: 100,
            storage: [
              { durability: 'persistent', key: sym('p'), value: u32(1), liveUntil: 50 },
            ],
          },
        ],
        codes: [{ hash: 'ab12', liveUntil: 200 }],
      },
      nop(),
    ]);
    const image = new LedgerImage(records);
    assert.deepStrictEqual(storage(image, 0), ['persistent:p=1']);
    assert.deepStrictEqual(image.accountsAt(0), [{ account: '61', balance: 500 }]);
    assert.deepStrictEqual(image.contractsAt(0), [
      { contract: '63', wasmHash: 'ab12', liveUntil: 100 },
    ]);
    assert.deepStrictEqual(image.codesAt(0), [{ hash: 'ab12', liveUntil: 200 }]);
    assert.deepStrictEqual(image.ledgerInfoAt(0), { sequence: 7, timestamp: 1700 });
  });

  // ------------------------------------------------------------------ L2, L15

  it('L2/L15: a put applies from the record AFTER it', () => {
    const image = new LedgerImage(build([call(), put('k', 5), nop(), nop()]));
    // Standing on the put, the write has not happened yet.
    assert.deepStrictEqual(storage(image, 1), []);
    assert.deepStrictEqual(storage(image, 2), ['instance:k=5']);
    assert.deepStrictEqual(storage(image, 3), ['instance:k=5']);
  });

  it('L2: a put overwrites and a del removes', () => {
    const image = new LedgerImage(
      build([call(), put('k', 1), put('k', 2), del('k'), nop()]),
    );
    assert.deepStrictEqual(storage(image, 2), ['instance:k=1']);
    assert.deepStrictEqual(storage(image, 3), ['instance:k=2']);
    assert.deepStrictEqual(storage(image, 4), []);
  });

  it('L2: a del of an absent key is harmless', () => {
    const image = new LedgerImage(build([call(), del('nope'), nop()]));
    assert.deepStrictEqual(storage(image, 2), []);
  });

  // ------------------------------------------------------------------ L3

  it('L3: the three durabilities are disjoint key spaces', () => {
    const image = new LedgerImage(
      build([
        call(),
        put('k', 1, 'instance'),
        put('k', 2, 'persistent'),
        put('k', 3, 'temporary'),
        nop(),
      ]),
    );
    assert.deepStrictEqual(storage(image, 4).sort(), [
      'instance:k=1',
      'persistent:k=2',
      'temporary:k=3',
    ]);
    // Deleting one leaves the others alone.
    const withDel = new LedgerImage(
      build([call(), put('k', 1, 'instance'), put('k', 2, 'persistent'), del('k', 'instance'), nop()]),
    );
    assert.deepStrictEqual(storage(withDel, 4), ['persistent:k=2']);
  });

  // ------------------------------------------------------------------ L4

  it('L4: a write applies to the contract it names, not the executing one', () => {
    const image = new LedgerImage(
      build([
        call(C),
        put('mine', 1, 'instance', C),
        // A reentrant write onto a different contract while C executes.
        put('theirs', 2, 'instance', C2),
        nop(),
      ]),
    );
    assert.deepStrictEqual(storage(image, 3, '63'), ['instance:mine=1']);
    assert.deepStrictEqual(storage(image, 3, '64'), ['instance:theirs=2']);
    // Unfiltered, both are present.
    assert.strictEqual(image.storageAt(3).length, 2);
  });

  // ------------------------------------------------------------------ L5

  it('L5: a failed call rolls back the writes made inside it', () => {
    const records = build([
      call(C, 1),
      put('kept', 1),
      call(C, 2), //           inner call starts
      put('doomed', 2),
      end(false, 2), //        inner call FAILS
      nop(), //                <- after rollback
    ]);
    const image = new LedgerImage(records);
    assert.deepStrictEqual(storage(image, 4).sort(), ['instance:doomed=2', 'instance:kept=1']);
    // The inner call's write is gone; the outer call's survives.
    assert.deepStrictEqual(storage(image, 5), ['instance:kept=1']);
  });

  it('L5: a successful inner call keeps its writes', () => {
    const image = new LedgerImage(
      build([call(C, 1), call(C, 2), put('k', 1), end(true, 2), nop()]),
    );
    assert.deepStrictEqual(storage(image, 4), ['instance:k=1']);
  });

  it('L5: rollback nests — an inner failure inside an outer success', () => {
    const image = new LedgerImage(
      build([
        call(C, 1),
        put('outer', 1),
        call(C, 2),
        put('inner', 2),
        end(false, 2),
        put('after', 3),
        end(true, 1),
        nop(),
      ]),
    );
    assert.deepStrictEqual(storage(image, 7).sort(), ['instance:after=3', 'instance:outer=1']);
  });

  it('L5: rollback restores balances and TTLs too, not only storage', () => {
    const records = build([
      {
        kind: 'ledger',
        sequence: 1,
        timestamp: 2,
        accounts: [{ account: A, balance: 100 }],
        contracts: [{ contract: C, wasmHash: 'ab12', liveUntil: 10, storage: [] }],
        codes: [],
      },
      call(C, 1),
      { kind: 'account', account: A, balance: 999 },
      { kind: 'contractTtl', target: 'instance', contract: C, liveUntil: 777 },
      end(false, 1),
      nop(),
    ]);
    const image = new LedgerImage(records);
    assert.deepStrictEqual(image.accountsAt(4), [{ account: '61', balance: 999 }]);
    assert.strictEqual(image.contractsAt(4)[0].liveUntil, 777);
    // After the failed call both are back to their pre-call values.
    assert.deepStrictEqual(image.accountsAt(5), [{ account: '61', balance: 100 }]);
    assert.strictEqual(image.contractsAt(5)[0].liveUntil, 10);
  });

  it('L5: an unmatched endWasm does not throw', () => {
    const image = new LedgerImage(build([end(false, 1), nop()]));
    assert.deepStrictEqual(storage(image, 1), []);
  });

  // ------------------------------------------------------------------ L6

  it('L6: the call stack nests, innermost first, and pops after an exit', () => {
    const records = build([call(C, 1), nop(), call(C2, 2), nop(), end(true, 2), nop()]);
    const image = new LedgerImage(records);
    assert.deepStrictEqual(
      image.callStackAt(1).map((f) => f.to.value),
      ['63'],
    );
    // L15: the push is a snapshot-like effect, visible AT the callContract.
    assert.deepStrictEqual(
      image.callStackAt(2).map((f) => f.to.value),
      ['64', '63'],
    );
    assert.deepStrictEqual(
      image.callStackAt(3).map((f) => f.to.value),
      ['64', '63'],
    );
    // The exit is a mutation: still inside the callee AT the endWasm record.
    assert.deepStrictEqual(
      image.callStackAt(4).map((f) => f.to.value),
      ['64', '63'],
    );
    assert.deepStrictEqual(
      image.callStackAt(5).map((f) => f.to.value),
      ['63'],
    );
  });

  it('L6: a root call with no matching endWasm stays open to the end', () => {
    const image = new LedgerImage(build([call(C, 1), nop(), nop()]));
    assert.strictEqual(image.callStackAt(2).length, 1);
    assert.strictEqual(image.callStackAt(2)[0].function, 'f');
  });

  it('L6: the executing contract is the innermost open call', () => {
    const image = new LedgerImage(build([call(C, 1), call(C2, 2), nop(), end(true, 2), nop()]));
    assert.strictEqual(image.executingContractAt(2), '64');
    assert.strictEqual(image.executingContractAt(4), '63');
    assert.strictEqual(new LedgerImage(build([nop()])).executingContractAt(0), undefined);
  });

  // ------------------------------------------------------------------ L7

  it('L7: a TTL event updates liveUntil without touching the value', () => {
    const records = build([
      call(C, 1, [{ durability: 'persistent', key: sym('k'), value: u32(9), liveUntil: 50 }]),
      {
        kind: 'contractTtl', target: 'data',
        contract: C,
        durability: 'persistent',
        key: sym('k'),
        liveUntil: 500,
      },
      nop(),
    ]);
    const image = new LedgerImage(records);
    assert.strictEqual(image.storageAt(1)[0].liveUntil, 50);
    const bumped = image.storageAt(2)[0];
    assert.strictEqual(bumped.liveUntil, 500);
    assert.strictEqual(String(bumped.value.value), '9');
  });

  it('L7: a TTL event for an unknown entry is ignored, not fabricated', () => {
    const image = new LedgerImage(
      build([
        call(),
        {
          kind: 'contractTtl', target: 'data',
          contract: C,
          durability: 'persistent',
          key: sym('ghost'),
          liveUntil: 500,
        },
        nop(),
      ]),
    );
    assert.deepStrictEqual(storage(image, 2), []);
  });

  it('L7: code TTL applies to the uploaded code entry', () => {
    const records = build([
      {
        kind: 'ledger',
        sequence: 1,
        timestamp: 1,
        accounts: [],
        contracts: [],
        codes: [{ hash: 'ab12', liveUntil: 10 }],
      },
      { kind: 'contractTtl', target: 'code', hash: 'ab12', liveUntil: 99 },
      nop(),
    ]);
    const image = new LedgerImage(records);
    assert.deepStrictEqual(image.codesAt(2), [{ hash: 'ab12', liveUntil: 99 }]);
  });

  // ------------------------------------------------------------------ L8

  it('L8: deployContract creates an entry and contractCode replaces its hash', () => {
    const records = build([
      { kind: 'deployContract', contract: C, wasmHash: 'ab12', liveUntil: 42 },
      nop(),
      { kind: 'contractCode', contract: C, wasmHash: 'cd34' },
      nop(),
    ]);
    const image = new LedgerImage(records);
    assert.deepStrictEqual(image.contractsAt(1), [
      { contract: '63', wasmHash: 'ab12', liveUntil: 42 },
    ]);
    // The hash is replaced; the TTL survives.
    assert.deepStrictEqual(image.contractsAt(3), [
      { contract: '63', wasmHash: 'cd34', liveUntil: 42 },
    ]);
  });

  // ------------------------------------------------------------------ L9, L10

  it('L9: an account event sets a balance, creating the account if absent', () => {
    const image = new LedgerImage(
      build([
        { kind: 'account', account: A, balance: 17 },
        nop(),
        { kind: 'account', account: A, balance: 18 },
        nop(),
      ]),
    );
    assert.deepStrictEqual(image.accountsAt(1), [{ account: '61', balance: 17 }]);
    assert.deepStrictEqual(image.accountsAt(3), [{ account: '61', balance: 18 }]);
  });

  it('L10: a ledgerInfo event sets sequence and timestamp', () => {
    const image = new LedgerImage(
      build([{ kind: 'ledgerInfo', sequence: 9, timestamp: 10 }, nop()]),
    );
    assert.strictEqual(image.ledgerInfoAt(0), undefined);
    assert.deepStrictEqual(image.ledgerInfoAt(1), { sequence: 9, timestamp: 10 });
  });

  // ------------------------------------------------------------------ L11

  it('L11: the host object table grows by addObject and is index-ordered', () => {
    const records = build([
      { kind: 'addObject', value: u32(7), index: 0 },
      nop(),
      { kind: 'addObject', value: sym('s'), index: 1 },
      nop(),
    ]);
    const image = new LedgerImage(records);
    assert.deepStrictEqual(image.hostObjectsAt(0), []);
    assert.strictEqual(image.hostObjectsAt(1).length, 1);
    assert.deepStrictEqual(image.hostObjectsAt(3).map((o) => o.index), [0, 1]);
    assert.strictEqual(String(image.hostObjectsAt(3)[1].value.value), 's');
  });

  // The object table is NOT part of the pushed world state, so popWorldState
  // does not restore it — a failed call's allocations remain.
  it('L11: host objects are never rolled back by a failed call', () => {
    const image = new LedgerImage(
      build([
        call(C, 1),
        { kind: 'addObject', value: u32(7), index: 0 },
        nop(),
        end(false, 1),
        nop(),
      ]),
    );
    assert.strictEqual(image.hostObjectsAt(2).length, 1);
    assert.strictEqual(image.hostObjectsAt(4).length, 1);
  });

  // ------------------------------------------------------------------ L12

  it('L12: the image at a cursor is independent of the path taken to it', () => {
    const records = build([
      call(C, 1),
      put('a', 1),
      put('b', 2),
      del('a'),
      put('c', 3),
      nop(),
    ]);
    const image = new LedgerImage(records);
    const forward: string[][] = [];
    for (let i = 0; i < records.length; i++) {
      forward.push(storage(image, i).sort());
    }
    const backward: string[][] = [];
    for (let i = records.length - 1; i >= 0; i--) {
      backward.unshift(storage(image, i).sort());
    }
    assert.deepStrictEqual(backward, forward);
    // Repeated queries at one cursor are stable too.
    assert.deepStrictEqual(storage(image, 3).sort(), forward[3]);
  });

  it('L12: cursors outside the trace clamp instead of throwing', () => {
    const records = build([call(C, 1), put('k', 1), nop()]);
    const image = new LedgerImage(records);
    assert.deepStrictEqual(storage(image, -5), storage(image, 0));
    assert.deepStrictEqual(storage(image, 999), storage(image, records.length - 1));
  });

  it('handles an empty trace', () => {
    const image = new LedgerImage([]);
    assert.strictEqual(image.hasLedger(), false);
    assert.deepStrictEqual(image.storageAt(0), []);
    assert.deepStrictEqual(image.callStackAt(0), []);
  });

  // ------------------------------------------------------------------ L13

  // Structural sharing: unchanged records must reuse the previous state object
  // rather than each holding a copy of the whole ledger.
  it('L13: state is materialized only at records that change it', () => {
    const records = build([call(C, 1), put('k', 1), nop(), nop(), nop(), nop()]);
    const image = new LedgerImage(records);
    assert.ok(
      image.versionCount() <= 4,
      `expected a handful of versions, got ${image.versionCount()}`,
    );
    // Six records, but the long nop tail shares one state.
    assert.strictEqual(image.versionCount() < records.length, true);
  });

  // ------------------------------------------------------------------ changed hint

  it('reports which storage entries changed between two cursors', () => {
    const records = build([call(C, 1), put('a', 1), put('b', 2), put('a', 9), nop()]);
    const image = new LedgerImage(records);
    const entriesAt4 = image.storageAt(4);
    const changed = image.changedSince(2, 4);
    const a = entriesAt4.find((e) => e.key.value === 'a')!;
    const b = entriesAt4.find((e) => e.key.value === 'b')!;
    // Between cursor 2 (a=1 known) and cursor 4: b was added and a changed.
    assert.ok(changed.has(a.id), 'a changed');
    assert.ok(changed.has(b.id), 'b was added');
    // Nothing changed across a span with no events.
    assert.strictEqual(image.changedSince(4, 4).size, 0);
  });

  // ------------------------------------------------------------------ real fixtures

  it('reconstructs the increment fixture ledger from its real trace', async () => {
    const records = parseTraceJsonl(await fs.readFile(INCREMENT_TRACE, 'utf8'));
    const image = new LedgerImage(records);
    assert.strictEqual(image.hasLedger(), true);

    // The fixture's contract writes COUNTER = 5 into instance storage. Before
    // that write the baseline is empty; at the end of the trace it is present.
    const last = records.length - 1;
    const finalStorage = image.storageAt(last);
    assert.strictEqual(finalStorage.length, 1, JSON.stringify(finalStorage));
    assert.strictEqual(finalStorage[0].durability, 'instance');
    assert.strictEqual(String(finalStorage[0].key.value), 'COUNTER');
    assert.strictEqual(String(finalStorage[0].value.value), '5');

    // At the very first record (the root callContract) storage is still empty.
    assert.deepStrictEqual(image.storageAt(0), []);

    // The root call is open at the start and names the traced contract.
    assert.strictEqual(image.callStackAt(0).length, 1);
    assert.strictEqual(image.callStackAt(0)[0].function, 'increment');
    assert.strictEqual(image.executingContractAt(0), '63');
  });

  it('reports no ledger for the adder fixture, which carries no events', async () => {
    const records = parseTraceJsonl(await fs.readFile(ADDER_TRACE, 'utf8'));
    const image = new LedgerImage(records);
    assert.strictEqual(image.hasLedger(), false);
  });
});
