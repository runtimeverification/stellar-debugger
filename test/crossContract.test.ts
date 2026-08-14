/**
 * The cross-contract gate, and the derivation it rests on.
 *
 * A traced transaction's records include the ROOT contract plus cross-contract
 * sub-calls (an oracle, a token, ...). The adapter builds its disassembly +
 * DWARF from ONLY the root contract's wasm, so a sub-call's small `pos` values
 * collide with the root's low code offsets and get mis-mapped to bogus source
 * lines. The fix makes foreign records INVISIBLE (validated position -> null) so
 * they are neither shown nor mis-mapped, while leaving traces that carry no call
 * boundaries untouched.
 *
 * Which contract a record executes in is DERIVED from the `callContract` and
 * `endWasm` events the trace already carries — komet-node no longer stamps an
 * `executingContract` field onto each served record — and the derivation lives
 * in LedgerImage's call-frame stack, the same one the Ledger view reads. Two
 * things this file pins:
 *   1. LedgerImage.executingContractAt — the boundary attribution, including
 *      that a `callContract` record belongs to the callee it opens and an
 *      `endWasm` record to the callee it closes.
 *   2. src/debugAdapter/artifacts.ts — validatedPositions gates any record whose
 *      derived contract differs from the root's.
 *
 * `nop` is used throughout: normalizeMnemonic(['nop']) === 'nop' and
 * renderInstr(['nop']) === 'nop', so it round-trips through Disassembly.fromTrace
 * and the existing pos+mnemonic validation passes — leaving the contract gate as
 * the ONLY thing that can null a position in the gate tests.
 */

import * as assert from 'assert';
import { toTraceRecord, TraceRecord } from '../src/komet/trace';
import { validatedPositions } from '../src/debugAdapter/artifacts';
import { LedgerImage } from '../src/debugAdapter/LedgerImage';
import { TraceModel } from '../src/debugAdapter/TraceModel';
import { Disassembly } from '../src/wasm/Disassembly';

/**
 * The executing contract at each record, as the gate reads it off the trace's
 * call boundaries: the innermost open call's callee, or null where none is open.
 */
function executingContracts(records: TraceRecord[]): (string | null)[] {
  const image = new LedgerImage(records);
  return records.map((_, i) => image.executingContractAt(i) ?? null);
}

// Two distinct 32-byte-ish contract ids (root A, foreign B).
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

/** A single-`nop` instruction record at code offset `pos`. */
function nopAt(pos: number | null): TraceRecord {
  return toTraceRecord({ kind: 'instr', pos, instr: ['nop'], stack: [], locals: {} }, 1);
}

/** A `callContract` boundary opening a call into `to`. */
function callInto(to: string, depth = 1): TraceRecord {
  return toTraceRecord(
    {
      kind: 'callContract',
      from: { type: 'address', addrType: 'account', value: 'f'.repeat(64) },
      to: { type: 'address', addrType: 'contract', value: to },
      function: 'f',
      args: [],
      depth,
      storage: [],
    },
    1,
  );
}

/** An `endWasm` boundary closing the innermost open call. */
function endCall(success = true, depth = 1): TraceRecord {
  return toTraceRecord(
    { kind: 'endWasm', success, depth, result: { type: 'void' } },
    1,
  );
}

/** Validated positions of a model against its own trace-derived disassembly. */
function positionsOf(...records: TraceRecord[]): (number | null)[] {
  const model = new TraceModel(records);
  // Disassembly.fromTrace is built from the records' own pos+instr, so every
  // record's pos validates by construction — isolating the contract gate.
  return validatedPositions(model, Disassembly.fromTrace(model));
}

describe('executing contract: derivation from call boundaries', () => {
  it('attributes a callContract record to the callee it opens', () => {
    assert.deepStrictEqual(executingContracts([callInto(A), nopAt(10)]), [A, A]);
  });

  it('attributes an endWasm record to the callee it closes, then returns to the caller', () => {
    const contracts = executingContracts([
      callInto(A),
      callInto(B, 2),
      nopAt(10),
      endCall(true, 2),
      nopAt(20),
    ]);
    assert.deepStrictEqual(contracts, [A, B, B, B, A]);
  });

  it('pops on a trapped endWasm exactly as on a successful one', () => {
    const contracts = executingContracts([
      callInto(A),
      callInto(B, 2),
      endCall(false, 2),
      nopAt(10),
    ]);
    assert.deepStrictEqual(contracts, [A, B, B, A]);
  });

  it('reports null before the first call and for a trace with no boundaries', () => {
    assert.deepStrictEqual(executingContracts([nopAt(10), nopAt(20)]), [null, null]);
    assert.deepStrictEqual(executingContracts([nopAt(10), callInto(A)]), [null, A]);
  });

  it('leaves a root call that never closes open to the end of the trace', () => {
    assert.deepStrictEqual(executingContracts([callInto(A), nopAt(10), nopAt(20)]), [A, A, A]);
  });

  it('tolerates an unmatched endWasm rather than underflowing', () => {
    assert.deepStrictEqual(executingContracts([endCall(), nopAt(10)]), [null, null]);
  });

  it('keeps sibling root-level calls separate', () => {
    const contracts = executingContracts([callInto(A), endCall(), callInto(B), endCall()]);
    assert.deepStrictEqual(contracts, [A, A, B, B]);
  });
});

describe('artifacts: validatedPositions cross-contract gate', () => {
  it('nulls a foreign sub-call record even though its pos validates', () => {
    // root = A; the B record shares the first A record's pos (the collision the
    // bug mis-maps). Only the gate can null it — its pos+mnemonic validate.
    const positions = positionsOf(
      callInto(A),
      nopAt(10),
      nopAt(20),
      callInto(B, 2),
      nopAt(10),
      endCall(true, 2),
      nopAt(30),
    );
    assert.deepStrictEqual(positions, [null, 10, 20, null, null, null, 30]);
  });

  it('is inert on a trace with no call boundaries', () => {
    // The same positions in a trace carrying no events: nothing is filtered.
    const positions = positionsOf(nopAt(10), nopAt(20), nopAt(10), nopAt(30));
    assert.deepStrictEqual(positions, [10, 20, 10, 30]);
  });

  it('spares records ahead of the first call, which have no contract yet', () => {
    // The leading record precedes any callContract, so it is never filtered;
    // the call establishes root = A and the foreign B record is nulled.
    const positions = positionsOf(
      nopAt(10),
      callInto(A),
      nopAt(20),
      callInto(B, 2),
      nopAt(10),
      endCall(true, 2),
      nopAt(30),
    );
    assert.deepStrictEqual(positions, [10, null, 20, null, null, null, 30]);
  });

  it('nulls every foreign record across a nested A -> B -> A return', () => {
    const positions = positionsOf(
      callInto(A),
      nopAt(10),
      nopAt(20),
      callInto(B, 2),
      nopAt(30),
      nopAt(40),
      endCall(true, 2),
      nopAt(50),
    );
    assert.deepStrictEqual(positions, [null, 10, 20, null, null, null, null, 50]);
  });

  it('passes a single-contract trace through unchanged', () => {
    const positions = positionsOf(callInto(A), nopAt(10), nopAt(20), nopAt(30));
    assert.deepStrictEqual(positions, [null, 10, 20, 30]);
  });
});
