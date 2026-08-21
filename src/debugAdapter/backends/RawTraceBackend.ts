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

import { readFileOrExplain, readTextOrExplain } from '../../diagnostics/files';
import { parseTraceJsonl } from '../../komet/trace';
import { TraceModel } from '../TraceModel';
import { buildDebugArtifacts, traceDerivedArtifacts } from '../artifacts';
import { ProgressReporter, ResolvedTrace, SessionBackend, SorobanLaunchArgs } from '../types';

export class RawTraceBackend implements SessionBackend {
  async resolve(args: SorobanLaunchArgs, report: ProgressReporter): Promise<ResolvedTrace> {
    if (!args.rawTrace) {
      throw new Error('RawTraceBackend requires the `rawTrace` launch attribute (path to a JSONL trace).');
    }
    report(`Reading trace from ${args.rawTrace}`);
    const jsonl = await readTextOrExplain(
      args.rawTrace,
      'the recorded trace (`rawTrace`)',
      'Record one with `stellar-trace --out <file>`, or point `rawTrace` at an existing JSONL trace.',
    );
    const model = new TraceModel(parseTraceJsonl(jsonl));

    if (args.wasmPath) {
      report(`Reading contract wasm from ${args.wasmPath}`);
      const wasm = await readFileOrExplain(
        args.wasmPath,
        'the contract wasm (`wasmPath`)',
        'It should be the same `.wasm` the trace was recorded from. Drop `wasmPath` to replay ' +
          'without source mapping.',
      );
      return { model, ...buildDebugArtifacts(wasm, model, report) };
    }
    // Without wasm there is nothing to validate positions against, and nothing
    // to map source from: the replay degrades to trace-derived instructions.
    return { model, ...traceDerivedArtifacts(model) };
  }

  async dispose(): Promise<void> {
    // Nothing to tear down.
  }
}
