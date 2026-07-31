/**
 * Red anchor for the M3 cross-contract gate (minimal).
 *
 * komet now stamps every trace record with `executingContract` — the contract
 * whose code is executing. A traced transaction's records include the ROOT
 * contract plus cross-contract sub-calls (an oracle, a token, ...). The adapter
 * builds its disassembly + DWARF from ONLY the root contract's wasm, so a
 * sub-call's small `pos` values collide with the root's low code offsets and get
 * mis-mapped to bogus source lines. The minimal fix makes foreign records
 * INVISIBLE (validated position -> null) so they are neither shown nor
 * mis-mapped, while staying backward-compatible with traces that carry no tag.
 *
 * Two pieces of not-yet-existing behaviour this file pins:
 *   1. src/komet/trace.ts — TraceRecord gains `executingContract?: string|null`;
 *      toTraceRecord/parseTraceJsonl parse the field (string/null kept, absent ->
 *      undefined, anything else -> TraceParseError).
 *   2. src/debugAdapter/artifacts.ts — validatedPositions(model, disassembly)
 *      gains a cross-contract gate: with a derived root (the first non-empty
 *      string tag), any record tagged with a DIFFERENT contract validates to
 *      null regardless of pos/mnemonic; untagged/null-tagged records are never
 *      filtered.
 *
 * `nop` is used throughout: normalizeMnemonic(['nop']) === 'nop' and
 * renderInstr(['nop']) === 'nop', so it round-trips through Disassembly.fromTrace
 * and the existing pos+mnemonic validation passes — leaving the contract gate as
 * the ONLY thing that can null a position in the gate tests.
 */

import * as assert from 'assert';
import { toTraceRecord, parseTraceJsonl, TraceParseError, TraceRecord } from '../src/komet/trace';
import { validatedPositions } from '../src/debugAdapter/artifacts';
import { TraceModel } from '../src/debugAdapter/TraceModel';
import { Disassembly } from '../src/wasm/Disassembly';

// Two distinct 32-byte-ish contract ids (root A, foreign B).
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

/** The executingContract tag of a record. */
function tagOf(rec: TraceRecord): string | null | undefined {
  return rec.executingContract;
}

// Sentinel distinguishing "no executingContract key" from an explicit null tag.
const ABSENT = Symbol('absent');

/**
 * A single-`nop` record at code offset `pos`, optionally tagged with an
 * executingContract. Built as a plain object (partial record) and cast.
 */
function nopAt(pos: number | null, contract: string | null | typeof ABSENT = ABSENT): TraceRecord {
  const base: Record<string, unknown> = { pos, instr: ['nop'], stack: [], locals: {} };
  if (contract !== ABSENT) {
    base.executingContract = contract;
  }
  return base as unknown as TraceRecord;
}

/** Validated positions of a model against its own trace-derived disassembly. */
function positionsOf(...records: TraceRecord[]): (number | null)[] {
  const model = new TraceModel(records);
  // Disassembly.fromTrace is built from the records' own pos+instr, so every
  // record's pos validates by construction — isolating the contract gate.
  return validatedPositions(model, Disassembly.fromTrace(model));
}

describe('trace: executingContract parsing', () => {
  const rec = (extra: Record<string, unknown>): unknown => ({
    pos: 10,
    instr: ['nop'],
    stack: [],
    locals: {},
    ...extra,
  });

  it('keeps a string executingContract', () => {
    assert.strictEqual(tagOf(toTraceRecord(rec({ executingContract: A }), 1)), A);
  });

  it('keeps a null executingContract as null', () => {
    assert.strictEqual(tagOf(toTraceRecord(rec({ executingContract: null }), 1)), null);
  });

  it('leaves an absent executingContract undefined', () => {
    assert.strictEqual(tagOf(toTraceRecord(rec({}), 1)), undefined);
  });

  it('throws TraceParseError when executingContract is a number', () => {
    assert.throws(() => toTraceRecord(rec({ executingContract: 123 }), 1), TraceParseError);
  });

  it('parseTraceJsonl carries executingContract through', () => {
    const [parsed] = parseTraceJsonl(JSON.stringify(rec({ executingContract: A })));
    assert.strictEqual(tagOf(parsed), A);
  });
});

describe('artifacts: validatedPositions cross-contract gate', () => {
  it('nulls a foreign sub-call record even though its pos validates', () => {
    // root = A; r2 is a foreign B record sharing r0's pos (the collision the
    // bug mis-maps). Only the gate can null it — its pos+mnemonic validate.
    const positions = positionsOf(
      nopAt(10, A),
      nopAt(20, A),
      nopAt(10, B),
      nopAt(30, A),
    );
    assert.deepStrictEqual(positions, [10, 20, null, 30]);
  });

  it('backward-compat: without executingContract the gate is inert', () => {
    // The SAME four positions, untagged: nothing is filtered.
    const positions = positionsOf(nopAt(10), nopAt(20), nopAt(10), nopAt(30));
    assert.deepStrictEqual(positions, [10, 20, 10, 30]);
  });

  it('derives the root from the first NON-null tag, sparing earlier null-tagged records', () => {
    // r0 is tagged null (no root established yet) so it is never filtered; r1
    // establishes root = A; the foreign r2 is nulled.
    const positions = positionsOf(
      nopAt(10, null),
      nopAt(20, A),
      nopAt(10, B),
      nopAt(30, A),
    );
    assert.deepStrictEqual(positions, [10, 20, null, 30]);
  });

  it('nulls every foreign record across a nested A -> B -> A return', () => {
    // A, A, B, B, A: the two B records are nulled, the three A records kept.
    const positions = positionsOf(
      nopAt(10, A),
      nopAt(20, A),
      nopAt(30, B),
      nopAt(40, B),
      nopAt(50, A),
    );
    assert.deepStrictEqual(positions, [10, 20, null, null, 50]);
  });

  it('passes a single-contract trace (every record tagged root) through unchanged', () => {
    // Every record is the root A: nothing is foreign, so validation is unchanged.
    const positions = positionsOf(nopAt(10, A), nopAt(20, A), nopAt(30, A));
    assert.deepStrictEqual(positions, [10, 20, 30]);
  });

  it("treats an empty-string tag as 'no contract' — never gated, symmetric with the root search", () => {
    // root = A (first NON-empty tag). r1's '' is not a contract id, so it is
    // spared (kept), exactly as the root search skips ''. The B record is gated.
    const positions = positionsOf(nopAt(10, A), nopAt(20, ''), nopAt(30, B), nopAt(40, A));
    assert.deepStrictEqual(positions, [10, 20, null, 40]);
  });

  it('establishes the root from the first non-empty tag even several records in', () => {
    // r0 null, r1 absent, r2 establishes root A; the later B record is gated.
    const positions = positionsOf(
      nopAt(10, null),
      nopAt(20),
      nopAt(30, A),
      nopAt(10, B),
      nopAt(40, A),
    );
    assert.deepStrictEqual(positions, [10, 20, 30, null, 40]);
  });
});
