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
 *   - globals: OPTIONAL. Full wasm globals by index, as [type, value] pairs,
 *             repeated per step (there are only a handful). Absent in older
 *             traces.
 *   - mem:    OPTIONAL. A FULL sparse snapshot of the current module's linear
 *             memory at this step, as an array of { addr, bytes } runs: each run
 *             is a byte range starting at `addr` whose `bytes` is LOWERCASE HEX
 *             on the wire and is decoded to a Uint8Array at parse time. Runs are
 *             disjoint and ascending; any byte not covered by a run reads as 0
 *             (wasm memory is zero-initialized). `null` (or an absent key) means
 *             the memory is UNCHANGED since the previous snapshot — the common
 *             case. Because each snapshot is the whole memory, no folding across
 *             records is needed; the latest snapshot at index <= cursor is the
 *             full memory at that replay position. Absent in older traces.
 *
 * No source line, function name, call frame, storage, or gas information is
 * present — that is the contract this module encodes. Mapping `pos` to source
 * is the job of the SourceMapper abstraction, not this parser.
 *
 * ## Record kinds
 *
 * Every record names itself with a top-level `kind`: `"instr"` for the
 * instruction records above, or the operation name for a Soroban VM record (a
 * contract call boundary, a storage write, the ledger baseline — see
 * `traceEvents.ts`). Only instruction records carry `pos`, `instr`, `stack`,
 * `locals`, `mem` and `globals`; a VM record carries fields shaped for itself
 * alone, and `instr` holds just its kind so that a record always names what it
 * is in the same place.
 *
 * `kind` is required, and a record without one is rejected. It arrived in komet
 * v0.1.87, which reorganised the trace; traces from before that are not read.
 *
 * This module is pure (no `vscode` / DAP imports) so it can be unit-tested in
 * plain Node against golden fixtures.
 */

import { TraceParseError } from './traceError';
import { isEvenLengthHex, parseTraceEvent, TraceEvent } from './traceEvents';

export { TraceParseError } from './traceError';
export type {
  TraceEvent,
  TraceAddress,
  ScValJson,
  StorageEntry,
  AccountEntry,
  ContractEntry,
  CodeEntry,
  Durability,
} from './traceEvents';

/** A typed value as it appears in a trace record: [wasmType, value]. */
export type TypedValue = [string, unknown];

/**
 * A single run of a full linear-memory snapshot from a trace record: the byte
 * range starting at `addr`. On the wire `bytes` is lowercase hex; this module
 * decodes it to a `Uint8Array` at parse time.
 */
export interface MemRun {
  addr: number;
  bytes: Uint8Array;
}

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
  /**
   * Full wasm globals keyed by global index, or undefined for traces that do
   * not carry per-step globals. See the module header.
   */
  globals?: Record<string, TypedValue>;
  /**
   * Full sparse snapshot of linear memory at this step (hex decoded to bytes),
   * or undefined when unchanged since the previous snapshot (JSON `null` or an
   * absent key) or for traces that do not carry memory. See the module header.
   */
  mem?: MemRun[];
  /**
   * The typed payload of a Soroban VM event record (storage write, contract-call
   * boundary, ledger baseline, host object allocation, …), or undefined for an
   * ordinary instruction record and for event tags this adapter does not model.
   * See komet/traceEvents.ts and docs/state-inspection.md.
   */
  event?: TraceEvent;
}

/** The opcode mnemonic of a record (e.g. "local.get"). */
export function opcode(record: TraceRecord): string {
  return record.instr[0];
}

function isTypedValue(v: unknown): v is TypedValue {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate and normalize a parsed JSON object into a TraceRecord. Throws on a
 * shape that does not match the documented contract so that a backend change is
 * caught loudly rather than silently mis-rendered.
 */
export function toTraceRecord(value: unknown, lineNo: number): TraceRecord {
  // Explicitly typed so TypeScript narrows on the never-returning call.
  const reject: (message: string) => never = (message) => {
    throw new TraceParseError(`trace line ${lineNo}: ${message}`);
  };

  if (typeof value !== 'object' || value === null) {
    reject('expected an object');
  }
  const obj = value as Record<string, unknown>;

  const kind = obj.kind;
  if (typeof kind !== 'string' || kind === '') {
    reject("'kind' must be a non-empty string");
  }
  const isInstruction = kind === 'instr';

  // A VM record carries no position: it does not come from anywhere in the
  // binary. An instruction record must state one, even if null.
  const pos = obj.pos ?? null;
  if (pos !== null && typeof pos !== 'number') {
    reject("'pos' must be a number or null");
  }
  if (isInstruction && obj.pos === undefined) {
    reject("'pos' is required on an instruction record");
  }

  const instr = obj.instr;
  if (isInstruction && (!Array.isArray(instr) || instr.length === 0 || typeof instr[0] !== 'string')) {
    reject("'instr' must be a non-empty array starting with a string");
  }

  const stack = obj.stack ?? [];
  if (!Array.isArray(stack) || !stack.every(isTypedValue)) {
    reject("'stack' must be an array of [type, value] pairs");
  }

  /** A `{ index: [type, value] }` map, as locals and globals are both encoded. */
  const typedValueMap = (raw: unknown, what: string): Record<string, TypedValue> => {
    if (!isPlainObject(raw)) {
      reject(`'${what}' must be an object`);
    }
    for (const [slot, v] of Object.entries(raw)) {
      if (!isTypedValue(v)) {
        reject(`${what} '${slot}' must be a [type, value] pair`);
      }
    }
    return raw as Record<string, TypedValue>;
  };

  return {
    pos,
    // A VM record has no instruction; it names itself, so `instr` is its kind.
    instr: isInstruction ? (instr as [string, ...unknown[]]) : [kind],
    stack: stack as TypedValue[],
    locals: typedValueMap(obj.locals ?? {}, 'local'),
    globals: obj.globals === undefined ? undefined : typedValueMap(obj.globals, 'global'),
    mem: toMemRuns(obj.mem, reject),
    event: eventOf(obj, kind, lineNo),
  };
}

/**
 * A record's full sparse memory snapshot, hex decoded to bytes. `null` and an
 * absent key both mean "unchanged since the previous snapshot" and yield
 * undefined (see the module header).
 */
function toMemRuns(raw: unknown, reject: (message: string) => never): MemRun[] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    reject("'mem' must be an array or null");
  }
  return raw.map((entry, i) => {
    if (!isPlainObject(entry)) {
      reject(`mem[${i}] must be an object`);
    }
    const { addr, bytes } = entry;
    if (typeof addr !== 'number') {
      reject(`mem[${i}].addr must be a number`);
    }
    if (!isEvenLengthHex(bytes)) {
      reject(`mem[${i}].bytes must be an even-length lowercase-hex string`);
    }
    return { addr, bytes: new Uint8Array(Buffer.from(bytes, 'hex')) };
  });
}

/**
 * The record's event payload, or undefined when it has none — including when a
 * modelled payload fails to validate. An event is auxiliary: stepping and source
 * mapping never read it, so a malformed one degrades the state views (G4/L14)
 * instead of failing the whole session, which is the one place this module's
 * fail-loudly policy is deliberately inverted.
 */
function eventOf(
  obj: Record<string, unknown>,
  kind: string,
  lineNo: number,
): TraceEvent | undefined {
  try {
    return parseTraceEvent(obj, kind, lineNo);
  } catch (e) {
    if (e instanceof TraceParseError) {
      return undefined;
    }
    throw e;
  }
}

/**
 * Validate an array of already-parsed JSON record values into TraceRecords.
 * This is the shape komet-node's `traceTransaction` RPC returns directly — a
 * JSON array of records, one per executed instruction or Soroban VM event;
 * `parseTraceJsonl` is the equivalent for a bare JSONL string (file replay).
 */
export function toTraceRecords(values: readonly unknown[]): TraceRecord[] {
  return values.map((value, i) => toTraceRecord(value, i + 1));
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
