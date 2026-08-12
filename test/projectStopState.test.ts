/**
 * The `globals` and `ledger` projections of a CLI stop record
 * (docs/state-inspection.md; docs/trace-cli-internal.md).
 *
 * Unlike the DAP tree, the JSONL projection is machine-readable, so it carries
 * the `changed` flag DAP has no vocabulary for: a consumer diffing two stops
 * cannot watch a tree move.
 */

import * as assert from 'assert';
import * as path from 'path';
import { buildStopModel } from '../src/debugAdapter/stopModel';
import { projectSourceStop } from '../src/trace/projectStop';
import { runCliTrace } from '../src/trace/runTrace';
import { RawTraceBackend } from '../src/debugAdapter/backends/RawTraceBackend';
import { ResolvedTrace } from '../src/debugAdapter/types';
import { StrKey } from '@stellar/stellar-sdk';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const CONTRACT_STRKEY = StrKey.encodeContract(Buffer.from('07'.repeat(32), 'hex'));
const ACCOUNT_STRKEY = StrKey.encodeEd25519PublicKey(Buffer.from('08'.repeat(32), 'hex'));

async function resolve(traceName: string, wasmName?: string): Promise<ResolvedTrace> {
  const args: Record<string, string> = {
    rawTrace: path.join(FIXTURES, `${traceName}.trace.jsonl`),
  };
  if (wasmName) {
    args.wasmPath = path.join(FIXTURES, `${wasmName}.wasm`);
  }
  return new RawTraceBackend().resolve(args as never, () => {});
}

describe('CLI stop projection — globals and ledger', () => {
  describe('a trace carrying globals and ledger events', () => {
    let resolved: ResolvedTrace;

    before(async () => {
      resolved = await resolve('ledger-globals');
    });

    it('G2: projects the globals of the record, keyed by module index', () => {
      const sm = buildStopModel(resolved);
      // Record 2 is the first instruction record of the fixture.
      const stop = projectSourceStop(resolved, sm, 2);
      assert.deepStrictEqual(stop.globals, { '0': { type: 'i32', value: '1048576' } });
      // Record 4 has moved the shadow-stack pointer.
      assert.deepStrictEqual(projectSourceStop(resolved, sm, 4).globals, {
        '0': { type: 'i32', value: '1048560' },
      });
    });

    it('L1/L3: projects storage grouped by durability with keys, values and TTLs', () => {
      const sm = buildStopModel(resolved);
      const stop = projectSourceStop(resolved, sm, 2);
      assert.ok(stop.ledger, 'expected a ledger projection');
      const entries = stop.ledger.storage;
      assert.deepStrictEqual(
        entries.map((e) => [e.durability, e.key, e.value, e.liveUntil]),
        [
          ['instance', 'symbol(COUNTER)', '4', 100],
          ['persistent', 'symbol(OWNER)', ACCOUNT_STRKEY, 90],
        ],
      );
    });

    it('L6/L9/L10: projects the call stack, accounts, contract and ledger info', () => {
      const stop = projectSourceStop(resolved, buildStopModel(resolved), 2);
      assert.ok(stop.ledger);
      assert.strictEqual(stop.ledger.contract, CONTRACT_STRKEY);
      assert.deepStrictEqual(stop.ledger.info, { sequence: 42, timestamp: 1712345678 });
      assert.deepStrictEqual(stop.ledger.accounts, [
        { account: ACCOUNT_STRKEY, balance: 9876543210 },
      ]);
      assert.deepStrictEqual(stop.ledger.callStack, [
        { from: ACCOUNT_STRKEY, to: CONTRACT_STRKEY, function: 'bump', depth: 1, args: ['5'] },
      ]);
    });

    it('L11: projects the host object table', () => {
      const sm = buildStopModel(resolved);
      assert.deepStrictEqual(projectSourceStop(resolved, sm, 2).ledger?.hostObjects, []);
      assert.deepStrictEqual(projectSourceStop(resolved, sm, 6).ledger?.hostObjects, [
        { index: 0, value: 'COUNTER' },
      ]);
    });

    // The flag DAP cannot express: what this stop changed relative to a previous
    // cursor, so a consumer need not diff two whole trees.
    it('marks storage entries that changed since a previous cursor', () => {
      const sm = buildStopModel(resolved);
      // Between record 2 and record 8 the COUNTER write landed.
      const stop = projectSourceStop(resolved, sm, 8, { previousIndex: 2 });
      const counter = stop.ledger?.storage.find((e) => e.key === 'symbol(COUNTER)');
      assert.strictEqual(counter?.value, '5');
      assert.strictEqual(counter?.changed, true);
      // OWNER did not change over that span, so it carries no flag at all.
      const owner = stop.ledger?.storage.find((e) => e.key === 'symbol(OWNER)');
      assert.strictEqual(owner?.changed, undefined);
    });

    it('omits the changed flag entirely with no previous cursor', () => {
      const stop = projectSourceStop(resolved, buildStopModel(resolved), 8);
      for (const entry of stop.ledger?.storage ?? []) {
        assert.strictEqual(entry.changed, undefined);
      }
    });

    // This fixture has no DWARF, so `runCliTrace` emits no source stops at all
    // (its documented contract) — but `meta` still announces the capabilities.
    it('announces the capabilities in meta so a consumer can branch', () => {
      const lines = runCliTrace(resolved, { allowNoSource: true }).map((l) => JSON.parse(l));
      const meta = lines.find((l) => l.kind === 'meta');
      assert.strictEqual(meta.hasGlobals, true);
      assert.strictEqual(meta.hasLedger, true);
      assert.strictEqual(meta.hasDwarf, false);
    });
  });

  describe('a trace carrying neither', () => {
    it('G4/L14: omits both keys rather than emitting empty ones', async () => {
      const resolved = await resolve('adder-debug', 'adder-debug');
      const sm = buildStopModel(resolved);
      const stop = projectSourceStop(resolved, sm, 29);
      assert.strictEqual(stop.globals, undefined);
      assert.strictEqual(stop.ledger, undefined);

      const lines = runCliTrace(resolved).map((l) => JSON.parse(l));
      const meta = lines.find((l) => l.kind === 'meta');
      assert.strictEqual(meta.hasGlobals, false);
      assert.strictEqual(meta.hasLedger, false);
      // The pre-existing stop fields are untouched.
      const first = lines.find((l) => l.kind === 'stop');
      assert.strictEqual(first.traceIndex, 29);
      assert.ok(Array.isArray(first.variables));
    });
  });

  describe('a real trace with ledger events but no globals', () => {
    let resolved: ResolvedTrace;

    before(async () => {
      resolved = await resolve('increment-debug', 'increment-debug');
    });

    it('projects the ledger and omits globals', () => {
      const sm = buildStopModel(resolved);
      const last = resolved.model.records.length - 1;
      const stop = projectSourceStop(resolved, sm, last);
      assert.strictEqual(stop.globals, undefined);
      assert.ok(stop.ledger, 'expected a ledger projection');
      assert.deepStrictEqual(
        stop.ledger.storage.map((e) => [e.durability, e.key, e.value]),
        [['instance', 'symbol(COUNTER)', '5']],
      );
    });

    it('threads the ledger and the changed flags through the whole-run JSONL', () => {
      const lines = runCliTrace(resolved).map((l) => JSON.parse(l));
      const meta = lines.find((l) => l.kind === 'meta');
      assert.strictEqual(meta.hasLedger, true);
      assert.strictEqual(meta.hasGlobals, false);

      const stops = lines.filter((l) => l.kind === 'stop');
      assert.ok(stops.length > 1, `expected several stops, got ${stops.length}`);
      for (const stop of stops) {
        assert.ok(stop.ledger, 'every stop should carry a ledger');
        assert.strictEqual(stop.globals, undefined);
      }
      // The first stop has no previous stop, so nothing can be flagged there.
      for (const entry of stops[0].ledger.storage) {
        assert.strictEqual(entry.changed, undefined);
      }
      // The COUNTER write happens mid-trace, so some later stop reports it.
      const withChange = stops.filter((s) =>
        (s.ledger.storage ?? []).some((e: { changed?: boolean }) => e.changed),
      );
      assert.ok(withChange.length > 0, 'expected a stop to report the COUNTER write');
    });
  });
});
