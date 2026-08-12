/**
 * A serializable projection of one trace stop (docs/trace-cli-internal.md,
 * "projectSourceStop"). Unlike the DAP handlers — whose lazy `Handles` /
 * child-thunk machinery is deliberately different — this reuses only the
 * low-level resolver calls and expands `DecodedValue.children` EAGERLY into
 * plain arrays, bounded by a per-stop depth/child/node budget.
 *
 * Pure module (no `vscode`, no DAP imports).
 */

import { ResolvedTrace } from '../debugAdapter/types';
import { StopModel, pcAtIndex } from '../debugAdapter/stopModel';
import { makeRuntimeState } from '../debugAdapter/runtimeState';
import { renderInstr } from '../komet/mnemonics';
import { DecodedValue } from '../dwarf/ValueDecoder';
import { LedgerImage } from '../debugAdapter/LedgerImage';
import { ledgerSnapshot } from '../debugAdapter/ledgerView';
import {
  renderAccount,
  renderAddress,
  renderContract,
  renderScVal,
  summarizeScVal,
} from '../soroban/scvalJson';
import { Durability } from '../komet/trace';

/** A serializable single-stop projection. */
export interface SourceStop {
  /** 0-based ordinal among source stops. */
  step: number;
  /** Index into model.records. */
  traceIndex: number;
  /** stopModel.depths[traceIndex]. */
  depth: number;
  /** Hex, e.g. "0x2d", or null. */
  pc: string | null;
  /** functionNameAt(pc), or null. */
  function: string | null;
  /** renderInstr(record.instr). */
  instr: string;
  /** Mapped source location, or null when unmapped. */
  source: { path: string; line: number; column?: number } | null;
  variables: TraceVar[];
  /**
   * The executing module's wasm globals, keyed by MODULE-RELATIVE global index
   * (docs/state-inspection.md, G1). Omitted entirely when the record carries
   * none, rather than emitted empty (G4).
   */
  globals?: Record<string, { type: string; value: string }>;
  /**
   * Stellar ledger state at this stop. Omitted entirely when the trace carries
   * no ledger information (L14).
   */
  ledger?: StopLedger;
}

/** The ledger projection of one stop (docs/state-inspection.md, Presentation). */
export interface StopLedger {
  /** Executing contract as a `C…` strkey, or null before any contract call. */
  contract: string | null;
  storage: StopStorageEntry[];
  accounts: { account: string; balance: number }[];
  /** Ledger sequence/timestamp, omitted when the trace never states them. */
  info?: { sequence: number; timestamp: number };
  hostObjects: { index: number; value: string }[];
  /** Open contract calls, innermost first. */
  callStack: {
    from: string;
    to: string;
    function: string;
    depth: number;
    args: string[];
  }[];
}

/** One storage entry of a stop's ledger projection. */
export interface StopStorageEntry {
  durability: Durability;
  /** Compact `type(value)` form of the key. */
  key: string;
  /** Display form of the value. */
  value: string;
  liveUntil: number;
  /**
   * Set only when this stop was projected with a `previousIndex` AND the entry
   * changed across that span. DAP has no vocabulary for "this changed", so the
   * flag exists here, where a consumer diffing two stops needs it.
   */
  changed?: boolean;
}

/** One decoded variable, eagerly expanded within budget. */
export interface TraceVar {
  /** "<anon>" when DWARF gives none. */
  name: string;
  /** The type's display name; "" when the decoder supplies none. */
  type: string;
  value: string;
  /** Present only when expandable and within budget. */
  children?: TraceVar[];
  /** Marker set when the budget cut expansion. */
  truncated?: boolean;
}

/** Per-stop expansion budget. */
export interface ProjectOpts {
  maxDepth?: number;
  maxChildren?: number;
  maxNodes?: number;
  /**
   * The previous stop's trace index. Supplying it turns on the `changed` flag on
   * storage entries that moved since then; without it no entry is flagged.
   */
  previousIndex?: number;
}

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_CHILDREN = 64;
const DEFAULT_MAX_NODES = 1500;

/** Mutable per-call node counter so a per-stop budget stays isolated. */
interface NodeCounter {
  count: number;
}

/**
 * Expand a decoded value into a serializable TraceVar, materializing children
 * eagerly up to the depth/child/node budget.
 */
function expandDecoded(
  name: string,
  decoded: DecodedValue,
  depth: number,
  maxDepth: number,
  maxChildren: number,
  maxNodes: number,
  counter: NodeCounter,
): TraceVar {
  const node: TraceVar = { name, type: decoded.typeName ?? '', value: decoded.display };

  if (typeof decoded.children === 'function') {
    if (depth >= maxDepth || counter.count >= maxNodes) {
      node.truncated = true;
      return node;
    }
    const rawChildren = decoded.children();
    if (rawChildren.length === 0) {
      // Genuinely empty — omit the `children` key entirely.
      return node;
    }
    const children: TraceVar[] = [];
    const limit = Math.min(rawChildren.length, maxChildren);
    for (let i = 0; i < limit; i++) {
      counter.count++;
      const child = rawChildren[i];
      children.push(
        expandDecoded(
          child.name,
          child.value,
          depth + 1,
          maxDepth,
          maxChildren,
          maxNodes,
          counter,
        ),
      );
    }
    if (rawChildren.length > maxChildren) {
      children.push({ name: '…', type: '', value: '…', truncated: true });
    }
    node.children = children;
  }

  return node;
}

/**
 * Project the stop at `index` into a serializable `SourceStop`, reusing the
 * low-level resolver calls and eagerly expanding decoded variable trees.
 */
export function projectSourceStop(
  resolved: ResolvedTrace,
  stopModel: StopModel,
  index: number,
  opts?: ProjectOpts,
): SourceStop {
  const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxChildren = opts?.maxChildren ?? DEFAULT_MAX_CHILDREN;
  const maxNodes = opts?.maxNodes ?? DEFAULT_MAX_NODES;

  const record = resolved.model.records[index];

  const mapped = resolved.source.locationForIndex(index);
  let source: SourceStop['source'] = null;
  if (mapped) {
    source = { path: mapped.path, line: mapped.line };
    if (mapped.column !== undefined && mapped.column !== null) {
      source.column = mapped.column;
    }
  }

  const pc = pcAtIndex(resolved.positions, index);
  const pcHex = pc === null ? null : '0x' + pc.toString(16);
  const functionName = pc === null ? null : (resolved.variables.functionNameAt(pc) ?? null);

  const variables: TraceVar[] = [];
  if (pc !== null && resolved.variables.hasVariables()) {
    const memory = resolved.model.memory;
    const state = makeRuntimeState(record, memory, index);
    const counter: NodeCounter = { count: 0 };
    for (const v of resolved.variables.variablesInScope(pc)) {
      const decoded = resolved.variables.decodeVariable(v, state, pc);
      variables.push(
        expandDecoded(v.name ?? '<anon>', decoded, 0, maxDepth, maxChildren, maxNodes, counter),
      );
    }
  }

  const step = stopModel.runStarts.indexOf(index);

  const stop: SourceStop = {
    step,
    traceIndex: index,
    depth: stopModel.depths[index],
    pc: pcHex,
    function: functionName,
    instr: renderInstr(record.instr),
    source,
    variables,
  };

  // G4: present only when this record actually carries globals.
  if (record.globals !== undefined) {
    const globals: Record<string, { type: string; value: string }> = {};
    for (const [slot, [type, value]] of Object.entries(record.globals)) {
      globals[slot] = { type, value: String(value) };
    }
    stop.globals = globals;
  }

  // L14: present only when the trace carries ledger information.
  const ledger = resolved.model.ledger;
  if (ledger.hasLedger()) {
    stop.ledger = projectLedger(ledger, index, opts?.previousIndex);
  }

  return stop;
}

/**
 * Flatten the shared ledger snapshot at `index` into the CLI's JSON schema,
 * flagging the storage entries that moved since `previousIndex`.
 */
function projectLedger(
  ledger: LedgerImage,
  index: number,
  previousIndex?: number,
): StopLedger {
  const { contract, storage, accounts, info, hostObjects, callStack } = ledgerSnapshot(
    ledger,
    index,
  );
  const changed =
    previousIndex === undefined ? undefined : ledger.changedSince(previousIndex, index);

  const projected: StopLedger = {
    contract: contract === undefined ? null : renderContract(contract),
    storage: storage.map((entry) => {
      const projectedEntry: StopStorageEntry = {
        durability: entry.durability,
        key: summarizeScVal(entry.key),
        value: renderScVal(entry.value).display,
        liveUntil: entry.liveUntil,
      };
      if (changed?.has(entry.id)) {
        projectedEntry.changed = true;
      }
      return projectedEntry;
    }),
    accounts: accounts.map((account) => ({
      account: renderAccount(account.account),
      balance: account.balance,
    })),
    hostObjects: hostObjects.map((object) => ({
      index: object.index,
      value: renderScVal(object.value).display,
    })),
    callStack: callStack.map((frame) => ({
      from: renderAddress(frame.from),
      to: renderAddress(frame.to),
      function: frame.function,
      depth: frame.depth,
      args: frame.args.map((arg) => renderScVal(arg).display),
    })),
  };
  if (info !== undefined) {
    projected.info = info;
  }
  return projected;
}
