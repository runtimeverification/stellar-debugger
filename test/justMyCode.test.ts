/**
 * Unit suite for "just my code" statement stepping (docs/stepping.md rule S21).
 *
 * S21 is a launch option `justMyCode` (default true) that drops
 * statement-granularity stop points whose mapped source file is NON-workspace
 * (Rust toolchain std/core + crates.io dependency sources), so source stepping
 * rests only in the user's own code. A path is workspace unless its normalized
 * form contains any of `/.rustup/`, `/.cargo/`, or `/rustc/`. Instruction
 * granularity, the instruction pointer, and breakpoints are unaffected, and the
 * same non-emptiness safety as S17/S18 applies: if every statement stop is
 * non-workspace, the unfiltered statement stops stand.
 *
 * The pure API under test:
 *   - src/debugAdapter/stops.ts: isWorkspaceSource, myCodeStops
 *   - src/debugAdapter/stopModel.ts: buildStopModel's optional { justMyCode } opt
 */

import * as assert from 'assert';
import { isWorkspaceSource, myCodeStops } from '../src/debugAdapter/stops';
import { buildStopModel } from '../src/debugAdapter/stopModel';
import { TraceModel } from '../src/debugAdapter/TraceModel';
import { Disassembly } from '../src/wasm/Disassembly';
import { ResolvedTrace } from '../src/debugAdapter/types';
import {
  SourceMapper,
  MappedLocation,
  ResolvedBreakpoint,
} from '../src/sourcemap/SourceMapper';
import { TraceRecord } from '../src/komet/trace';

// ---------------------------------------------------------------------------
// Ground-truth paths (docs/stepping.md S21).
// ---------------------------------------------------------------------------

/** WORKSPACE — a user contract crate. */
const WS_LIB = '/home/dev/work/lending-pool/contracts/price-aggregator/src/lib.rs';
/** WORKSPACE — a shared common module in the same tree. */
const WS_ORACLE = '/home/dev/work/lending-pool/common/src/types/oracle.rs';
/** WORKSPACE — a bare relative path (no toolchain marker). */
const WS_BARE = 'src/lib.rs';

/** NON-WORKSPACE — rustup toolchain std/core source. */
const FOREIGN_RUSTUP =
  '/home/dev/.rustup/toolchains/1.95-x86_64-unknown-linux-gnu/lib/rustlib/src/rust/library/core/src/result.rs';
/** NON-WORKSPACE — a crates.io dependency under the cargo registry. */
const FOREIGN_CARGO =
  '/home/dev/.cargo/registry/src/index.crates.io-6f17d22bba15001f/soroban-sdk-22.0.0/src/lib.rs';
/** NON-WORKSPACE — a rustc-embedded std source path. */
const FOREIGN_RUSTC =
  '/rustc/25ef9e3d85d934b27d9dada2f9dd52b1dc63bb04/library/std/src/panic.rs';

describe('isWorkspaceSource (docs/stepping.md S21)', () => {
  it('treats a null path (unknown) as my-code, never over-filtered', () => {
    assert.strictEqual(isWorkspaceSource(null), true);
  });

  it('returns true for every workspace path', () => {
    for (const p of [WS_LIB, WS_ORACLE, WS_BARE]) {
      assert.strictEqual(isWorkspaceSource(p), true, `expected workspace for ${p}`);
    }
  });

  it('returns false for /.rustup/, /.cargo/, and /rustc/ paths', () => {
    for (const p of [FOREIGN_RUSTUP, FOREIGN_CARGO, FOREIGN_RUSTC]) {
      assert.strictEqual(isWorkspaceSource(p), false, `expected non-workspace for ${p}`);
    }
  });
});

describe('myCodeStops (docs/stepping.md S21)', () => {
  it('drops foreign run starts and keeps workspace ones (a null path counts as my-code)', () => {
    const pathByIndex: Record<number, string | null> = {
      0: WS_LIB,
      1: FOREIGN_RUSTUP,
      2: WS_ORACLE,
      3: FOREIGN_CARGO,
      4: null, // unknown -> treated as my-code, kept
      5: FOREIGN_RUSTC,
    };
    const runStarts = [0, 1, 2, 3, 4, 5];
    assert.deepStrictEqual(
      myCodeStops(runStarts, (i: number) => pathByIndex[i] ?? null),
      [0, 2, 4],
    );
  });

  it('preserves the original order of the surviving run starts', () => {
    const pathByIndex: Record<number, string | null> = {
      10: WS_LIB,
      20: FOREIGN_RUSTUP,
      30: WS_ORACLE,
      40: WS_BARE,
    };
    assert.deepStrictEqual(
      myCodeStops([10, 20, 30, 40], (i: number) => pathByIndex[i] ?? null),
      [10, 30, 40],
    );
  });

  it('never empties a non-empty input: all-foreign returns a copy of the run starts', () => {
    const pathByIndex: Record<number, string> = {
      0: FOREIGN_RUSTUP,
      1: FOREIGN_CARGO,
      2: FOREIGN_RUSTC,
    };
    const runStarts = [0, 1, 2];
    const result = myCodeStops(runStarts, (i: number) => pathByIndex[i]);
    assert.deepStrictEqual(result, [0, 1, 2]);
    assert.notStrictEqual(result, runStarts, 'must be a copy, not the same array reference');
  });

  it('returns an empty array unchanged (empty input -> empty output)', () => {
    assert.deepStrictEqual(myCodeStops([], () => null), []);
  });
});

// ---------------------------------------------------------------------------
// buildStopModel integration with the justMyCode option.
// ---------------------------------------------------------------------------

/** Per-index synthetic source facts driving the stub SourceMapper. */
interface IndexInfo {
  path: string | null;
  line: number;
  /** Raw source text — a plain statement so S17/S18 keep every run start. */
  text: string;
}

/**
 * Minimal SourceMapper double: each trace index maps to a controllable path,
 * line, and source text. Line keys are `<path>:<line>` (distinct here so every
 * visible record is its own line run) and every text is a statement, so the
 * only stop-set shaping under test is S21's my-code filter.
 */
class StubSourceMapper implements SourceMapper {
  constructor(private readonly infos: readonly IndexInfo[]) {}

  hasLineInfo(): boolean {
    return true;
  }

  locationForIndex(index: number): MappedLocation | null {
    const info = this.infos[index];
    if (!info || info.path === null) {
      return null;
    }
    return { path: info.path, line: info.line };
  }

  locationForAddress(): MappedLocation | null {
    return null;
  }

  locationForFile(): MappedLocation | null {
    return null;
  }

  resolveBreakpoint(): ResolvedBreakpoint | null {
    return null;
  }

  executedLines(): number[] {
    return [];
  }

  lineKeyForIndex(index: number): string | null {
    const info = this.infos[index];
    if (!info || info.path === null) {
      return null;
    }
    return `${info.path}:${info.line}`;
  }

  sourceTextForIndex(index: number): string | null {
    const info = this.infos[index];
    return info ? info.text : null;
  }

  sourceTextAt(): string | null {
    return null;
  }
}

/** A `nop` record: no call/return opcode, so computeDepths yields depth 0. */
function nopRecord(pos: number): TraceRecord {
  return { pos, instr: ['nop'], stack: [], locals: {} };
}

/**
 * A ResolvedTrace over synthetic records: identity positions (every record
 * visible), a trace-derived Disassembly with EMPTY functionRanges (all-zero
 * depths), and a StubSourceMapper from `infos`.
 */
function makeResolved(infos: readonly IndexInfo[]): ResolvedTrace {
  const records = infos.map((_, i) => nopRecord(i));
  const model = new TraceModel(records);
  const disassembly = Disassembly.fromTrace(model);
  const positions: (number | null)[] = infos.map((_, i) => i);
  const source = new StubSourceMapper(infos);
  return {
    model,
    source,
    disassembly,
    positions,
    // buildStopModel never touches `variables`; a stub keeps the shape valid.
    variables: {} as any,
  };
}

const statement = (path: string | null, line: number): IndexInfo => ({
  path,
  line,
  text: 'let x = 1;',
});

describe('buildStopModel + justMyCode (docs/stepping.md S21)', () => {
  // Six statement run starts at depth 0, alternating workspace / .rustup:
  // indices 0,2,4 are my-code; 1,3,5 are foreign toolchain source.
  const mixed: IndexInfo[] = [
    statement(WS_LIB, 10), // 0  workspace
    statement(FOREIGN_RUSTUP, 20), // 1  foreign
    statement(WS_ORACLE, 30), // 2  workspace
    statement(FOREIGN_RUSTUP, 40), // 3  foreign
    statement(WS_LIB, 50), // 4  workspace
    statement(FOREIGN_RUSTUP, 60), // 5  foreign
  ];

  it('pre-S21 (justMyCode:false) keeps every statement stop, foreign included', () => {
    const model = buildStopModel(makeResolved(mixed), { justMyCode: false });
    assert.deepStrictEqual(model.rawRunStarts, [0, 1, 2, 3, 4, 5]);
    assert.deepStrictEqual(model.runStarts, [0, 1, 2, 3, 4, 5]);
    assert.strictEqual(model.firstStopPoint, 0);
    assert.strictEqual(model.lastStopPoint, 5);
  });

  it('default opts drop foreign run starts and recompute first/last stop points', () => {
    const model = buildStopModel(makeResolved(mixed));
    assert.deepStrictEqual(model.runStarts, [0, 2, 4]);
    assert.strictEqual(model.firstStopPoint, 0);
    assert.strictEqual(model.lastStopPoint, 4);
  });

  it('explicit justMyCode:true matches the default (foreign stops absent)', () => {
    const model = buildStopModel(makeResolved(mixed), { justMyCode: true });
    assert.deepStrictEqual(model.runStarts, [0, 2, 4]);
    assert.strictEqual(model.firstStopPoint, 0);
    assert.strictEqual(model.lastStopPoint, 4);
  });

  it('leaves instruction granularity (visibleIndices) identical regardless of justMyCode', () => {
    const on = buildStopModel(makeResolved(mixed), { justMyCode: true });
    const off = buildStopModel(makeResolved(mixed), { justMyCode: false });
    const expected = [0, 1, 2, 3, 4, 5];
    assert.deepStrictEqual(on.visibleIndices, expected);
    assert.deepStrictEqual(off.visibleIndices, expected);
    assert.deepStrictEqual(on.visibleIndices, off.visibleIndices);
  });

  it('non-empty safety: an all-foreign trace keeps its unfiltered statement stops', () => {
    const allForeign: IndexInfo[] = [
      statement(FOREIGN_RUSTUP, 10),
      statement(FOREIGN_CARGO, 20),
      statement(FOREIGN_RUSTC, 30),
    ];
    const unfiltered = buildStopModel(makeResolved(allForeign), { justMyCode: false }).runStarts;
    const filtered = buildStopModel(makeResolved(allForeign), { justMyCode: true }).runStarts;
    assert.deepStrictEqual(unfiltered, [0, 1, 2]);
    assert.deepStrictEqual(filtered, unfiltered);
  });

  // S21 must be the FINAL filter, applied AFTER the S17/S18 declaration/brace
  // filtering — not instead of it. This mixes both: a workspace signature (S17
  // drop), a workspace non-final brace (S18 drop), a FOREIGN statement (S21
  // drop), and two surviving workspace statements.
  it('composes after S17/S18: declaration/brace dropped by S17/S18, foreign by S21', () => {
    const roles: IndexInfo[] = [
      { path: WS_LIB, line: 10, text: 'let a = 1;' }, // 0 statement, workspace -> kept
      { path: WS_LIB, line: 11, text: 'fn foo() {' }, // 1 signature  -> S17 drop
      { path: FOREIGN_RUSTUP, line: 12, text: 'let b = 2;' }, // 2 statement, foreign -> S21 drop
      { path: WS_LIB, line: 13, text: '}' }, // 3 non-final brace -> S18 drop
      { path: WS_LIB, line: 14, text: 'let c = 3;' }, // 4 statement, workspace -> kept
    ];
    // Without S21: S17/S18 leave the three workspace/foreign statements.
    assert.deepStrictEqual(
      buildStopModel(makeResolved(roles), { justMyCode: false }).runStarts,
      [0, 2, 4],
    );
    // With S21 (default): the foreign statement (idx 2) is additionally dropped.
    assert.deepStrictEqual(buildStopModel(makeResolved(roles)).runStarts, [0, 4]);
  });

  // Regression pin for the reviewer's "breakpoints & instruction stepping are
  // unaffected" guarantee: breakpoints narrow against rawRunStarts and
  // instruction stepping uses visibleIndices/depths, none of which S21 touches.
  it('leaves rawRunStarts, visibleIndices, and depths identical regardless of justMyCode', () => {
    const on = buildStopModel(makeResolved(mixed), { justMyCode: true });
    const off = buildStopModel(makeResolved(mixed), { justMyCode: false });
    assert.deepStrictEqual(on.rawRunStarts, off.rawRunStarts);
    assert.deepStrictEqual(on.visibleIndices, off.visibleIndices);
    assert.deepStrictEqual(on.depths, off.depths);
    // Only the statement stop set differs.
    assert.notDeepStrictEqual(on.runStarts, off.runStarts);
  });
});
