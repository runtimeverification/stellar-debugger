/**
 * Parsing of komet-node execution traces.
 *
 * komet-node executes a whole transaction and (with `--trace` / via the
 * `traceTransaction` RPC) emits a trace as JSON Lines — one record per executed
 * WebAssembly instruction. A record looks like:
 *
 *   {"pos": 597, "instr": ["local.get", 0], "stack": [["i64", 4]], "locals": {"0": ["i64", 4]}}
 *
 * Fields:
 *   - pos:    byte offset of the instruction in the wasm binary, or null for
 *             synthetic instructions.
 *   - instr:  [name, ...operands].
 *   - stack:  value stack at instruction entry, as [type, value] pairs.
 *   - locals: local variable bindings keyed by index, as [type, value] pairs.
 *
 * No source line, function name, call frame, storage, or gas information is
 * present — that is the contract this module encodes. Mapping `pos` to source
 * is the job of the SourceMapper abstraction, not this parser.
 *
 * This module is pure (no `vscode` / DAP imports) so it can be unit-tested in
 * plain Node against golden fixtures.
 */

/** A typed value as it appears in a trace record: [wasmType, value]. */
export type TypedValue = [string, unknown];

/** A single WebAssembly-instruction trace record. */
export interface TraceRecord {
  /** Byte offset of the instruction in the wasm binary, or null if synthetic. */
  pos: number | null;
  /** Instruction name followed by its immediate operands. */
  instr: [string, ...unknown[]];
  /** Value stack at instruction entry, top-of-stack last. */
  stack: TypedValue[];
  /** Local bindings keyed by local index. */
  locals: Record<string, TypedValue>;
}

/** The opcode mnemonic of a record (e.g. "local.get"). */
export function opcode(record: TraceRecord): string {
  return record.instr[0];
}

function isTypedValue(v: unknown): v is TypedValue {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string';
}

/**
 * Validate and normalize a parsed JSON object into a TraceRecord. Throws on a
 * shape that does not match the documented contract so that a backend change is
 * caught loudly rather than silently mis-rendered.
 */
export function toTraceRecord(value: unknown, lineNo: number): TraceRecord {
  if (typeof value !== 'object' || value === null) {
    throw new TraceParseError(`trace line ${lineNo}: expected an object`);
  }
  const obj = value as Record<string, unknown>;

  const pos = obj.pos;
  if (pos !== null && typeof pos !== 'number') {
    throw new TraceParseError(`trace line ${lineNo}: 'pos' must be a number or null`);
  }

  if (!Array.isArray(obj.instr) || obj.instr.length === 0 || typeof obj.instr[0] !== 'string') {
    throw new TraceParseError(`trace line ${lineNo}: 'instr' must be a non-empty array starting with a string`);
  }

  const rawStack = obj.stack ?? [];
  if (!Array.isArray(rawStack) || !rawStack.every(isTypedValue)) {
    throw new TraceParseError(`trace line ${lineNo}: 'stack' must be an array of [type, value] pairs`);
  }

  const rawLocals = obj.locals ?? {};
  if (typeof rawLocals !== 'object' || rawLocals === null || Array.isArray(rawLocals)) {
    throw new TraceParseError(`trace line ${lineNo}: 'locals' must be an object`);
  }
  const locals: Record<string, TypedValue> = {};
  for (const [k, v] of Object.entries(rawLocals as Record<string, unknown>)) {
    if (!isTypedValue(v)) {
      throw new TraceParseError(`trace line ${lineNo}: local '${k}' must be a [type, value] pair`);
    }
    locals[k] = v;
  }

  return {
    pos: pos as number | null,
    instr: obj.instr as [string, ...unknown[]],
    stack: rawStack as TypedValue[],
    locals,
  };
}

export class TraceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TraceParseError';
  }
}

/**
 * Parse a JSONL trace string into records. Blank lines are skipped. Each
 * non-blank line must be a valid JSON object matching the record contract.
 */
export function parseTraceJsonl(jsonl: string): TraceRecord[] {
  const records: TraceRecord[] = [];
  const lines = jsonl.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new TraceParseError(`trace line ${i + 1}: invalid JSON: ${(e as Error).message}`);
    }
    records.push(toTraceRecord(parsed, i + 1));
  }
  return records;
}
