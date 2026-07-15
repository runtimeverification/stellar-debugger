/**
 * Bridges a single `TraceRecord` (plus the snapshot-backed `MemoryImage`) at a
 * replay cursor to the `RuntimeState` the DWARF location evaluator consumes. The
 * trace stores locals/globals/stack as `[wasmType, value]` pairs; the evaluator
 * wants bare numeric slot values, so `typedValueToNumber` normalizes them.
 *
 * Pure module (no `vscode` / DAP imports).
 */

import { TraceRecord, TypedValue } from '../komet/trace';
import { RuntimeState } from '../dwarf/locexpr';
import { MemoryImage } from './MemoryImage';

/**
 * Coerce a trace `[wasmType, value]` to a numeric slot value. i32/f32/f64
 * arrive as JS numbers; i64 (and other large values) may arrive as decimal
 * strings, which become `bigint`; booleans map to 0/1. Anything else — a
 * missing value or an unexpected shape — is `undefined`.
 */
export function typedValueToNumber(tv: TypedValue | undefined): number | bigint | undefined {
  if (tv === undefined) {
    return undefined;
  }
  const value = tv[1];
  switch (typeof value) {
    case 'number':
      return value;
    case 'string':
      try {
        return BigInt(value);
      } catch {
        return undefined;
      }
    case 'boolean':
      return value ? 1 : 0;
    default:
      return undefined;
  }
}

/**
 * Build a `RuntimeState` view over `record` at `cursor`. Register slots read
 * from the record's typed-value maps/array; memory reads delegate to `memory`
 * at `cursor` (the latest snapshot at or before it).
 */
export function makeRuntimeState(
  record: TraceRecord,
  memory: MemoryImage,
  cursor: number,
): RuntimeState {
  return {
    localValue: (index: number) => typedValueToNumber(record.locals[String(index)]),
    globalValue: (index: number) => typedValueToNumber(record.globals?.[String(index)]),
    stackValue: (index: number) => typedValueToNumber(record.stack[index]),
    readMemory: (address: number, size: number) => memory.readMemory(cursor, address, size),
  };
}
