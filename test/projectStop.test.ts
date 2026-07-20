/**
 * Unit suite for the serializable single-stop projection
 * (docs/trace-cli-internal.md, "projectSourceStop"). The module under test does not
 * exist yet — this is the red anchor for it.
 *
 *   projectSourceStop(resolved, stopModel, index, opts): SourceStop
 *     from src/trace/projectStop.ts
 *
 * It reuses only the low-level resolver calls (locationForIndex, pcAtIndex,
 * functionNameAt, makeRuntimeState + variablesInScope + decodeVariable) and,
 * unlike the DAP handlers, expands DecodedValue.children EAGERLY into plain
 * arrays bounded by a per-stop depth/child budget. Values are pinned to the
 * verified ground-truth fixtures (docs/trace-cli-internal.md ground-truth table).
 */

import * as assert from 'assert';
import * as path from 'path';
import { buildStopModel } from '../src/debugAdapter/stopModel';
import { projectSourceStop } from '../src/trace/projectStop';
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

describe('projectSourceStop (docs/trace-cli-internal.md, serializable stop projection)', () => {
  describe('adder-debug idx 29 (the sole statement stop)', () => {
    let resolved: ResolvedTrace;

    before(async () => {
      resolved = await resolveFixture('adder-debug');
    });

    it('projects the pinned SourceStop shape and values', () => {
      const sm = buildStopModel(resolved);
      const stop = projectSourceStop(resolved, sm, 29);

      // Ordinal among source stops: runStarts = [29] → step 0.
      assert.strictEqual(stop.step, 0);
      assert.strictEqual(stop.traceIndex, 29);
      assert.strictEqual(stop.depth, 0);
      // pc hex = "0x" + pos.toString(16); pos 45 → "0x2d".
      assert.strictEqual(stop.pc, '0x2d');
      assert.strictEqual(stop.function, 'invoke_raw_extern');
      assert.ok(
        stop.instr.startsWith('i32.add'),
        `expected instr to start with i32.add, got: ${stop.instr}`,
      );

      assert.ok(stop.source, 'expected a mapped source location');
      assert.strictEqual(stop.source!.line, 16);
      assert.strictEqual(stop.source!.column, 9);
      assert.ok(
        stop.source!.path.endsWith('examples/adder/src/lib.rs'),
        `unexpected source path: ${stop.source!.path}`,
      );
    });

    it('projects the two leaf argument variables with no children', () => {
      const sm = buildStopModel(resolved);
      const stop = projectSourceStop(resolved, sm, 29);

      assert.deepStrictEqual(stop.variables, [
        { name: 'arg_0', type: 'Val', value: '17179869188' },
        { name: 'arg_1', type: 'Val', value: '12884901892' },
      ]);
      // Leaves: neither `children` nor `truncated` keys are emitted.
      for (const v of stop.variables) {
        assert.strictEqual(v.children, undefined);
        assert.strictEqual(v.truncated, undefined);
      }
    });
  });

  describe('stepper-debug idx 29 (function `triple`)', () => {
    let resolved: ResolvedTrace;

    before(async () => {
      resolved = await resolveFixture('stepper-debug');
    });

    it('omits an absent column and pins the `triple`/x=0 values', () => {
      const sm = buildStopModel(resolved);
      const stop = projectSourceStop(resolved, sm, 29);

      // runStarts = [21,27,29,...] → idx 29 is the third source stop (step 2).
      assert.strictEqual(stop.step, 2);
      assert.strictEqual(stop.traceIndex, 29);
      assert.strictEqual(stop.function, 'triple');

      assert.ok(stop.source, 'expected a mapped source location');
      assert.strictEqual(stop.source!.line, 15);
      // The null column MUST be omitted, never emitted as `column: null/undefined`.
      assert.ok(
        !('column' in stop.source!),
        `expected column to be omitted, got: ${JSON.stringify(stop.source)}`,
      );

      const x = stop.variables.find((v) => v.name === 'x');
      assert.ok(x, 'expected a variable named x');
      assert.strictEqual(x!.type, 'u32');
      assert.strictEqual(x!.value, '0');
    });
  });

  describe('increment-debug idx 999 (expandable `env`, unnamed first var)', () => {
    let resolved: ResolvedTrace;

    before(async () => {
      resolved = await resolveFixture('increment-debug');
    });

    it('renders an unnamed variable as <anon> and tolerates a null function', () => {
      const sm = buildStopModel(resolved);
      const stop = projectSourceStop(resolved, sm, 999);

      // runStarts = [646,999,...] → idx 999 is the second source stop (step 1).
      assert.strictEqual(stop.step, 1);
      assert.strictEqual(stop.traceIndex, 999);
      // functionNameAt may return null even with DWARF; the field must reflect it.
      assert.ok(
        stop.function === null || typeof stop.function === 'string',
        `function must be a string or null, got: ${String(stop.function)}`,
      );

      assert.ok(stop.source, 'expected a mapped source location');
      assert.strictEqual(stop.source!.line, 21);

      // The first variable has no DWARF name → it renders as "<anon>".
      assert.strictEqual(stop.variables[0].name, '<anon>');
    });

    it('pins `current:u32=15` and eagerly expands `env` exactly one level', () => {
      const sm = buildStopModel(resolved);
      const stop = projectSourceStop(resolved, sm, 999);

      const current = stop.variables.find((v) => v.name === 'current');
      assert.ok(current, 'expected a variable named current');
      assert.strictEqual(current!.type, 'u32');
      assert.strictEqual(current!.value, '15');

      const env = stop.variables.find((v) => v.name === 'env');
      assert.ok(env, 'expected a variable named env');
      assert.strictEqual(env!.type, 'Env');
      assert.strictEqual(env!.value, 'Env');

      // env IS expandable: exactly one child, env_impl:Guest.
      assert.ok(Array.isArray(env!.children), 'expected env to be expanded eagerly');
      assert.strictEqual(env!.children!.length, 1);
      const child = env!.children![0];
      assert.strictEqual(child.name, 'env_impl');
      assert.strictEqual(child.type, 'Guest');
      assert.strictEqual(child.value, 'Guest');

      // Recursive expansion reaches env_impl by name.
      assert.strictEqual(env!.children![0].name, 'env_impl');

      // env_impl has an EMPTY child set → the `children` key MUST be omitted,
      // never emitted as `children: []`. Not truncated either — genuinely empty.
      assert.strictEqual(child.children, undefined);
      assert.strictEqual(child.truncated, undefined);
    });

    it('honors a depth budget: {maxDepth: 0} cuts env children and marks it truncated', () => {
      const sm = buildStopModel(resolved);
      const stop = projectSourceStop(resolved, sm, 999, { maxDepth: 0 });

      const env = stop.variables.find((v) => v.name === 'env');
      assert.ok(env, 'expected a variable named env');
      // Expandable but cut by the depth budget: no children, truncated marker set.
      assert.strictEqual(env!.children, undefined);
      assert.strictEqual(env!.truncated, true);
    });
  });
});
