/**
 * Builds the per-session debug artifacts — a SourceMapper, a Disassembly, and
 * the per-record validated positions — from the contract wasm and the parsed
 * trace. Shared by every backend that has wasm bytes in hand (TurnkeyPipeline,
 * RawTraceBackend with `wasmPath`).
 *
 * Also home of per-record position validation: komet's `pos` is ambiguous
 * across sections (global-initializer records carry offsets relative to the
 * *globals* section payload, in the same numeric range as code offsets — M0
 * ground truth), so a record's `pos` is only trusted when its instruction
 * matches the static disassembly at that code offset.
 *
 * Missing or unreadable DWARF is NEVER fatal: the session degrades to a
 * NullSourceMapper (wasm-level debugging) with a note in the debug console.
 *
 * Pure module (no `vscode` imports).
 */

import { TraceModel } from './TraceModel';
import { ProgressReporter } from './types';
import { Disassembly } from '../wasm/Disassembly';
import { DwarfLineTable } from '../dwarf/LineTable';
import { DwarfParseError } from '../dwarf/cursor';
import { WasmFormatError } from '../wasm/sections';
import { normalizeMnemonic } from '../komet/mnemonics';
import { SourceMapper } from '../sourcemap/SourceMapper';
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
 */
export function validatedPositions(model: TraceModel, disassembly: Disassembly): (number | null)[] {
  return model.records.map((rec) => {
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
): { source: SourceMapper; variables: VariableResolver; disassembly: Disassembly; positions: (number | null)[] } {
  let disassembly: Disassembly;
  try {
    disassembly = Disassembly.fromWasm(wasm);
  } catch (err) {
    report(
      `Warning: could not read the contract wasm (${errorMessage(err)}); ` +
        'showing trace-derived instructions without source mapping.',
    );
    // The trace-derived disassembly is built from the records' own `pos`
    // values, so the raw positions are self-consistent with it by construction
    // (there is no independent ground truth to validate against).
    return {
      source: new NullSourceMapper(),
      variables: new NullVariableResolver(),
      disassembly: Disassembly.fromTrace(model),
      positions: model.records.map((rec) => rec.pos),
    };
  }
  const positions = validatedPositions(model, disassembly);

  let table: DwarfLineTable | null;
  try {
    table = DwarfLineTable.fromWasm(wasm);
  } catch (err) {
    if (err instanceof DwarfParseError || err instanceof WasmFormatError) {
      report(
        `Warning: could not parse the wasm's DWARF debug info (${errorMessage(err)}); ` +
          'debugging continues at the wasm level.',
      );
      return { source: new NullSourceMapper(), variables: resolveVariables(wasm, report), disassembly, positions };
    }
    throw err;
  }
  if (table === null || table.entries.length === 0) {
    report('Note: the contract wasm carries no DWARF line info; debugging continues at the wasm level.');
    return { source: new NullSourceMapper(), variables: resolveVariables(wasm, report), disassembly, positions };
  }

  const source = new DwarfSourceMapper(model, table, positions);
  return { source, variables: resolveVariables(wasm, report), disassembly, positions };
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
