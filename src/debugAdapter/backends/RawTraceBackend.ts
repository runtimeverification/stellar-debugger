/**
 * M1 backend: replay a precomputed JSONL trace from disk. Requires no komet-node
 * and no contract build — it exercises the entire DAP replay path end-to-end
 * from a captured trace file (the `rawTrace` launch attribute). Also the basis
 * for golden-trace integration tests.
 *
 * Pure module (uses fs, no `vscode` imports).
 */

import { promises as fs } from 'fs';
import { parseTraceJsonl } from '../../komet/trace';
import { TraceModel } from '../TraceModel';
import { TraceListingSource } from '../../sourcemap/SourceMapper';
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
    const source = new TraceListingSource(model);
    return { model, source };
  }

  async dispose(): Promise<void> {
    // Nothing to tear down.
  }
}
