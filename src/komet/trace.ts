/**
 * Parsing of komet-node execution traces.
 *
 * komet-node executes a whole transaction and, via the `traceTransaction` RPC,
 * emits a trace as JSON Lines — one record per executed WebAssembly
 * instruction. A record looks like (from test/fixtures/adder-debug.trace.jsonl):
 *
 *   {"pos": 45, "instr": ["add", "i32"], "stack": [["i32", 4], ["i32", 3]], "locals": {"2": ["i32", 3]}}
 *
 * Fields:
 *   - pos:    byte offset of the instruction relative to the payload of the
 *             SECTION IT EXECUTES IN — the code section's payload for function
 *             code, but e.g. the globals section's payload for records that
 *             evaluate global initializers. The two ranges overlap, so a `pos`
 *             is only a code offset after downstream validation against the
 *             static disassembly (debugAdapter/artifacts.ts). Null for
 *             synthetic instructions.
 *   - instr:  [op, ...operands] in komet's K-style spelling: a type qualifier
 *             follows the op (["const","i64",255] is `i64.const 255`), and
 *             ["unknown"] stands for opcodes its printer cannot decode (e.g.
 *             `if`) — see komet/mnemonics.ts for normalization.
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
  /**
   * Byte offset of the instruction relative to its section's payload (code
   * offset for function code), or null if synthetic. See the module header.
   */
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
