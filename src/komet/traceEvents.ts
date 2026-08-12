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
 * What is modelled is exactly what the state views consume: the events that MOVE
 * the ledger, plus the call boundaries that scope it. Records that move nothing
 * — a storage read, a host call — yield no event, and still parse (and render)
 * as ordinary records. Modelling one is a local change here plus a consumer that
 * reads it, so nothing is carried speculatively.
 *
 * A record is identified by its `kind`, and each event's operands are named
 * fields of the record — `operation`/`durability` on a storage write, say. An
 * instruction record has no event; `kind: "instr"` falls through to `undefined`
 * like any tag this module does not model.
 *
 * Unlike the core record fields, an event payload is **auxiliary**: stepping,
 * breakpoints and source mapping do not depend on it, only the state views do.
 * So `parseTraceEvent` states the payload contract strictly — a malformed
 * payload throws `TraceParseError` — and `trace.ts` inverts its own fail-loudly
 * policy at the single call site, swallowing that error so the record still
 * parses as an ordinary one and the state views degrade exactly as G4/L14
 * prescribe. A komet release that adds or reshapes an event can therefore never
 * break a debug session, and partial event records (as the mocks and fixtures in
 * the test suite build) stay acceptable.
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
      /** Only the mutating ops are modelled; a read moves nothing (see header). */
      op: 'put' | 'del';
      durability: Durability;
      contract: TraceAddress;
      key: ScValJson;
      /** Present for `put`. */
      value?: ScValJson;
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
  | { kind: 'addObject'; index: number; value: ScValJson };

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
 * Parse the event payload of a trace record. Returns `undefined` for an ordinary
 * instruction record and for an event tag this module does not model; THROWS
 * `TraceParseError` on a modelled tag whose payload does not validate, which is
 * the pinned payload contract. Production parsing goes through `trace.ts`, which
 * degrades that error to `undefined` (see the module header).
 *
 * `kind` is the record's already-validated kind; `obj` is the raw record object,
 * which carries the event's own fields.
 */
export function parseTraceEvent(
  obj: Record<string, unknown>,
  kind: string,
  lineNo: number,
): TraceEvent | undefined {
  switch (kind) {
    case 'ledger':
      return {
        kind: 'ledger',
        sequence: reqInt(obj, 'sequence', lineNo, kind),
        timestamp: reqInt(obj, 'timestamp', lineNo, kind),
        accounts: objectList(obj, 'accounts', lineNo, kind).map((entry) => ({
          account: reqAddress(entry, 'account', lineNo, kind),
          balance: reqInt(entry, 'balance', lineNo, kind),
        })),
        contracts: objectList(obj, 'contracts', lineNo, kind).map((entry) => ({
          contract: reqAddress(entry, 'contract', lineNo, kind),
          wasmHash: reqHex(entry, 'wasmHash', lineNo, kind),
          liveUntil: reqInt(entry, 'liveUntil', lineNo, kind),
          storage: storageList(entry, 'storage', lineNo, kind),
        })),
        codes: objectList(obj, 'codes', lineNo, kind).map((entry) => ({
          hash: reqHex(entry, 'hash', lineNo, kind),
          liveUntil: reqInt(entry, 'liveUntil', lineNo, kind),
        })),
      };

    case 'callContract':
      return {
        kind: 'callContract',
        from: reqAddress(obj, 'from', lineNo, kind),
        to: reqAddress(obj, 'to', lineNo, kind),
        function: reqString(obj, 'function', lineNo, kind),
        args: scValList(obj, 'args', lineNo, kind),
        depth: reqInt(obj, 'depth', lineNo, kind),
        storage: storageList(obj, 'storage', lineNo, kind),
      };

    // One record closes a call whether it returned or trapped; `success` is what
    // tells the two apart.
    case 'endWasm':
      return {
        kind: 'endWasm',
        success: reqBool(obj, 'success', lineNo, kind),
        depth: reqInt(obj, 'depth', lineNo, kind),
        result: obj.result === null || obj.result === undefined
          ? null
          : reqScVal(obj, 'result', lineNo, kind),
      };

    case 'contractData': {
      const op = obj.operation;
      if (op !== 'put' && op !== 'del') {
        // A read (`get`/`has`), or an op a future producer adds: it moves
        // nothing, so the record parses as a plain one rather than throwing.
        return undefined;
      }
      const args = scValList(obj, 'args', lineNo, kind);
      if (args.length === 0) {
        fail(lineNo, `${kind} event: '${op}' needs a key argument`);
      }
      if (op === 'put' && args.length < 2) {
        fail(lineNo, `${kind} event: 'put' needs both a key and a value argument`);
      }
      const event: Extract<TraceEvent, { kind: 'contractData' }> = {
        kind: 'contractData',
        op,
        durability: reqDurability(obj.durability, lineNo, kind),
        contract: reqAddress(obj, 'contract', lineNo, kind),
        key: args[0],
      };
      if (op === 'put') {
        event.value = args[1];
      }
      return event;
    }

    case 'contractTtl': {
      const target = obj.target;
      if (target === 'data') {
        return {
          kind: 'contractTtl',
          target,
          contract: reqAddress(obj, 'contract', lineNo, kind),
          durability: reqDurability(obj.durability, lineNo, kind),
          key: reqScVal(obj, 'key', lineNo, kind),
          liveUntil: reqInt(obj, 'liveUntil', lineNo, kind),
        };
      }
      if (target === 'instance') {
        return {
          kind: 'contractTtl',
          target,
          contract: reqAddress(obj, 'contract', lineNo, kind),
          liveUntil: reqInt(obj, 'liveUntil', lineNo, kind),
        };
      }
      if (target === 'code') {
        return {
          kind: 'contractTtl',
          target,
          hash: reqHex(obj, 'hash', lineNo, kind),
          liveUntil: reqInt(obj, 'liveUntil', lineNo, kind),
        };
      }
      return undefined;
    }

    case 'contractCode':
      return {
        kind: 'contractCode',
        contract: reqAddress(obj, 'contract', lineNo, kind),
        wasmHash: reqHex(obj, 'wasmHash', lineNo, kind),
      };

    case 'deployContract':
      return {
        kind: 'deployContract',
        contract: reqAddress(obj, 'contract', lineNo, kind),
        wasmHash: reqHex(obj, 'wasmHash', lineNo, kind),
        liveUntil: reqInt(obj, 'liveUntil', lineNo, kind),
      };

    case 'account':
      return {
        kind: 'account',
        account: reqAddress(obj, 'account', lineNo, kind),
        balance: reqInt(obj, 'balance', lineNo, kind),
      };

    case 'ledgerInfo':
      return {
        kind: 'ledgerInfo',
        sequence: reqInt(obj, 'sequence', lineNo, kind),
        timestamp: reqInt(obj, 'timestamp', lineNo, kind),
      };

    case 'addObject':
      return {
        kind: 'addObject',
        index: reqInt(obj, 'index', lineNo, kind),
        value: reqScVal(obj, 'value', lineNo, kind),
      };

    default:
      return undefined;
  }
}
