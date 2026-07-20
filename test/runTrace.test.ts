/**
 * Unit suite for the one-shot CLI trace projection
 * (docs/trace-cli-internal.md, "Interface 1 — one-shot CLI"). The module under test
 * does not exist yet — this is the red anchor for it.
 *
 *   runCliTrace(resolved, opts): string[]  from src/trace/runTrace.ts
 *
 * It walks stopModel.runStarts in order — provably the same sequence a user
 * sees stepping in — and emits kind-tagged JSONL lines: a leading `meta`
 * record, one `stop` per runStart, then a trailing `result`. If runStarts is
 * empty (no DWARF / no source) it ERRORS rather than silently emitting
 * visibleIndices, unless opts.allowNoSource is set. Values are pinned to the
 * verified ground-truth fixtures.
 */

import * as assert from 'assert';
import * as path from 'path';
import { buildStopModel } from '../src/debugAdapter/stopModel';
import { runCliTrace } from '../src/trace/runTrace';
import { RawTraceBackend } from '../src/debugAdapter/backends/RawTraceBackend';
import { ResolvedTrace } from '../src/debugAdapter/types';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');

/** Resolve a symbol-rich ResolvedTrace (rawTrace + wasmPath) for a fixture. */
async function resolveFixture(name: string): Promise<ResolvedTrace> {
  const args = {
    rawTrace: path.join(FIXTURES, `${name}.trace.jsonl`),
    wasmPath: path.join(FIXTURES, `${name}.wasm`),
  };
  return new RawTraceBackend().resolve(args as any, () => {});
}

describe('runCliTrace (docs/trace-cli-internal.md, one-shot CLI JSONL)', () => {
  describe('adder-debug (records=41, runStarts=[29])', () => {
    let resolved: ResolvedTrace;

    before(async () => {
      resolved = await resolveFixture('adder-debug');
    });

    it('emits meta, exactly one stop, and a terminated result', () => {
      const sm = buildStopModel(resolved);
      const lines = runCliTrace(resolved, {});
      assert.ok(Array.isArray(lines), 'expected string[] JSONL lines');

      // Line 0: meta.
      const meta = JSON.parse(lines[0]);
      assert.strictEqual(meta.kind, 'meta');
      assert.strictEqual(meta.records, 41);
      assert.strictEqual(meta.stops, 1);
      assert.strictEqual(meta.hasDwarf, true);

      // Exactly runStarts.length stop lines.
      const stops = lines.map((l) => JSON.parse(l)).filter((r) => r.kind === 'stop');
      assert.strictEqual(stops.length, sm.runStarts.length);
      assert.strictEqual(stops.length, 1);

      // The last line is the terminated result, with NO returnValue
      // (RawTraceBackend sets none).
      const result = JSON.parse(lines[lines.length - 1]);
      assert.strictEqual(result.kind, 'result');
      assert.strictEqual(result.terminated, true);
      assert.ok(
        !('returnValue' in result) || result.returnValue === undefined,
        `expected no returnValue, got: ${JSON.stringify(result)}`,
      );
    });

    it('pins the step-0 stop values', () => {
      const lines = runCliTrace(resolved, {});
      const stop = lines.map((l) => JSON.parse(l)).find((r) => r.kind === 'stop');
      assert.ok(stop, 'expected a stop line');

      assert.strictEqual(stop.step, 0);
      assert.strictEqual(stop.traceIndex, 29);
      assert.strictEqual(stop.depth, 0);
      assert.strictEqual(stop.pc, '0x2d');
      assert.strictEqual(stop.function, 'invoke_raw_extern');
      assert.ok(
        String(stop.instr).startsWith('i32.add'),
        `expected instr to start with i32.add, got: ${stop.instr}`,
      );
      assert.strictEqual(stop.source.line, 16);
      assert.strictEqual(stop.source.column, 9);
      assert.ok(
        String(stop.source.path).endsWith('examples/adder/src/lib.rs'),
        `unexpected source path: ${stop.source.path}`,
      );
      assert.deepStrictEqual(stop.variables, [
        { name: 'arg_0', type: 'Val', value: '17179869188' },
        { name: 'arg_1', type: 'Val', value: '12884901892' },
      ]);
    });
  });

  describe('stepper-debug (records=85, 10 source stops)', () => {
    it('emits one ascending stop per runStart with matching traceIndex', async () => {
      const resolved = await resolveFixture('stepper-debug');
      const sm = buildStopModel(resolved);
      const lines = runCliTrace(resolved, {});

      const stops = lines.map((l) => JSON.parse(l)).filter((r) => r.kind === 'stop');
      assert.strictEqual(stops.length, sm.runStarts.length);
      assert.strictEqual(stops.length, 10);

      stops.forEach((stop, step) => {
        assert.strictEqual(stop.step, step, `stop ${step} has step ${stop.step}`);
        assert.strictEqual(
          stop.traceIndex,
          sm.runStarts[step],
          `stop ${step} traceIndex should equal runStarts[${step}]`,
        );
      });
    });
  });

  describe('no DWARF (rawTrace only, empty runStarts)', () => {
    it('throws rather than silently emitting visibleIndices', async () => {
      const resolved = await new RawTraceBackend().resolve(
        { rawTrace: path.join(FIXTURES, 'adder-debug.trace.jsonl') } as any,
        () => {},
      );
      const sm = buildStopModel(resolved);
      assert.strictEqual(sm.runStarts.length, 0, 'precondition: no source stops without wasm');
      assert.throws(
        () => runCliTrace(resolved, {}),
        /source|dwarf|stop/i,
        'expected runCliTrace to throw when there are no source stops',
      );
    });
  });
});
