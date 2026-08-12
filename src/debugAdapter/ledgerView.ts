/**
 * The ledger presentation shared by both consumers of `LedgerImage`: the DAP
 * session's Ledger scope and the CLI's per-stop projection
 * (docs/state-inspection.md, "Presentation").
 *
 * `ledgerSnapshot` answers, in one place, *what* a stop shows — the executing
 * contract and its instance metadata, that contract's storage, the accounts, the
 * ledger scalars, the host object table, the open calls. Both views ask the same
 * questions of the image, so asking them once keeps the two from drifting on
 * details like "storage is scoped to the executing contract".
 *
 * `ledgerNodes` then renders that snapshot as a `ChildVar` tree — the same shape
 * the DWARF value decoder produces — so the session can hand it straight to its
 * existing `toDapVariable` plumbing (lazy children behind handles) without any
 * ledger-specific code of its own. The CLI keeps its own typed JSON schema and
 * reads the snapshot directly.
 *
 * Pure module (no `vscode` / DAP imports).
 */

import {
  LedgerImage,
  LedgerAccount,
  LedgerCallFrame,
  LedgerContract,
  LedgerHostObject,
  LedgerInfo,
  LedgerStorageEntry,
} from './LedgerImage';
import { Durability } from '../komet/trace';
import { ChildVar, DecodedValue } from '../dwarf/ValueDecoder';
import {
  renderAccount,
  renderAddress,
  renderContract,
  renderScVal,
  summarizeScVal,
} from '../soroban/scvalJson';

/** Everything a single stop shows of the ledger. */
export interface LedgerSnapshot {
  /** The executing contract as lowercase hex, or undefined before any call. */
  contract?: string;
  /** That contract's instance metadata, when the ledger knows it. */
  instance?: LedgerContract;
  /** Storage of the executing contract only, ordered by durability then key. */
  storage: LedgerStorageEntry[];
  accounts: LedgerAccount[];
  /** Ledger sequence/timestamp, absent when the trace never states them (L10). */
  info?: LedgerInfo;
  hostObjects: LedgerHostObject[];
  /** Open contract calls, innermost first (L6). */
  callStack: LedgerCallFrame[];
}

/** What the ledger shows at `cursor`. */
export function ledgerSnapshot(ledger: LedgerImage, cursor: number): LedgerSnapshot {
  const contract = ledger.executingContractAt(cursor);
  const snapshot: LedgerSnapshot = {
    storage: ledger.storageAt(cursor, contract),
    accounts: ledger.accountsAt(cursor),
    hostObjects: ledger.hostObjectsAt(cursor),
    callStack: ledger.callStackAt(cursor),
  };
  if (contract !== undefined) {
    snapshot.contract = contract;
    snapshot.instance = ledger.contractsAt(cursor).find((c) => c.contract === contract);
  }
  const info = ledger.ledgerInfoAt(cursor);
  if (info !== undefined) {
    snapshot.info = info;
  }
  return snapshot;
}

/**
 * The six top-level nodes of the Ledger tree. Every node is expandable and its
 * children are built lazily, so nothing below a collapsed node is materialized;
 * a node with nothing to show still appears (as an empty container) so the tree
 * shape is stable across steps.
 */
export function ledgerNodes(snapshot: LedgerSnapshot): ChildVar[] {
  const { contract, instance, storage, accounts, info, hostObjects, callStack } = snapshot;

  // Storage groups by durability, keeping only the durabilities in play so the
  // tree does not show three empty folders for a contract using one.
  const byDurability = new Map<Durability, LedgerStorageEntry[]>();
  for (const entry of storage) {
    const group = byDurability.get(entry.durability);
    if (group) {
      group.push(entry);
    } else {
      byDurability.set(entry.durability, [entry]);
    }
  }

  return [
    container('Contract', contract === undefined ? 'unavailable' : renderContract(contract), () => {
      const children: ChildVar[] = [];
      if (contract !== undefined) {
        children.push({ name: 'id', value: { display: renderContract(contract) } });
      }
      if (instance) {
        children.push({ name: 'wasmHash', value: { display: instance.wasmHash } });
        children.push({ name: 'liveUntil', value: { display: String(instance.liveUntil) } });
      }
      return children;
    }),
    container('Storage', `${storage.length} entr${storage.length === 1 ? 'y' : 'ies'}`, () =>
      [...byDurability.entries()].map(([durability, entries]) => ({
        name: durability,
        value: {
          display: `${entries.length}`,
          children: () => entries.map(storageNode),
        },
      })),
    ),
    container('Accounts', `${accounts.length}`, () =>
      accounts.map((account) => ({
        name: renderAccount(account.account),
        value: { display: String(account.balance), typeName: 'stroops' },
      })),
    ),
    container('Ledger', info === undefined ? 'unavailable' : `#${info.sequence}`, () =>
      info === undefined
        ? []
        : [
            { name: 'sequence', value: { display: String(info.sequence) } },
            { name: 'timestamp', value: { display: formatTimestamp(info.timestamp) } },
          ],
    ),
    container('Host objects', `${hostObjects.length}`, () =>
      hostObjects.map((object) => ({ name: `[${object.index}]`, value: renderScVal(object.value) })),
    ),
    container('Call stack', `${callStack.length}`, () =>
      callStack.map((frame) => ({ name: `[${frame.depth}]`, value: callFrameValue(frame) })),
    ),
  ];
}

/** A named, always-expandable node with a lazily built child list. */
function container(name: string, summary: string, children: () => ChildVar[]): ChildVar {
  return { name, value: { display: summary, children } };
}

/**
 * One storage entry: named by its key, valued by its value, and expandable to
 * the value's own structure plus the entry's TTL.
 */
function storageNode(entry: LedgerStorageEntry): ChildVar {
  const value = renderScVal(entry.value);
  const nested = value.children;
  return {
    name: summarizeScVal(entry.key),
    value: {
      display: value.display,
      typeName: value.typeName,
      children: () => [
        ...(nested ? nested() : []),
        { name: 'liveUntil', value: { display: String(entry.liveUntil) } },
      ],
    },
  };
}

/**
 * One open contract call, summarized as `to.function(args)` and expandable to
 * its parts. Addresses render as strkeys, the form that appears in contract
 * source and CLI output.
 */
function callFrameValue(frame: LedgerCallFrame): DecodedValue {
  const args = frame.args.map((arg) => renderScVal(arg).display).join(', ');
  return {
    display: `${renderAddress(frame.to)}.${frame.function}(${args})`,
    children: () => [
      { name: 'from', value: { display: renderAddress(frame.from) } },
      { name: 'to', value: { display: renderAddress(frame.to) } },
      { name: 'function', value: { display: frame.function } },
      { name: 'depth', value: { display: String(frame.depth) } },
      {
        name: 'args',
        value: {
          display: `[${frame.args.length}]`,
          ...(frame.args.length > 0
            ? {
                children: () =>
                  frame.args.map((arg, i) => ({ name: `[${i}]`, value: renderScVal(arg) })),
              }
            : {}),
        },
      },
    ],
  };
}

/** A ledger close time as both its raw seconds and an ISO instant. */
function formatTimestamp(timestamp: number): string {
  const iso = new Date(timestamp * 1000).toISOString();
  return `${timestamp} (${iso})`;
}
