# Soroban Debugger (komet)

A **time-travel debugger for Stellar/Soroban smart contracts**, backed by
[`komet-node`](https://github.com/runtimeverification/komet-node) — Runtime
Verification's local Stellar testnet built on K formal semantics.

komet-node executes a whole transaction and returns the *entire* execution trace
as JSON Lines (one record per WebAssembly instruction) via its `traceTransaction`
RPC. This extension loads that trace and lets you **step forward and backward**
through the execution inside VSCode's debugger UI.

## Status

**Milestone M1 (done):** trace-replay debug adapter with time-travel.

- Parse a komet-node JSONL trace into an in-memory model.
- Full Debug Adapter Protocol session: breakpoints, step in/over/out, continue,
  **step back**, and **reverse continue** (`supportsStepBack`).
- Inspect the WASM value stack and locals-by-index at the current instruction.
- Replay a captured trace file directly via the `rawTrace` launch attribute
  (no running node required).

**Milestone M2 (done):** turnkey pipeline — one click from source to debug.

- `ContractBuilder` builds the contract (`stellar contract build`) and locates
  the wasm (`wasm32v1-none` / `wasm32-unknown-unknown`).
- `SorobanTxBuilder` builds the seed-account / upload-wasm / create-contract /
  invoke envelopes with `@stellar/stellar-sdk`, plus client-side contract-ID
  derivation. komet-node ignores sequence/fees/signatures/footprints, so there
  is no simulate step.
- `KometProcess` spawns/health-checks komet-node; `KometClient` speaks its
  JSON-RPC; `TurnkeyPipeline` orchestrates build → spawn → seed → deploy →
  invoke-with-trace → replay. `attach` mode connects to a running node.

See [the roadmap](#roadmap) for what's next.

## Verification

The replay logic and pipeline are exercised by 38 tests (`npm test`):

- **DAP protocol tests** drive the real adapter (capability, entry stop, forward
  and reverse stepping, locals/stack, run-to-breakpoint + reverse-continue).
- **tx-builder tests** decode every built envelope back with the SDK; envelopes
  are additionally cross-checked against the Stellar CLI's own XDR decoder.
- **pipeline tests** run `TurnkeyPipeline` against an in-process mock komet-node
  and assert the full deploy+invoke sequence and the parsed trace.
- **build integration test** (auto-skips without the toolchain) runs a real
  `stellar contract build` through `ContractBuilder`.

## Devcontainer toolchain

The devcontainer installs everything needed to run the pipeline end to end:
Rust + the wasm targets, the Stellar CLI, and `komet-node` (installed straight
from RV's binary cache with `kup install komet-node`, which also pulls the K
toolchain and the prebuilt semantics). See `.devcontainer/Dockerfile`.

## Architecture

The debug adapter is a **trace-replay cursor machine**: it holds the whole trace
in memory and services every DAP stepping request by moving a cursor. It runs
in-process in the extension host (`DebugAdapterInlineImplementation`).

```
extension.ts            VSCode glue: config provider + inline adapter factory
debugAdapter/
  SorobanDebugSession   DAP handlers (cursor moves + StoppedEvents)
  TraceModel            records, cursor, call-depth, breakpoint navigation
  backends/
    RawTraceBackend     M1: replay a JSONL trace file
    LiveBackend         M2: turnkey build + spawn + deploy + trace
komet/
  trace.ts              JSONL -> TraceRecord[]
  KometClient.ts        JSON-RPC client (getHealth/sendTransaction/traceTransaction/...)
soroban/scval.ts        launch args -> ScVals (@stellar/stellar-sdk)
sourcemap/SourceMapper  pos <-> displayed line; v1 renders the trace listing
```

All replay logic is free of the `vscode` API so it can be unit-tested in plain
Node. The `vscode`-only glue lives in `extension.ts`.

## Develop

```bash
npm install
npm run build        # bundle to dist/extension.js (esbuild)
npm test             # tsc + mocha (27 tests, incl. DAP protocol tests)
npm run check-types  # tsc --noEmit
npm run lint
```

Press **F5** (Run Extension) to open an Extension Development Host with the
extension loaded. It opens the [`examples/`](examples/) workspace — a
self-contained Soroban project with two contracts (`adder`, `increment`) and a
captured trace — so there is something real to debug immediately.

Pick a config from the Run and Debug view. Start with **Soroban: Replay
add(4, 3) trace**, which replays the bundled trace so you can step
forward/backward, set breakpoints on instructions, and inspect the stack/locals
— end to end, with no komet-node required. The **Debug add(1, 2)** and **Debug
increment(5)** configs exercise the full build → deploy → trace pipeline.

See [`examples/README.md`](examples/README.md) for details.

## Roadmap

- **M3 — Richer time travel:** call-stack reconstruction from call/return depth.
- **M4 — WAT source view:** disassemble the wasm code section and map `pos` to
  WAT lines for breakpoints on real instructions.
- **M5 — DWARF -> Rust source:** map `pos` to Rust `file:line` using embedded
  DWARF, for source-level stepping.
