/**
 * Derives, per trace record, the contract whose code is executing at it.
 *
 * A traced transaction interleaves the root contract with its cross-contract
 * sub-calls, and a callee's `pos` values collide with the caller's — small code
 * offsets in a different binary's address space. Knowing which contract a record
 * belongs to is what lets `debugAdapter/artifacts.ts` gate foreign records out of
 * the root contract's disassembly and DWARF.
 *
 * The trace already carries this: a `callContract` event names its callee and an
 * `endWasm` event closes it. So the contract is a fold over those boundaries
 * rather than anything the backend needs to send, and deriving it here keeps
 * komet-node a thin pass-through over komet's trace file — it used to stamp an
 * `executingContract` field onto every served record, which duplicated ~87 bytes
 * of derivable data per record on traces that already run to hundreds of
 * megabytes.
 *
 * Boundary timing matches `LedgerImage`'s call stack (docs/state-inspection.md,
 * L15): a `callContract` record is itself attributed to the callee it opens, and
 * an `endWasm` record to the callee it closes. `LedgerImage.executingContractAt`
 * answers the same question per cursor off its richer frame stack; the two are
 * pinned against each other in the tests.
 *
 * Pure module (no `vscode` / DAP imports).
 */

import { TraceRecord } from './trace';

/**
 * The executing contract at each record, as lowercase hex, or `null` where no
 * call is open — records before the first `callContract` (the ledger baseline,
 * host object allocations), and every record of a trace that carries no call
 * boundaries at all, which is how an older or event-less trace stays ungated.
 *
 * The returned array is index-aligned with `records`.
 */
export function executingContracts(records: readonly TraceRecord[]): (string | null)[] {
  const contracts: (string | null)[] = new Array<string | null>(records.length);
  const open: string[] = [];

  for (let i = 0; i < records.length; i++) {
    const event = records[i].event;

    // Opening a call attributes the `callContract` record itself to the callee,
    // so the whole callee span carries it.
    if (event?.kind === 'callContract') {
      open.push(event.to.value);
    }

    contracts[i] = open.length > 0 ? open[open.length - 1] : null;

    // Closing attributes the `endWasm` record to the callee that is finishing,
    // then returns to the caller. komet emits one `endWasm` for a normal return
    // and a trap alike, so the pop ignores `success`. The guard covers an
    // unmatched exit marker: a trace can be a prefix of a run.
    if (event?.kind === 'endWasm' && open.length > 0) {
      open.pop();
    }
  }

  return contracts;
}
