/**
 * The one-shot CLI trace projection (docs/interfaces.md, "Interface 1").
 *
 * `runCliTrace` walks `stopModel.runStarts` in order — provably the same
 * sequence a user sees stepping in (statement-granularity stepIn visits
 * runStarts[0..n] then terminates per S20) — and emits kind-tagged JSONL: a
 * leading `meta` record, one `stop` per runStart, then a trailing `result`.
 *
 * When `runStarts` is empty (no DWARF / no source) it ERRORS rather than
 * silently emitting `visibleIndices` as if they were source statements, unless
 * `allowNoSource` opts in.
 *
 * Pure module (no `vscode`, no DAP imports).
 */

import { ResolvedTrace } from '../debugAdapter/types';
import { buildStopModel } from '../debugAdapter/stopModel';
import { MemoryImage } from '../debugAdapter/MemoryImage';
import { ProjectOpts, projectSourceStop } from './projectStop';

/** Options for the one-shot CLI trace projection. */
export interface CliTraceOpts extends ProjectOpts {
  function?: string;
  wasm?: string;
  allowNoSource?: boolean;
}

/**
 * Project a resolved trace into kind-tagged JSONL lines. Throws when there are
 * no source-level stops unless `opts.allowNoSource` is set.
 */
export function runCliTrace(resolved: ResolvedTrace, opts?: CliTraceOpts): string[] {
  const stopModel = buildStopModel(resolved);

  if (stopModel.runStarts.length === 0 && !opts?.allowNoSource) {
    throw new Error(
      'No Rust source-level stops in this trace (no DWARF / no source). ' +
        'Pass a matching --wasm, or --allow-no-source.',
    );
  }

  const memory = new MemoryImage(resolved.model.records);
  const projectOpts: ProjectOpts = {
    maxDepth: opts?.maxDepth,
    maxChildren: opts?.maxChildren,
    maxNodes: opts?.maxNodes,
    memory,
  };

  const lines: string[] = [
    JSON.stringify({
      kind: 'meta',
      function: opts?.function,
      wasm: opts?.wasm,
      records: resolved.model.records.length,
      stops: stopModel.runStarts.length,
      hasDwarf: resolved.variables.hasVariables(),
    }),
  ];

  for (const index of stopModel.runStarts) {
    lines.push(
      JSON.stringify({ kind: 'stop', ...projectSourceStop(resolved, stopModel, index, projectOpts) }),
    );
  }

  lines.push(
    JSON.stringify({
      kind: 'result',
      ...(resolved.returnValue !== undefined ? { returnValue: resolved.returnValue } : {}),
      terminated: true,
    }),
  );

  return lines;
}
