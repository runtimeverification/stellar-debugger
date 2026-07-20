/**
 * Unit suite for the shared headless stop model (docs/trace-cli-internal.md, "Shared
 * headless core"). Two pure, vscode-free functions in
 * src/debugAdapter/stopModel.ts are the single source of truth the CLI and the
 * DAP session both build on, so they can never disagree about where a "stop" is:
 *
 *   buildStopModel(resolved): StopModel — derives, exactly as
 *     SorobanDebugSession.launchRequest did inline, the validatedPosToIndices
 *     map, visibleIndices, per-record depths, the raw line-run starts, the
 *     statement-granularity runStarts (post S17/S18), and the first/last stop
 *     points.
 *   pcAtIndex(positions, index) — the current-PC rule: the validated code
 *     offset at `index`, or the nearest EARLIER record that has one, else null.
 *
 * Values are pinned to the verified ground-truth fixtures. The module does not
 * exist yet, so this is the red anchor for it.
 */

import * as assert from 'assert';
import * as path from 'path';
import { buildStopModel, pcAtIndex } from '../src/debugAdapter/stopModel';
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

describe('buildStopModel (docs/trace-cli-internal.md, shared headless core)', () => {
  describe('adder-debug fixture', () => {
    let resolved: ResolvedTrace;

    before(async () => {
      resolved = await resolveFixture('adder-debug');
    });

    it('derives the pinned ground-truth stop model', () => {
      const model = buildStopModel(resolved);
      assert.deepStrictEqual(model.rawRunStarts, [6, 29, 40]);
      assert.deepStrictEqual(model.runStarts, [29]);
      assert.strictEqual(model.visibleIndices.length, 35);
      assert.strictEqual(model.firstStopPoint, 29);
      assert.strictEqual(model.lastStopPoint, 29);
      assert.strictEqual(model.depths.length, 41);
    });

    it('maps the validated code offset 45 to trace index 29', () => {
      const model = buildStopModel(resolved);
      assert.ok(model.validatedPosToIndices instanceof Map, 'validatedPosToIndices should be a Map');
      assert.ok(
        model.validatedPosToIndices.get(45)?.includes(29),
        'validatedPosToIndices.get(45) should include index 29',
      );
    });
  });

  describe('stepper-debug fixture', () => {
    let resolved: ResolvedTrace;

    before(async () => {
      resolved = await resolveFixture('stepper-debug');
    });

    it('derives the pinned ground-truth stop model', () => {
      const model = buildStopModel(resolved);
      assert.deepStrictEqual(
        model.rawRunStarts,
        [5, 21, 27, 29, 39, 44, 46, 56, 61, 63, 73, 84],
      );
      assert.deepStrictEqual(model.runStarts, [21, 27, 29, 39, 44, 46, 56, 61, 63, 73]);
      assert.strictEqual(model.visibleIndices.length, 80);
      assert.strictEqual(model.firstStopPoint, 21);
      assert.strictEqual(model.lastStopPoint, 73);
      assert.strictEqual(model.depths.length, 85);
    });
  });
});

describe('pcAtIndex (docs/trace-cli-internal.md, current-PC rule)', () => {
  it('returns the validated code offset at the index (adder idx 29 → 45)', async () => {
    const resolved = await resolveFixture('adder-debug');
    assert.strictEqual(pcAtIndex(resolved.positions, 29), 45);
  });

  it('returns null before the first validated record (adder head)', async () => {
    const resolved = await resolveFixture('adder-debug');
    // The adder's first validated position is at index 6; indices 0..5 are
    // unvalidated global-initializer records with no earlier PC.
    assert.strictEqual(pcAtIndex(resolved.positions, 0), null);
    assert.strictEqual(pcAtIndex(resolved.positions, 5), null);
  });

  it('returns the nearest EARLIER validated offset for an unmapped index', () => {
    // Interior unmapped (null) records inherit the last validated PC seen.
    const positions = [null, 10, null, null, 20, null];
    assert.strictEqual(pcAtIndex(positions, 1), 10);
    assert.strictEqual(pcAtIndex(positions, 2), 10);
    assert.strictEqual(pcAtIndex(positions, 3), 10);
    assert.strictEqual(pcAtIndex(positions, 4), 20);
    assert.strictEqual(pcAtIndex(positions, 5), 20);
    // No validated record at or before index 0 → null.
    assert.strictEqual(pcAtIndex(positions, 0), null);
  });
});
