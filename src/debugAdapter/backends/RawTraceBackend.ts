/**
 * Replay backend: a precomputed JSONL trace from disk (the `rawTrace` launch
 * attribute). Requires no komet-node and no contract build — it exercises the
 * entire DAP replay path end-to-end from a captured trace file. With a
 * matching `wasmPath` the replay is symbol-rich (real disassembly + DWARF
 * source mapping); without one it degrades to trace-derived instructions and
 * no source. Also the basis for golden-trace integration tests.
 *
 * Pure module (uses fs, no `vscode` imports).
 */

import { promises as fs } from 'fs';
import { parseTraceJsonl } from '../../komet/trace';
import { TraceModel } from '../TraceModel';
import { Disassembly } from '../../wasm/Disassembly';
import { NullSourceMapper } from '../../sourcemap/NullSourceMapper';
import { NullVariableResolver } from '../../sourcemap/VariableResolver';
import { buildDebugArtifacts } from '../artifacts';
import { ProgressReporter, ResolvedTrace, SessionBackend, SorobanLaunchArgs } from '../types';

export class RawTraceBackend implements SessionBackend {
  async resolve(args: SorobanLaunchArgs, report: ProgressReporter): Promise<ResolvedTrace> {
    if (!args.rawTrace) {
      throw new Error('RawTraceBackend requires the `rawTrace` launch attribute (path to a JSONL trace).');
    }
    report(`Reading trace from ${args.rawTrace}`);
    const jsonl = await fs.readFile(args.rawTrace, 'utf8');
    const records = parseTraceJsonl(jsonl);
    const model = new TraceModel(records);

    if (args.wasmPath) {
      report(`Reading contract wasm from ${args.wasmPath}`);
      const wasm = await fs.readFile(args.wasmPath);
      const { source, variables, disassembly, positions } = buildDebugArtifacts(wasm, model, report);
      return { model, source, variables, disassembly, positions };
    }
    // Without wasm there is nothing to validate positions against; the raw
    // `pos` values are used as-is, which is self-consistent because the
    // trace-derived disassembly is built from those same values.
    return {
      model,
      source: new NullSourceMapper(),
      variables: new NullVariableResolver(),
      disassembly: Disassembly.fromTrace(model),
      positions: records.map((rec) => rec.pos),
    };
  }

  async dispose(): Promise<void> {
    // Nothing to tear down.
  }
}
