# State inspection semantics

> **Audience:** `contributor` · `maintainer` (replay/state engine)
>
> **TL;DR:** The precise contract for what state the debugger shows at a replay cursor beyond the wasm value stack and locals — the module's **wasm globals** (G1–G4) and the **Stellar ledger** (L1–L14): contract storage across all three durabilities with TTLs, account balances, ledger sequence/timestamp, contract instance metadata, the host object table, and the contract-call stack. Defines the trace-record contract each rule depends on, how state is reconstructed at an arbitrary cursor (including rollback of failed sub-calls), and how every rule degrades when a trace predates the field it needs.

The contract between the trace producer (komet's K semantics, carried verbatim by komet-node) and the debugger's state views: the `Globals` and `Ledger` scopes in the VS Code Variables view, the same scopes over the DAP server, and the `globals`/`ledger` projections in the `soroban-trace` CLI.
The test suite (`test/trace.test.ts`, `test/ledgerImage.test.ts`, `test/scvalJson.test.ts`, `test/dapLedger.test.ts`, `test/prop/ledgerImage.property.test.ts`) pins these rules; every rule ID below is cited by at least one test.

For how the cursor *moves*, see [`stepping.md`](stepping.md). This document is only about what is *visible* once it has come to rest.

## Model

### What the trace carries

komet's tracer emits one record per executed wasm instruction, interleaved with **Soroban VM event records** — records naming an operation rather than carrying the four-field instruction shape. The full set is documented in [komet's `docs/tracing.md`](https://github.com/runtimeverification/komet/blob/master/docs/tracing.md); the debugger consumes these:

| Tag | Carries | Feeds |
|---|---|---|
| *(instruction record)* | `globals` — the executing module's full globals | G1–G3 |
| `ledger` | whole-transaction baseline: sequence, timestamp, accounts, contracts (with storage + TTLs), code TTLs | L1, L9, L10 |
| `callContract` | `from`, `to`, `function`, `args`, `depth`, and the callee's full storage on entry | L1, L6 |
| `endWasm` | `success`, `depth`, `result` | L5, L6 |
| `contractData` | `put`/`del` with `contract`, durability, key and value | L2–L4 |
| `contractTtl` | `data`/`instance`/`code` TTL extension | L7 |
| `contractCode`, `deployContract` | a contract's wasm hash / a new contract instance | L8 |
| `account` | an account's balance | L9 |
| `ledgerInfo` | ledger sequence and timestamp | L10 |
| `addObject` | a host object and the table index it takes | L11 |

Event payloads are **auxiliary**: stepping, breakpoints and source mapping depend only on a record's core fields (`pos`/`instr`/`stack`/`locals`/`mem`), never on an event payload.
So payload parsing inverts the fail-loudly policy the core fields keep: an unrecognized tag, an event kind the adapter does not model, and a payload that does not validate all yield a record with **no** event payload, and the state views degrade per G4/L14.
What is modelled is exactly what the views above consume — the events that move the ledger, plus the call boundaries that scope it. A record that moves nothing (a storage read, a host call) carries no event payload and still renders as an ordinary record.
A komet release that adds or reshapes an event therefore cannot break a debug session.

A record states what it is in its top-level `kind`, and an event's operands are named fields of the record — `operation`/`durability` on a storage write, say. This is komet's format from v0.1.87 on; a record without a `kind` is rejected rather than guessed at, so a trace recorded against an older komet has to be re-recorded.
The payload contract itself is strict — `parseTraceEvent` throws on a malformed modelled payload, and the tests pin it there; the degradation above is `trace.ts` swallowing that error at its single call site.
A malformed *core* field remains a hard error.

### Ledger state at a cursor

The **ledger image** at a cursor is a pure function of the records at or before it. It has six components:

- **storage** — entries keyed by `(contract, durability, key)`, each with a value and a `liveUntil`. The three durabilities are disjoint key spaces (L3).
- **accounts** — `accountId → balance` (stroops).
- **contracts** — `contractId → { wasmHash, liveUntil }`.
- **codes** — `codeHash → liveUntil`.
- **ledger info** — `{ sequence, timestamp }`.
- **host objects** — the ordered object table (L11).

The first five are **world state**: the semantics push a copy on every `callContract` and restore it if that call fails (`popWorldState`), so the debugger must undo a failed sub-call's effects (L5).
The host object table is deliberately *not* world state — it is monotonic and survives a failed call.

## Rules

### Globals

- **G1** (index space): the keys of an instruction record's `globals` map are **module-relative global indices** — the domain of the executing module's `globalAddrs`, the same index space DWARF's `DW_OP_WASM_location` global operand refers to. They are *not* store-level global addresses. A consumer may index `globals` directly with a DWARF global index without translation.
- **G2** (per-step presence): every instruction record carries the *complete* globals map of the module executing at that record, at instruction entry. Unlike `mem`, globals are **not** change-suppressed — there are only a handful per module, so a record never means "unchanged since the last one". Consequently the globals at a cursor come from that record alone, with no scan.
- **G3** (variable resolution): a DWARF variable whose location expression — or whose frame base — reads a global resolves against the record's `globals` at the cursor. This is the path that makes globally-frame-based functions (`DW_AT_frame_base` naming a global rather than the shadow-stack pointer in memory) yield real values instead of `<optimized out>`.
- **G4** (degradation): a record carrying no `globals` (a trace produced before the field existed) MUST NOT surface as an error or as zeros. The `Globals` scope is absent from the scopes list, and a global-backed variable reads `<optimized out>` exactly as it did before. Gating is decided **per record**, not per trace, so the scope is never shown empty; because the cursor only ever rests on an instruction record and G2 puts globals on every one of those, the scope does not flicker as a user steps.

### Ledger — construction

- **L1** (baseline precedence): the ledger image at a cursor is seeded, in order of preference, by (a) the last `ledger` baseline record at or before the cursor, else (b) the `storage` array of the innermost enclosing `callContract` record, which supplies that callee's storage only. With neither, there is no ledger image (L14). Precedence is per component: a `callContract` baseline seeds storage without claiming to know accounts or ledger info.
- **L2** (write replay): every `contractData` `put` / `del` event at or before the cursor applies in trace order — `put` inserts or overwrites `(contract, durability, key)`, `del` removes it. A `put` onto an existing key preserves nothing of the old entry but its identity.
- **L3** (durability separation): `instance`, `persistent` and `temporary` are disjoint key spaces. The same key written under two durabilities is two independent entries and both are visible.
- **L4** (contract attribution): a `contractData` event applies to the contract named in its own `contract` field, never to "the currently executing contract". Under reentrancy — A calls B calls back into A — B's and A's writes land on their own contracts.
- **L5** (rollback): when an `endWasm` record has `success: false`, every world-state change recorded strictly after its matching `callContract` is undone: storage, accounts, contracts and codes alike. The ledger image at the record after a failed call equals the image immediately before its `callContract`. A `success: true` `endWasm` keeps everything (the semantics' `dropWorldState`). Rollback nests: an inner failure inside an outer success discards only the inner call's effects.
- **L6** (call nesting): `callContract` and `endWasm` records pair up as a stack. The innermost open call at a cursor names the contract executing there, its function and arguments, and its depth. An unmatched trailing `callContract` (the root call, whose `endWasm` may be absent when a trace is a prefix) stays open to the end of the trace.
- **L7** (TTL): a `contractTtl` event updates a `liveUntil` in place and never changes a value: the `data` variant targets one storage entry, `instance` a contract's own instance TTL, `code` an uploaded code hash. A TTL event for an entry not in the image is ignored rather than fabricating an entry.
- **L8** (instance metadata): `deployContract` creates a contract entry with its wasm hash and instance TTL; `contractCode` replaces an existing contract's wasm hash, leaving its storage and TTL untouched.
- **L9** (accounts): an `account` event sets an account's balance, creating the account if absent. Within a single transaction, balances change *only* through these events — komet models no transfer or Stellar Asset Contract, so a contract call cannot move value. A balance shown at a cursor is therefore the ledger's balance, not a running total.
- **L10** (ledger info): a `ledgerInfo` event sets the sequence and timestamp; the `ledger` baseline seeds them. Absent both, ledger info is unavailable and its node is omitted rather than showing zeros.
- **L11** (host objects): the object table at a cursor is the sequence of `addObject` records at or before it, each placed at its own `index`. The table is monotonic and is **never** rolled back by L5 — it is not part of the pushed world state.

- **L15** (event timing): komet's tracer logs a record *before* the operation it describes executes — the same reason an instruction record's `stack` is the stack at instruction *entry*. So the two classes of event apply at different cursors:
  - a **snapshot** (`ledger`, and a `callContract`'s `storage`) describes the state as it already stands and applies **at** its own record, inclusive;
  - a **mutation** (`contractData put`/`del`, `contractTtl`, `contractCode`, `deployContract`, `account`, `ledgerInfo`, `addObject`, and an `endWasm`'s rollback or pop) has not happened yet at its own record and applies **from the next** record onward.

  Resting on a `contractData put` therefore shows the storage the write is about to overwrite — which is what makes stepping over a write show a before/after pair. Resting on a `callContract` shows the callee, its arguments and the storage it is about to run against.

### Ledger — queries

- **L12** (time symmetry): the image at a cursor depends only on the cursor, never on the path taken to reach it. Stepping forward to index *i*, or backward to *i* from beyond, yields identical state. This is the same guarantee `MemoryImage` gives for linear memory.
- **L13** (cost): state is materialized only at records that change it — events are rare relative to instructions — and a query resolves through a per-record index of the latest change at or before the cursor. Neither a query nor construction may copy the whole image per record.
- **L14** (degradation): a trace carrying no ledger information at all omits the `Ledger` scope entirely. It never appears as an empty tree, and no query throws: every accessor returns "unavailable" rather than a fabricated empty ledger, so an older trace behaves exactly as it did before this feature.

## Presentation

At a stop the scopes are, in order:

```
Variables      source-level DWARF variables   (existing; gated on DWARF functions)
Locals         wasm locals                    (existing)
Value Stack    wasm value stack               (existing)
Globals        wasm globals                   (G2; gated per G4)
Ledger         Stellar ledger state           (gated per L14)
  ├─ Contract      executing contract: id (C…), wasm hash, instance TTL
  ├─ Storage       instance / persistent / temporary → "key = value" (+ liveUntil)
  ├─ Accounts      G… → balance
  ├─ Ledger        sequence, timestamp
  ├─ Host objects  index → value
  └─ Call stack    from → to.function(args) per open call, innermost first
```

Children expand lazily through the adapter's existing handle mechanism, and handles are reset at every stop so a ref never outlives its cursor.

`ScVal`s render as a display string with expandable children where the value is composite — `Symbol(counter)`, `u32(5)`, `i128("340282366920938463463374607431768211455")`, `Address(C…)`, `Vec[3]`, `Map{2}`.
Addresses render as **strkeys** (`C…` for contracts, `G…` for accounts), not as the raw hex the trace carries, because that is the form that appears in contract source, CLI output and block explorers.

DAP's `VariablePresentationHint` has no vocabulary for "this changed", so the Variables view marks nothing: a user sees a moved value by stepping, as with every other scope.
The machine-readable CLI projection, which is not bound by that vocabulary, does carry an explicit `changed` flag per storage entry (`changedSince`), because a consumer diffing two stops cannot see the tree move.
