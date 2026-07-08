/**
 * Characterization suite for per-construct SOURCE stepping, at the pure model
 * level (mirrors test/stepping.test.ts). One opt-0 wasm — control-debug.wasm,
 * built from examples/control/src/lib.rs — is shared by five traces, each
 * isolating one Rust control-flow construct (sequence, if/else, `for`,
 * `while`+call, `match`). These tests LOCK the statement-stop ground truth
 * documented in docs/stepping.md ("Fixtures") so a regression in the stops.ts
 * engine (computeDepths / computeRunStarts) is caught here at the lowest level
 * that exhibits it. They are expected to PASS against the current engine.
 *
 * Every function lives in `impl Control`: the #[contractimpl] export shim maps
 * to lib.rs:20 (entered at depth 0 then 1), the function body runs at depth 2,
 * and a called `bump` runs at depth 3.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { computeDepths, computeRunStarts } from '../src/debugAdapter/stops';
import { Disassembly } from '../src/wasm/Disassembly';
import { TraceModel } from '../src/debugAdapter/TraceModel';
import { buildDebugArtifacts } from '../src/debugAdapter/artifacts';
import { SourceMapper } from '../src/sourcemap/SourceMapper';
import { parseTraceJsonl } from '../src/komet/trace';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');

interface Fixture {
  model: TraceModel;
  source: SourceMapper;
  disassembly: Disassembly;
  positions: (number | null)[];
}

const fixtureCache = new Map<string, Fixture>();

/**
 * Load a committed wasm+trace fixture pair and build the debug artifacts. The
 * control fixtures do NOT follow the 1:1 <name>.wasm/<name>.trace.jsonl naming
 * (one control-debug.wasm feeds five control-<fn>.trace.jsonl), so this takes
 * the wasm base name and the trace base name independently.
 */
function fixturePair(wasmName: string, traceName: string): Fixture {
  const key = `${wasmName}::${traceName}`;
  let f = fixtureCache.get(key);
  if (!f) {
    const jsonl = fs.readFileSync(path.join(FIXTURES, `${traceName}.trace.jsonl`), 'utf8');
    const wasm = fs.readFileSync(path.join(FIXTURES, `${wasmName}.wasm`));
    const model = new TraceModel(parseTraceJsonl(jsonl));
    const { source, disassembly, positions } = buildDebugArtifacts(wasm, model, () => {});
    f = { model, source, disassembly, positions };
    fixtureCache.set(key, f);
  }
  return f;
}

function control(fn: string): Fixture {
  return fixturePair('control-debug', `control-${fn}`);
}

/** The statement-granularity stop points as "<index>=<line>@<depth>" tokens. */
function runStops(f: Fixture): { index: number; line: number | undefined; depth: number }[] {
  const depths = computeDepths(f.model.records, f.positions, f.disassembly.functionRanges);
  const starts = computeRunStarts(f.positions, depths, (i) => f.source.lineKeyForIndex(i));
  return starts.map((i) => ({ index: i, line: f.source.locationForIndex(i)?.line, depth: depths[i] }));
}

/** Just the source lines of the statement stops, in stop order. */
function stopLines(f: Fixture): (number | undefined)[] {
  return runStops(f).map((s) => s.line);
}

describe('control fixtures — per-construct source stepping (docs/stepping.md Fixtures)', () => {
  describe('seq — straight-line sequence (S4/S5 basics)', () => {
    it('pins the exact statement stops: shim, three assignments, return', () => {
      // Ground truth (index=line@depth): 6=20@0 21=20@1 219=23@2 236=24@2
      // 249=25@2 262=26@2 265=28@2.
      assert.deepStrictEqual(runStops(control('seq')), [
        { index: 6, line: 20, depth: 0 },
        { index: 21, line: 20, depth: 1 },
        { index: 219, line: 23, depth: 2 },
        { index: 236, line: 24, depth: 2 },
        { index: 249, line: 25, depth: 2 },
        { index: 262, line: 26, depth: 2 },
        { index: 265, line: 28, depth: 2 },
      ]);
    });

    it('S5: body statement lines strictly increase, one stop per statement', () => {
      // The body (depth 2) is a pure sequence: 23,24,25,26 (let a/b/c) then 28
      // (return) — no line repeats, none is skipped, each stops exactly once.
      const body = runStops(control('seq')).filter((s) => s.depth === 2).map((s) => s.line);
      assert.deepStrictEqual(body, [23, 24, 25, 26, 28]);
      for (let i = 1; i < body.length; i++) {
        assert.ok((body[i] as number) > (body[i - 1] as number), `line ${body[i]} did not increase past ${body[i - 1]}`);
      }
    });
  });

  describe('branch — if/else, only the taken (else) arm is a stop', () => {
    it('pins the exact statement stops through the else arm', () => {
      // 3 <= 10, so the ELSE arm (:36) runs; the THEN arm (:34) never executes.
      // 219=31@2 226=33@2 244=36@2 245=33@2 246=38@2 248=39@2.
      assert.deepStrictEqual(runStops(control('branch')), [
        { index: 6, line: 20, depth: 0 },
        { index: 21, line: 20, depth: 1 },
        { index: 219, line: 31, depth: 2 },
        { index: 226, line: 33, depth: 2 },
        { index: 244, line: 36, depth: 2 },
        { index: 245, line: 33, depth: 2 },
        { index: 246, line: 38, depth: 2 },
        { index: 248, line: 39, depth: 2 },
      ]);
    });

    it('S4/S5: the else arm (:36) is a stop and the then arm (:34) NEVER appears', () => {
      const lines = stopLines(control('branch'));
      assert.ok(lines.includes(36), 'expected the taken else arm (:36) to be a stop');
      assert.ok(!lines.includes(34), 'the un-taken then arm (:34) must never be a stop');
    });
  });

  describe('count — `for` loop, body stops once per iteration (S6/S12)', () => {
    it('pins the exact statement stops across all iterations', () => {
      // 219=42 (fn sig) 228=43 (let acc), then :44 (`for` header) / :45 (body
      // `acc += i`) alternate per iteration, then 805=47 (acc) 808=48.
      assert.deepStrictEqual(runStops(control('count')), [
        { index: 6, line: 20, depth: 0 },
        { index: 21, line: 20, depth: 1 },
        { index: 219, line: 42, depth: 2 },
        { index: 228, line: 43, depth: 2 },
        { index: 233, line: 44, depth: 2 },
        { index: 400, line: 45, depth: 2 },
        { index: 414, line: 44, depth: 2 },
        { index: 547, line: 45, depth: 2 },
        { index: 561, line: 44, depth: 2 },
        { index: 694, line: 45, depth: 2 },
        { index: 708, line: 44, depth: 2 },
        { index: 805, line: 47, depth: 2 },
        { index: 808, line: 48, depth: 2 },
      ]);
    });

    it('S6/S12: the loop body (:45) is a fresh run once per iteration', () => {
      // n=3: the body `acc = acc.wrapping_add(i)` (:45) runs exactly three times,
      // one stop per iteration — the defining loop-stepping guarantee. The `for`
      // header (:44) stops four times (three iterations plus the terminating
      // `next() -> None` check), so a >= check on :44 would not prove per-iteration
      // body stops; assert the body line's exact count instead.
      const lines = stopLines(control('count'));
      assert.strictEqual(lines.filter((l) => l === 45).length, 3, 'body :45 must stop once per iteration');
      assert.strictEqual(lines.filter((l) => l === 44).length, 4, '`for` header :44 stops per iteration + final check');
    });
  });

  describe('while_call — `while` with a real `bump` call (S4/S5/S6/S7/S8)', () => {
    it('pins the exact statement stops, including bump body at depth 3', () => {
      assert.deepStrictEqual(runStops(control('while_call')), [
        { index: 6, line: 20, depth: 0 },
        { index: 21, line: 20, depth: 1 },
        { index: 219, line: 52, depth: 2 },
        { index: 228, line: 53, depth: 2 },
        { index: 231, line: 54, depth: 2 },
        { index: 234, line: 55, depth: 2 },
        { index: 243, line: 56, depth: 2 },
        { index: 249, line: 15, depth: 3 },
        { index: 266, line: 16, depth: 3 },
        { index: 278, line: 18, depth: 3 },
        { index: 291, line: 57, depth: 2 },
        { index: 305, line: 55, depth: 2 },
        { index: 314, line: 56, depth: 2 },
        { index: 320, line: 15, depth: 3 },
        { index: 337, line: 16, depth: 3 },
        { index: 349, line: 18, depth: 3 },
        { index: 362, line: 57, depth: 2 },
        { index: 376, line: 55, depth: 2 },
        { index: 385, line: 56, depth: 2 },
        { index: 391, line: 15, depth: 3 },
        { index: 408, line: 16, depth: 3 },
        { index: 420, line: 18, depth: 3 },
        { index: 433, line: 57, depth: 2 },
        { index: 447, line: 55, depth: 2 },
        { index: 456, line: 59, depth: 2 },
        { index: 459, line: 60, depth: 2 },
      ]);
    });

    it('S4/S7: bump body (:15/:16/:18) is EXACTLY one depth deeper than the loop', () => {
      // The call line :56 and the increment :57 sit at depth 2 (the function
      // body); every bump-body line runs at depth 3 — one frame deeper.
      const stops = runStops(control('while_call'));
      const loopDepth = stops.find((s) => s.line === 56)?.depth;
      assert.strictEqual(loopDepth, 2, 'expected the call line :56 at depth 2');
      for (const s of stops) {
        if (s.line === 15 || s.line === 16 || s.line === 18) {
          assert.strictEqual(s.depth, (loopDepth as number) + 1, `bump line :${s.line} not one frame deeper`);
        }
      }
    });

    it('S5/S8: bump body appears once per iteration and depth returns to the caller (implicit return)', () => {
      // Three iterations -> exactly three descents into bump's entry line :15;
      // the trace has NO return record, yet each descent is followed by a
      // return to depth 2 (:57). The last stop is back at depth 2 (:60), proving
      // every frame was popped despite the missing returns (defect I1 / S5/S7/S8).
      const stops = runStops(control('while_call'));
      const bumpEntries = stops.filter((s) => s.line === 15);
      assert.strictEqual(bumpEntries.length, 3, 'expected one bump entry (:15) per loop iteration');
      for (const e of bumpEntries) {
        assert.strictEqual(e.depth, 3, 'bump entry must be at depth 3');
      }
      assert.strictEqual(stops[stops.length - 1].depth, 2, 'trace must unwind back to the function body depth');
    });
  });

  describe('choose — `match`, only the taken arm is a stop', () => {
    it('pins the exact statement stops through the taken arm (:66)', () => {
      // 7 % 3 == 1, so arm `1 => 200` (:66) runs.
      // 219=63 228=64 240=66 243=69 245=70.
      assert.deepStrictEqual(runStops(control('choose')), [
        { index: 6, line: 20, depth: 0 },
        { index: 21, line: 20, depth: 1 },
        { index: 219, line: 63, depth: 2 },
        { index: 228, line: 64, depth: 2 },
        { index: 240, line: 66, depth: 2 },
        { index: 243, line: 69, depth: 2 },
        { index: 245, line: 70, depth: 2 },
      ]);
    });

    it('S4/S5: only the taken arm (:66) stops; arms :65 and :67 NEVER appear', () => {
      const lines = stopLines(control('choose'));
      assert.ok(lines.includes(66), 'expected the taken match arm (:66) to be a stop');
      assert.ok(!lines.includes(65), 'the un-taken arm 0=> (:65) must never be a stop');
      assert.ok(!lines.includes(67), 'the un-taken arm _=> (:67) must never be a stop');
    });
  });
});
