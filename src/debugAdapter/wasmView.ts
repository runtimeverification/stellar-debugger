/**
 * The wasm-level presentation of a trace record: the Locals, Value Stack and
 * Globals scopes, rendered as `ChildVar` nodes — the same shape the DWARF value
 * decoder and the ledger view produce, so every scope in the Variables pane
 * reaches DAP through one rendering path.
 *
 * Pure module (no `vscode` / DAP imports).
 */

import { TraceRecord, TypedValue } from '../komet/trace';
import { ChildVar } from '../dwarf/ValueDecoder';

/** Wasm locals of the record, keyed by local index. */
export function localNodes(record: TraceRecord): ChildVar[] {
  return Object.entries(record.locals).map(([index, tv]) => node(`local[${index}]`, tv));
}

/** The value stack of the record, top of stack first (the trace stores it last). */
export function stackNodes(record: TraceRecord): ChildVar[] {
  return [...record.stack].reverse().map((tv, i) => node(`[${i}]`, tv));
}

/**
 * Wasm globals of the record, or nothing for a trace that carries none (G4).
 * G1: the keys are MODULE-RELATIVE global indices, shown as such — the same
 * index space DWARF's global locations refer to.
 */
export function globalNodes(record: TraceRecord): ChildVar[] {
  return Object.entries(record.globals ?? {}).map(([index, tv]) => node(`global[${index}]`, tv));
}

/** One `[wasmType, value]` pair as a leaf node. */
function node(name: string, [typeName, value]: TypedValue): ChildVar {
  return { name, value: { display: format(value), typeName } };
}

function format(value: unknown): string {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}
