/**
 * The one-shot CLI trace projection (docs/trace-cli-internal.md, "Interface 1").
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
import { ProjectOpts, projectSourceStop } from './projectStop';

/** Options for the one-shot CLI trace projection. */
export interface CliTraceOpts extends ProjectOpts {
  function?: string;
  wasm?: string;
  allowNoSource?: boolean;
  /** Restrict source stops to workspace code (default true, S21). */
  justMyCode?: boolean;
}

/**
 * Project a resolved trace into kind-tagged JSONL lines. Throws when there are
 * no source-level stops unless `opts.allowNoSource` is set.
 */
export function runCliTrace(resolved: ResolvedTrace, opts?: CliTraceOpts): string[] {
  const stopModel = buildStopModel(resolved, { justMyCode: opts?.justMyCode });

  if (stopModel.runStarts.length === 0 && !opts?.allowNoSource) {
    throw new Error(
      'No Rust source-level stops in this trace (no DWARF / no source). ' +
        'Pass a matching --wasm, or --allow-no-source.',
    );
  }

  // Both state images hang off the model, built once on first use and shared by
  // every stop below.
  const ledger = resolved.model.ledger;
  const projectOpts: ProjectOpts = {
    maxDepth: opts?.maxDepth,
    maxChildren: opts?.maxChildren,
    maxNodes: opts?.maxNodes,
  };

  const lines: string[] = [
    JSON.stringify({
      kind: 'meta',
      function: opts?.function,
      wasm: opts?.wasm,
      records: resolved.model.records.length,
      stops: stopModel.runStarts.length,
      hasDwarf: resolved.variables.hasVariables(),
      // Whether the stop records below carry `globals` / `ledger` at all, so a
      // consumer can branch without probing every stop (G4, L14).
      hasGlobals: resolved.model.records.some((r) => r.globals !== undefined),
      hasLedger: ledger.hasLedger(),
    }),
  ];

  // Each stop's `changed` flags are relative to the PREVIOUS stop, so the JSONL
  // alone shows where the ledger moved as execution advanced.
  let previousIndex: number | undefined;
  for (const index of stopModel.runStarts) {
    lines.push(
      JSON.stringify({
        kind: 'stop',
        ...projectSourceStop(resolved, stopModel, index, { ...projectOpts, previousIndex }),
      }),
    );
    previousIndex = index;
  }

  lines.push(
    JSON.stringify({
      kind: 'result',
      ...(resolved.model.returnValue !== undefined
        ? { returnValue: resolved.model.returnValue }
        : {}),
      terminated: true,
    }),
  );

  return lines;
}
