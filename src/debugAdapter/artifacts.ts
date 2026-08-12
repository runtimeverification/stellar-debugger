/**
 * Builds the per-session debug artifacts — a SourceMapper, a Disassembly, and
 * the per-record validated positions — from the contract wasm and the parsed
 * trace. Shared by every backend that has wasm bytes in hand (the live pipeline,
 * and RawTraceBackend when given a `wasmPath`).
 *
 * Also home of per-record position validation: komet's `pos` is ambiguous
 * across sections (global-initializer records carry offsets relative to the
 * *globals* section payload, in the same numeric range as code offsets), so a
 * record's `pos` is only trusted when its instruction matches the static
 * disassembly at that code offset.
 *
 * Position validation also enforces a cross-contract gate. A traced
 * transaction interleaves the ROOT contract with cross-contract sub-calls
 * (an oracle, a token, ...), yet the disassembly and DWARF are built from
 * ONLY the root contract's wasm. A sub-call's small `pos` collides with the
 * root's low code offsets and would mis-map to bogus source, so records
 * executing in a contract other than the root are made invisible (position ->
 * null). Which contract a record belongs to comes from the trace's own call
 * boundaries, via the model's LedgerImage; a trace carrying none leaves the
 * gate inert.
 *
 * Missing or unreadable DWARF is NEVER fatal: the session degrades to a
 * NullSourceMapper (wasm-level debugging) with a note in the debug console.
 *
 * Pure module (no `vscode` imports).
 */

import { TraceModel } from './TraceModel';
import { DebugArtifacts, ProgressReporter } from './types';
import { Disassembly } from '../wasm/Disassembly';
import { DwarfLineTable } from '../dwarf/LineTable';
import { DwarfParseError } from '../dwarf/cursor';
import { WasmFormatError } from '../wasm/sections';
import { normalizeMnemonic } from '../komet/mnemonics';
import { DwarfSourceMapper } from '../sourcemap/DwarfSourceMapper';
import { NullSourceMapper } from '../sourcemap/NullSourceMapper';
import { VariableResolver, NullVariableResolver, DwarfVariableResolver } from '../sourcemap/VariableResolver';
import { DwarfDebugInfo } from '../dwarf/DebugInfo';

/**
 * Validate each record's `pos` against the static disassembly: the position is
 * kept only when an instruction starts at exactly that code offset AND — for
 * records whose mnemonic komet could decode — the disassembled text starts
 * with the same mnemonic. `["unknown"]` records pass on the exact-address
 * check alone. Everything else (null pos, mid-instruction offsets, records
 * from other sections' address spaces) maps to null.
 *
 * A cross-contract gate runs first: each record's executing contract comes from
 * the model's ledger reconstruction (the innermost open call at that record),
 * the root is the first one that resolves to a contract, and any record
 * executing in a DIFFERENT contract validates to null regardless of
 * pos/mnemonic. This is because a sub-call's `pos` collides with
 * the root's address space while the disassembly/DWARF here is the root
 * contract's ONLY. A record with no open call (the ledger baseline and anything
 * else ahead of the first `callContract`, or every record of a trace that
 * carries no call boundaries at all) is treated as "no contract" and never
 * gated, which is what keeps older, event-less traces working unchanged.
 *
 * The gate assumes the supplied `disassembly` is the trace ROOT contract's wasm
 * — true by construction in the live pipeline (`tracedWasm` is the invoked,
 * top-level contract). A replay `wasmPath` (RawTraceBackend) for a NON-root
 * contract would invert the gate and hide the wrong records; that is caller
 * error, no worse than the pre-gate mis-mapping.
 */
export function validatedPositions(model: TraceModel, disassembly: Disassembly): (number | null)[] {
  const ledger = model.ledger;
  const contracts = model.records.map((_, i) => ledger.executingContractAt(i));
  const root = contracts.find((contract) => contract !== undefined);
  return model.records.map((rec, i) => {
    const contract = contracts[i];
    if (root !== undefined && contract !== undefined && contract !== root) {
      return null;
    }
    if (rec.pos === null) {
      return null;
    }
    const at = disassembly.indexForAddress(rec.pos);
    if (at < 0) {
      return null;
    }
    const instruction = disassembly.instructions[at];
    if (instruction.address !== rec.pos) {
      return null;
    }
    const mnemonic = normalizeMnemonic(rec.instr);
    if (mnemonic === null) {
      return rec.pos;
    }
    return instruction.text.split(/\s+/, 1)[0] === mnemonic ? rec.pos : null;
  });
}

/**
 * Resolve the session's SourceMapper, Disassembly, and per-record validated
 * positions from the wasm bytes. Degradation ladder: undisassemblable wasm ->
 * NullSourceMapper + trace-derived disassembly; wasm without (readable) DWARF
 * -> NullSourceMapper + real disassembly; otherwise a DwarfSourceMapper over
 * validated positions.
 */
export function buildDebugArtifacts(
  wasm: Uint8Array,
  model: TraceModel,
  report: ProgressReporter,
): DebugArtifacts {
  let disassembly: Disassembly;
  try {
    disassembly = Disassembly.fromWasm(wasm);
  } catch (err) {
    report(
      `Warning: could not read the contract wasm (${errorMessage(err)}); ` +
        'showing trace-derived instructions without source mapping.',
    );
    return traceDerivedArtifacts(model);
  }

  const positions = validatedPositions(model, disassembly);
  const table = readLineTable(wasm, report);
  const source =
    table === null ? new NullSourceMapper() : new DwarfSourceMapper(model, table, positions);
  return { source, variables: resolveVariables(wasm, report), disassembly, positions };
}

/**
 * The wasm-less fallback: instructions rendered from the trace itself, no source
 * mapping. The trace-derived disassembly is built from the records' own `pos`
 * values, so the raw positions are self-consistent with it by construction
 * (there is no independent ground truth to validate against).
 */
export function traceDerivedArtifacts(model: TraceModel): DebugArtifacts {
  return {
    source: new NullSourceMapper(),
    variables: new NullVariableResolver(),
    disassembly: Disassembly.fromTrace(model),
    positions: model.records.map((rec) => rec.pos),
  };
}

/**
 * The wasm's DWARF line table, or null when there is nothing usable — no debug
 * sections, no rows, or debug info this parser rejects. Only a malformed-input
 * error degrades; anything else is a bug and propagates.
 */
function readLineTable(wasm: Uint8Array, report: ProgressReporter): DwarfLineTable | null {
  let table: DwarfLineTable | null;
  try {
    table = DwarfLineTable.fromWasm(wasm);
  } catch (err) {
    if (!(err instanceof DwarfParseError || err instanceof WasmFormatError)) {
      throw err;
    }
    report(
      `Warning: could not parse the wasm's DWARF debug info (${errorMessage(err)}); ` +
        'debugging continues at the wasm level.',
    );
    return null;
  }
  if (table === null || table.entries.length === 0) {
    report('Note: the contract wasm carries no DWARF line info; debugging continues at the wasm level.');
    return null;
  }
  return table;
}

/**
 * Resolve the source-level variable resolver from the wasm bytes, in its own
 * INDEPENDENT try/catch so a variable-resolution failure never disables the
 * line table (callers have already committed their SourceMapper by this point).
 * Degrades to a NullVariableResolver — the wasm-level variables view.
 */
function resolveVariables(wasm: Uint8Array, report: ProgressReporter): VariableResolver {
  try {
    const dwarf = DwarfDebugInfo.fromWasm(wasm);
    if (dwarf && dwarf.scopes.hasFunctions()) {
      return new DwarfVariableResolver(dwarf);
    }
  } catch (err) {
    if (err instanceof DwarfParseError || err instanceof WasmFormatError) {
      report(
        `Warning: could not parse DWARF variable info (${errorMessage(err)}); variables view stays wasm-level.`,
      );
    } else {
      throw err;
    }
  }
  return new NullVariableResolver();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
