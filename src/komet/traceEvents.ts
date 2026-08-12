/**
 * Parsing of the Soroban VM **event records** interleaved into a komet-node
 * trace (see docs/state-inspection.md, "What the trace carries").
 *
 * Alongside one record per executed wasm instruction, komet's tracer emits
 * records that carry a payload shaped for that event rather than the four-field
 * pos/instr/stack/locals shape — the callee's storage on entry to a contract
 * call, every storage write, TTL extensions, the ledger baseline, host object
 * allocations. `parseTraceEvent` turns such a record's extra keys into a typed
 * `TraceEvent`; `komet/trace.ts` hangs the result off `TraceRecord.event` so the
 * existing record fields (and every consumer of them) are untouched.
 *
 * The event is identified here by `instr[0]`, and its inline operands by
 * `instr[1..]`. That is the older wire spelling; komet >= v0.1.87 tags records
 * with `kind` and names those operands instead. `trace.ts` normalizes the newer
 * form back onto `instr` before calling in (see its "Two wire formats"), so this
 * module reads one shape and neither format appears below.
 *
 * Unlike the core record fields, an event payload is **auxiliary**: stepping,
 * breakpoints and source mapping do not depend on it, only the state views do.
 * So this module inverts `trace.ts`'s fail-loudly policy — `parseTraceEvent`
 * never throws. An unknown tag, an event kind this adapter does not model, and
 * a malformed payload all yield `undefined`: the record still parses as an
 * ordinary one and the state views degrade exactly as G4/L14 prescribe. A
 * komet release that adds or reshapes an event can therefore never break a
 * debug session, and partial event records (as the mocks and fixtures in the
 * test suite build) stay acceptable.
 *
 * `strictParseTraceEvent` is the same parser with the validation errors left to
 * propagate. It is what pins the payload contract in the tests, and what a
 * trace-validation tool would call.
 *
 * Pure module (no `vscode` / DAP imports).
 */

import { TraceParseError } from './traceError';

/** Storage durability classes, as komet's `StorageType2JSON` spells them. */
export type Durability = 'instance' | 'persistent' | 'temporary';

const DURABILITIES: ReadonlySet<string> = new Set<Durability>([
  'instance',
  'persistent',
  'temporary',
]);

/**
 * An address as the trace encodes it (komet's `Address2JSON`), reduced to the
 * two fields that identify it. `value` is LOWERCASE HEX of the raw address
 * bytes — 32 bytes on a real ledger, but komet's own tests use short ids, so no
 * length is assumed here. Rendering it as a `C…`/`G…` strkey is the display
 * layer's job (`soroban/scvalJson.ts`), not the parser's.
 */
export interface TraceAddress {
  addrType: 'account' | 'contract';
  value: string;
}

/**
 * An `ScVal` as the trace encodes it (komet's `ScVal2JSON`): `{ type, value }`,
 * with `address` carrying `addrType` and `error` carrying `errType`/`code`.
 *
 * Kept structural rather than a closed union: a komet release that adds an
 * `ScVal` type should render generically, not throw. Validation only insists
 * that `type` is a string and that a value-bearing type actually carries one.
 *
 * NOTE (precision): komet emits `u64`/`i128`/`u256` as JSON *numbers*, so
 * values beyond 2^53 have already lost precision by the time `JSON.parse` hands
 * them over. Decimal strings are accepted here so a future komet can fix that
 * without an adapter change.
 */
export interface ScValJson {
  type: string;
  value?: unknown;
  addrType?: string;
  errType?: string;
  code?: number;
}

/** One storage entry as it appears in a baseline (`liveUntil` is a ledger seq). */
export interface StorageEntry {
  durability: Durability;
  key: ScValJson;
  value: ScValJson;
  liveUntil: number;
}

/** One account entry of a ledger baseline. */
export interface AccountEntry {
  account: TraceAddress;
  /** Balance in stroops. */
  balance: number;
}

/** One contract entry of a ledger baseline, with its own storage. */
export interface ContractEntry {
  contract: TraceAddress;
  /** Lowercase hex of the instance's wasm hash. */
  wasmHash: string;
  liveUntil: number;
  storage: StorageEntry[];
}

/** One uploaded-code entry of a ledger baseline. */
export interface CodeEntry {
  hash: string;
  liveUntil: number;
}

/** The typed payload of a Soroban VM event record. */
export type TraceEvent =
  | {
      kind: 'ledger';
      sequence: number;
      timestamp: number;
      accounts: AccountEntry[];
      contracts: ContractEntry[];
      codes: CodeEntry[];
    }
  | {
      kind: 'callContract';
      from: TraceAddress;
      to: TraceAddress;
      function: string;
      args: ScValJson[];
      depth: number;
      /** The callee's FULL storage as of call entry, across all durabilities. */
      storage: StorageEntry[];
    }
  | { kind: 'endWasm'; success: boolean; depth: number; result: ScValJson | null }
  | {
      kind: 'contractData';
      /** `put`/`del` mutate; `get`/`has` are reads a producer may not emit. */
      op: 'put' | 'del' | 'get' | 'has';
      durability: Durability;
      contract: TraceAddress;
      key: ScValJson;
      /** Present for `put`. */
      value?: ScValJson;
      /** Present for `get`/`has` when the producer records the outcome. */
      result?: ScValJson | null;
    }
  | {
      kind: 'contractTtl';
      target: 'data';
      contract: TraceAddress;
      durability: Durability;
      key: ScValJson;
      liveUntil: number;
    }
  | { kind: 'contractTtl'; target: 'instance'; contract: TraceAddress; liveUntil: number }
  | { kind: 'contractTtl'; target: 'code'; hash: string; liveUntil: number }
  | { kind: 'contractCode'; contract: TraceAddress; wasmHash: string }
  | { kind: 'deployContract'; contract: TraceAddress; wasmHash: string; liveUntil: number }
  | { kind: 'account'; account: TraceAddress; balance: number }
  | { kind: 'ledgerInfo'; sequence: number; timestamp: number }
  | { kind: 'addObject'; index: number; value: ScValJson }
  | { kind: 'hostCall'; module: string; function: string };

/** Deepest `ScVal` nesting validated; below this, structure is taken on trust. */
const MAX_SCVAL_DEPTH = 64;

const HEX = /^[0-9a-f]*$/;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(lineNo: number, message: string): never {
  throw new TraceParseError(`trace line ${lineNo}: ${message}`);
}

function reqInt(obj: Obj, key: string, lineNo: number, tag: string): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    fail(lineNo, `${tag} event: '${key}' must be a number`);
  }
  return v;
}

function reqString(obj: Obj, key: string, lineNo: number, tag: string): string {
  const v = obj[key];
  if (typeof v !== 'string') {
    fail(lineNo, `${tag} event: '${key}' must be a string`);
  }
  return v;
}

function reqHex(obj: Obj, key: string, lineNo: number, tag: string): string {
  const v = reqString(obj, key, lineNo, tag);
  if (!HEX.test(v) || v.length % 2 !== 0) {
    fail(lineNo, `${tag} event: '${key}' must be an even-length lowercase-hex string`);
  }
  return v;
}

function reqBool(obj: Obj, key: string, lineNo: number, tag: string): boolean {
  const v = obj[key];
  if (typeof v !== 'boolean') {
    fail(lineNo, `${tag} event: '${key}' must be a boolean`);
  }
  return v;
}

function reqDurability(value: unknown, lineNo: number, tag: string): Durability {
  if (typeof value !== 'string' || !DURABILITIES.has(value)) {
    fail(lineNo, `${tag} event: durability must be one of instance/persistent/temporary`);
  }
  return value as Durability;
}

/** Validate an address object down to `{ addrType, value }`. */
function toAddress(value: unknown, lineNo: number, tag: string, what: string): TraceAddress {
  if (!isObj(value)) {
    fail(lineNo, `${tag} event: '${what}' must be an address object`);
  }
  const addrType = value.addrType;
  if (addrType !== 'account' && addrType !== 'contract') {
    fail(lineNo, `${tag} event: '${what}'.addrType must be "account" or "contract"`);
  }
  const raw = value.value;
  if (typeof raw !== 'string' || !HEX.test(raw) || raw.length % 2 !== 0) {
    fail(lineNo, `${tag} event: '${what}'.value must be an even-length lowercase-hex string`);
  }
  return { addrType, value: raw };
}

function reqAddress(obj: Obj, key: string, lineNo: number, tag: string): TraceAddress {
  return toAddress(obj[key], lineNo, tag, key);
}

/**
 * Validate an `ScVal` object. Types this module knows the shape of are checked
 * exactly; any other type is accepted as long as it carries a `value`, so a new
 * komet `ScVal` renders generically instead of failing the session.
 */
function toScVal(value: unknown, lineNo: number, tag: string, what: string, depth = 0): ScValJson {
  if (!isObj(value) || typeof value.type !== 'string') {
    fail(lineNo, `${tag} event: '${what}' must be an ScVal object with a string 'type'`);
  }
  const type = value.type;
  if (type === 'void') {
    return { type };
  }
  if (type === 'address') {
    const address = toAddress(value, lineNo, tag, what);
    return { type, addrType: address.addrType, value: address.value };
  }
  if (type === 'error') {
    return {
      type,
      errType: reqString(value, 'errType', lineNo, tag),
      code: reqInt(value, 'code', lineNo, tag),
    };
  }
  if (value.value === undefined) {
    fail(lineNo, `${tag} event: '${what}' of type "${type}" must carry a 'value'`);
  }
  if (depth < MAX_SCVAL_DEPTH) {
    if (type === 'vec') {
      if (!Array.isArray(value.value)) {
        fail(lineNo, `${tag} event: '${what}' of type "vec" must carry an array 'value'`);
      }
      return {
        type,
        value: value.value.map((item, i) => toScVal(item, lineNo, tag, `${what}[${i}]`, depth + 1)),
      };
    }
    if (type === 'map') {
      if (!Array.isArray(value.value)) {
        fail(lineNo, `${tag} event: '${what}' of type "map" must carry an array 'value'`);
      }
      return {
        type,
        value: value.value.map((entry, i) => {
          if (!Array.isArray(entry) || entry.length !== 2) {
            fail(lineNo, `${tag} event: '${what}' map entry ${i} must be a [key, value] pair`);
          }
          return [
            toScVal(entry[0], lineNo, tag, `${what}[${i}].key`, depth + 1),
            toScVal(entry[1], lineNo, tag, `${what}[${i}].value`, depth + 1),
          ];
        }),
      };
    }
  }
  // Validated above: `type` is a string. Any other shape (a komet ScVal type
  // this module does not model) passes through for generic rendering.
  return { ...value, type } as ScValJson;
}

function reqScVal(obj: Obj, key: string, lineNo: number, tag: string): ScValJson {
  return toScVal(obj[key], lineNo, tag, key);
}

/** Validate a JSON array of `ScVal`s; an absent key is an empty list. */
function scValList(obj: Obj, key: string, lineNo: number, tag: string): ScValJson[] {
  const raw = obj[key] ?? [];
  if (!Array.isArray(raw)) {
    fail(lineNo, `${tag} event: '${key}' must be an array`);
  }
  return raw.map((item, i) => toScVal(item, lineNo, tag, `${key}[${i}]`));
}

/** Validate a `[{durability, key, value, liveUntil}]` storage array. */
function storageList(obj: Obj, key: string, lineNo: number, tag: string): StorageEntry[] {
  const raw = obj[key] ?? [];
  if (!Array.isArray(raw)) {
    fail(lineNo, `${tag} event: '${key}' must be an array`);
  }
  return raw.map((entry, i) => {
    if (!isObj(entry)) {
      fail(lineNo, `${tag} event: '${key}[${i}]' must be an object`);
    }
    return {
      durability: reqDurability(entry.durability, lineNo, tag),
      key: toScVal(entry.key, lineNo, tag, `${key}[${i}].key`),
      value: toScVal(entry.value, lineNo, tag, `${key}[${i}].value`),
      liveUntil: reqInt(entry, 'liveUntil', lineNo, tag),
    };
  });
}

function objectList(obj: Obj, key: string, lineNo: number, tag: string): Obj[] {
  const raw = obj[key] ?? [];
  if (!Array.isArray(raw)) {
    fail(lineNo, `${tag} event: '${key}' must be an array`);
  }
  return raw.map((entry, i) => {
    if (!isObj(entry)) {
      fail(lineNo, `${tag} event: '${key}[${i}]' must be an object`);
    }
    return entry;
  });
}

/**
 * Parse the event payload of a trace record, tolerating anything unexpected:
 * returns `undefined` for an ordinary instruction record, for an event tag this
 * module does not model, and for a known tag whose payload does not validate.
 * Never throws — see the module header for why an auxiliary payload degrades
 * instead of failing the session.
 */
export function parseTraceEvent(
  obj: Record<string, unknown>,
  instr: readonly unknown[],
  lineNo: number,
): TraceEvent | undefined {
  try {
    return strictParseTraceEvent(obj, instr, lineNo);
  } catch (e) {
    if (e instanceof TraceParseError) {
      return undefined;
    }
    throw e;
  }
}

/**
 * The event parser with validation failures left to propagate as
 * `TraceParseError`. This is the pinned payload contract (the tests call it
 * directly); production parsing goes through the tolerant `parseTraceEvent`.
 *
 * `instr` is the record's already-validated instruction array; `obj` is the raw
 * record object, which carries the event's extra keys.
 */
export function strictParseTraceEvent(
  obj: Record<string, unknown>,
  instr: readonly unknown[],
  lineNo: number,
): TraceEvent | undefined {
  const tag = instr[0];
  if (typeof tag !== 'string') {
    return undefined;
  }

  switch (tag) {
    case 'ledger':
      return {
        kind: 'ledger',
        sequence: reqInt(obj, 'sequence', lineNo, tag),
        timestamp: reqInt(obj, 'timestamp', lineNo, tag),
        accounts: objectList(obj, 'accounts', lineNo, tag).map((entry) => ({
          account: reqAddress(entry, 'account', lineNo, tag),
          balance: reqInt(entry, 'balance', lineNo, tag),
        })),
        contracts: objectList(obj, 'contracts', lineNo, tag).map((entry) => ({
          contract: reqAddress(entry, 'contract', lineNo, tag),
          wasmHash: reqHex(entry, 'wasmHash', lineNo, tag),
          liveUntil: reqInt(entry, 'liveUntil', lineNo, tag),
          storage: storageList(entry, 'storage', lineNo, tag),
        })),
        codes: objectList(obj, 'codes', lineNo, tag).map((entry) => ({
          hash: reqHex(entry, 'hash', lineNo, tag),
          liveUntil: reqInt(entry, 'liveUntil', lineNo, tag),
        })),
      };

    case 'callContract':
      return {
        kind: 'callContract',
        from: reqAddress(obj, 'from', lineNo, tag),
        to: reqAddress(obj, 'to', lineNo, tag),
        function: reqString(obj, 'function', lineNo, tag),
        args: scValList(obj, 'args', lineNo, tag),
        depth: reqInt(obj, 'depth', lineNo, tag),
        storage: storageList(obj, 'storage', lineNo, tag),
      };

    // komet spells the trap path `endWasm-error` and the success path `endWasm`;
    // both are call exits and differ only in the `success` flag they carry.
    case 'endWasm':
    case 'endWasm-error':
      return {
        kind: 'endWasm',
        success: reqBool(obj, 'success', lineNo, tag),
        depth: reqInt(obj, 'depth', lineNo, tag),
        result: obj.result === null || obj.result === undefined
          ? null
          : reqScVal(obj, 'result', lineNo, tag),
      };

    case 'contractData': {
      const op = instr[1];
      if (op !== 'put' && op !== 'del' && op !== 'get' && op !== 'has') {
        // An op this adapter does not model: treat the record as a plain one
        // rather than throwing, so a producer may add ops freely.
        return undefined;
      }
      const args = scValList(obj, 'args', lineNo, tag);
      if (args.length === 0) {
        fail(lineNo, `${tag} event: '${op}' needs a key argument`);
      }
      if (op === 'put' && args.length < 2) {
        fail(lineNo, `${tag} event: 'put' needs both a key and a value argument`);
      }
      const event: Extract<TraceEvent, { kind: 'contractData' }> = {
        kind: 'contractData',
        op,
        durability: reqDurability(instr[2], lineNo, tag),
        contract: reqAddress(obj, 'contract', lineNo, tag),
        key: args[0],
      };
      if (op === 'put') {
        event.value = args[1];
      }
      if (obj.result !== undefined) {
        event.result = obj.result === null ? null : reqScVal(obj, 'result', lineNo, tag);
      }
      return event;
    }

    case 'contractTtl': {
      const target = instr[1];
      if (target === 'data') {
        return {
          kind: 'contractTtl',
          target,
          contract: reqAddress(obj, 'contract', lineNo, tag),
          durability: reqDurability(obj.durability, lineNo, tag),
          key: reqScVal(obj, 'key', lineNo, tag),
          liveUntil: reqInt(obj, 'liveUntil', lineNo, tag),
        };
      }
      if (target === 'instance') {
        return {
          kind: 'contractTtl',
          target,
          contract: reqAddress(obj, 'contract', lineNo, tag),
          liveUntil: reqInt(obj, 'liveUntil', lineNo, tag),
        };
      }
      if (target === 'code') {
        return {
          kind: 'contractTtl',
          target,
          hash: reqHex(obj, 'hash', lineNo, tag),
          liveUntil: reqInt(obj, 'liveUntil', lineNo, tag),
        };
      }
      return undefined;
    }

    case 'contractCode':
      return {
        kind: 'contractCode',
        contract: reqAddress(obj, 'contract', lineNo, tag),
        wasmHash: reqHex(obj, 'wasmHash', lineNo, tag),
      };

    case 'deployContract':
      return {
        kind: 'deployContract',
        contract: reqAddress(obj, 'contract', lineNo, tag),
        wasmHash: reqHex(obj, 'wasmHash', lineNo, tag),
        liveUntil: reqInt(obj, 'liveUntil', lineNo, tag),
      };

    case 'account':
      return {
        kind: 'account',
        account: reqAddress(obj, 'account', lineNo, tag),
        balance: reqInt(obj, 'balance', lineNo, tag),
      };

    case 'ledgerInfo':
      return {
        kind: 'ledgerInfo',
        sequence: reqInt(obj, 'sequence', lineNo, tag),
        timestamp: reqInt(obj, 'timestamp', lineNo, tag),
      };

    case 'addObject':
      return {
        kind: 'addObject',
        index: reqInt(obj, 'index', lineNo, tag),
        value: reqScVal(obj, 'value', lineNo, tag),
      };

    case 'hostCall': {
      const module = instr[1];
      const fn = instr[2];
      if (typeof module !== 'string' || typeof fn !== 'string') {
        fail(lineNo, `${tag} event: instr must be ["hostCall", module, function]`);
      }
      return { kind: 'hostCall', module, function: fn };
    }

    default:
      return undefined;
  }
}
