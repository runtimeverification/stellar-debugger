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

const EVEN_LENGTH_HEX = /^([0-9a-f]{2})*$/;

/**
 * Whether `v` is the lowercase, even-length hex the trace encodes raw bytes as
 * (addresses, wasm hashes, memory runs). Shared with `trace.ts`, which applies
 * the same rule to an instruction record's `mem` runs.
 */
export function isEvenLengthHex(v: unknown): v is string {
  return typeof v === 'string' && EVEN_LENGTH_HEX.test(v);
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Typed reader over one event record's fields, bound to the trace line and event
 * kind so every rejection names them without the call sites having to. Each
 * accessor states what the field must be; anything else throws
 * `TraceParseError`. Nested objects are read through a child reader whose paths
 * are prefixed (`accounts[0].account`), so an error points at the exact field.
 */
class Fields {
  constructor(
    private readonly obj: Obj,
    private readonly lineNo: number,
    private readonly kind: string,
    private readonly prefix = '',
  ) {}

  /** Reject this record, naming the trace line, the event kind, and `what`. */
  fail(what: string, expectation: string): never {
    throw new TraceParseError(
      `trace line ${this.lineNo}: ${this.kind} event: '${this.prefix}${what}' ${expectation}`,
    );
  }

  /** The raw value of a field, for the few checks that are not a type test. */
  raw(key: string): unknown {
    return this.obj[key];
  }

  int(key: string): number {
    const v = this.obj[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.fail(key, 'must be a number');
    }
    return v;
  }

  string(key: string): string {
    const v = this.obj[key];
    if (typeof v !== 'string') {
      this.fail(key, 'must be a string');
    }
    return v;
  }

  hex(key: string): string {
    const v = this.string(key);
    if (!isEvenLengthHex(v)) {
      this.fail(key, 'must be an even-length lowercase-hex string');
    }
    return v;
  }

  bool(key: string): boolean {
    const v = this.obj[key];
    if (typeof v !== 'boolean') {
      this.fail(key, 'must be a boolean');
    }
    return v;
  }

  durability(key = 'durability'): Durability {
    const v = this.obj[key];
    if (typeof v !== 'string' || !DURABILITIES.has(v)) {
      this.fail(key, 'must be one of instance/persistent/temporary');
    }
    return v as Durability;
  }

  address(key: string): TraceAddress {
    return this.toAddress(this.obj[key], key);
  }

  scVal(key: string): ScValJson {
    return this.toScVal(this.obj[key], key);
  }

  /** A JSON array of `ScVal`s; an absent key is an empty list. */
  scVals(key: string): ScValJson[] {
    return this.array(key).map((item, i) => this.toScVal(item, `${key}[${i}]`));
  }

  /** A `[{durability, key, value, liveUntil}]` array; absent means empty. */
  storage(key: string): StorageEntry[] {
    return this.objects(key).map((entry) => ({
      durability: entry.durability(),
      key: entry.scVal('key'),
      value: entry.scVal('value'),
      liveUntil: entry.int('liveUntil'),
    }));
  }

  /** An array of objects, each as its own path-prefixed reader; absent means empty. */
  objects(key: string): Fields[] {
    return this.array(key).map((entry, i) => {
      const path = `${key}[${i}]`;
      if (!isObj(entry)) {
        this.fail(path, 'must be an object');
      }
      return new Fields(entry, this.lineNo, this.kind, `${this.prefix}${path}.`);
    });
  }

  private array(key: string): unknown[] {
    const raw = this.obj[key] ?? [];
    if (!Array.isArray(raw)) {
      this.fail(key, 'must be an array');
    }
    return raw;
  }

  /** Validate an address object down to `{ addrType, value }`. */
  private toAddress(value: unknown, what: string): TraceAddress {
    if (!isObj(value)) {
      this.fail(what, 'must be an address object');
    }
    const addrType = value.addrType;
    if (addrType !== 'account' && addrType !== 'contract') {
      this.fail(`${what}.addrType`, 'must be "account" or "contract"');
    }
    const raw = value.value;
    if (!isEvenLengthHex(raw)) {
      this.fail(`${what}.value`, 'must be an even-length lowercase-hex string');
    }
    return { addrType, value: raw };
  }

  /**
   * Validate an `ScVal` object. Types this module knows the shape of are checked
   * exactly; any other type is accepted as long as it carries a `value`, so a
   * new komet `ScVal` renders generically instead of failing the session.
   */
  private toScVal(value: unknown, what: string, depth = 0): ScValJson {
    if (!isObj(value) || typeof value.type !== 'string') {
      this.fail(what, "must be an ScVal object with a string 'type'");
    }
    const type = value.type;
    if (type === 'void') {
      return { type };
    }
    if (type === 'address') {
      const address = this.toAddress(value, what);
      return { type, addrType: address.addrType, value: address.value };
    }
    if (type === 'error') {
      const nested = new Fields(value, this.lineNo, this.kind, `${this.prefix}${what}.`);
      return { type, errType: nested.string('errType'), code: nested.int('code') };
    }
    if (value.value === undefined) {
      this.fail(what, `of type "${type}" must carry a 'value'`);
    }
    if (depth < MAX_SCVAL_DEPTH && (type === 'vec' || type === 'map')) {
      if (!Array.isArray(value.value)) {
        this.fail(what, `of type "${type}" must carry an array 'value'`);
      }
      if (type === 'vec') {
        return {
          type,
          value: value.value.map((item, i) => this.toScVal(item, `${what}[${i}]`, depth + 1)),
        };
      }
      return {
        type,
        value: value.value.map((entry, i) => {
          if (!Array.isArray(entry) || entry.length !== 2) {
            this.fail(`${what}[${i}]`, 'must be a [key, value] pair');
          }
          return [
            this.toScVal(entry[0], `${what}[${i}].key`, depth + 1),
            this.toScVal(entry[1], `${what}[${i}].value`, depth + 1),
          ];
        }),
      };
    }
    // Validated above: `type` is a string. Any other shape (a komet ScVal type
    // this module does not model) passes through for generic rendering.
    return { ...value, type } as ScValJson;
  }
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
export function parseTraceEvent(obj: Obj, kind: string, lineNo: number): TraceEvent | undefined {
  const f = new Fields(obj, lineNo, kind);
  switch (kind) {
    case 'ledger':
      return {
        kind: 'ledger',
        sequence: f.int('sequence'),
        timestamp: f.int('timestamp'),
        accounts: f.objects('accounts').map((a) => ({
          account: a.address('account'),
          balance: a.int('balance'),
        })),
        contracts: f.objects('contracts').map((c) => ({
          contract: c.address('contract'),
          wasmHash: c.hex('wasmHash'),
          liveUntil: c.int('liveUntil'),
          storage: c.storage('storage'),
        })),
        codes: f.objects('codes').map((c) => ({
          hash: c.hex('hash'),
          liveUntil: c.int('liveUntil'),
        })),
      };

    case 'callContract':
      return {
        kind: 'callContract',
        from: f.address('from'),
        to: f.address('to'),
        function: f.string('function'),
        args: f.scVals('args'),
        depth: f.int('depth'),
        storage: f.storage('storage'),
      };

    // One record closes a call whether it returned or trapped; `success` is what
    // tells the two apart.
    case 'endWasm':
      return {
        kind: 'endWasm',
        success: f.bool('success'),
        depth: f.int('depth'),
        result: f.raw('result') == null ? null : f.scVal('result'),
      };

    case 'contractData': {
      const op = f.raw('operation');
      if (op !== 'put' && op !== 'del') {
        // A read (`get`/`has`), or an op a future producer adds: it moves
        // nothing, so the record parses as a plain one rather than throwing.
        return undefined;
      }
      const args = f.scVals('args');
      if (args.length < (op === 'put' ? 2 : 1)) {
        f.fail('args', op === 'put' ? 'needs a key and a value' : 'needs a key');
      }
      return {
        kind: 'contractData',
        op,
        durability: f.durability(),
        contract: f.address('contract'),
        key: args[0],
        ...(op === 'put' ? { value: args[1] } : {}),
      };
    }

    case 'contractTtl':
      switch (f.raw('target')) {
        case 'data':
          return {
            kind: 'contractTtl',
            target: 'data',
            contract: f.address('contract'),
            durability: f.durability(),
            key: f.scVal('key'),
            liveUntil: f.int('liveUntil'),
          };
        case 'instance':
          return {
            kind: 'contractTtl',
            target: 'instance',
            contract: f.address('contract'),
            liveUntil: f.int('liveUntil'),
          };
        case 'code':
          return {
            kind: 'contractTtl',
            target: 'code',
            hash: f.hex('hash'),
            liveUntil: f.int('liveUntil'),
          };
        default:
          return undefined;
      }

    case 'contractCode':
      return {
        kind: 'contractCode',
        contract: f.address('contract'),
        wasmHash: f.hex('wasmHash'),
      };

    case 'deployContract':
      return {
        kind: 'deployContract',
        contract: f.address('contract'),
        wasmHash: f.hex('wasmHash'),
        liveUntil: f.int('liveUntil'),
      };

    case 'account':
      return {
        kind: 'account',
        account: f.address('account'),
        balance: f.int('balance'),
      };

    case 'ledgerInfo':
      return {
        kind: 'ledgerInfo',
        sequence: f.int('sequence'),
        timestamp: f.int('timestamp'),
      };

    case 'addObject':
      return {
        kind: 'addObject',
        index: f.int('index'),
        value: f.scVal('value'),
      };

    default:
      return undefined;
  }
}
