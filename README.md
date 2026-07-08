# Soroban Debugger (komet)

A **time-travel debugger for Stellar/Soroban smart contracts**, backed by
[`komet-node`](https://github.com/runtimeverification/komet-node) — Runtime
Verification's local Stellar testnet built on K formal semantics.

komet-node executes a whole transaction and returns the *entire* execution trace
as JSON Lines (one record per WebAssembly instruction) via its `traceTransaction`
RPC. This extension loads that trace and lets you **step forward and backward**
through the execution inside VSCode's debugger UI — at the **Rust source level**
when DWARF debug info is available, and at the instruction level in VSCode's
built-in **Disassembly View** always.

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

**Milestones M4+M5 (done): DWARF → Rust source mapping + DAP disassembly.**

- The build injects `CARGO_PROFILE_RELEASE_DEBUG=true` /
  `CARGO_PROFILE_RELEASE_STRIP=none` into `stellar contract build`, so the wasm
  carries DWARF — no `Cargo.toml` changes needed (set `"debugInfo": false` in
  the launch config to opt out). The **pristine linker output**
  (`target/…/release/deps/*.wasm`) is used and uploaded, because the Stellar
  CLI's metadata-injection step rewrites the wasm and strips the DWARF line
  programs.
- An in-repo DWARF v4/v5 line-table parser (`src/dwarf/`) maps wasm code
  offsets to Rust `file:line`. Stack frames open the real `.rs` file;
  **breakpoints set in Rust source** verify against the executed trace (sliding
  forward to the nearest executed line); stepping is **statement-granular** in
  source and **instruction-granular** in the Disassembly View
  (`supportsSteppingGranularity`).
- The raw WebAssembly view is VSCode's built-in **Disassembly View**
  (right-click a stack frame → *Open Disassembly View*): a static
  `wasmparser`-backed disassembly with Rust line annotations, plus
  **instruction breakpoints** (`supportsDisassembleRequest`,
  `supportsInstructionBreakpoints`, `supportsBreakpointLocationsRequest`).
- **No-DWARF fallback:** a prebuilt wasm without debug info, or a `rawTrace`
  replay without `wasmPath`, degrades to disassembly-only debugging — frames
  carry an instruction pointer but no source.

Trace positions are **validated** before use: komet-node's `pos` is relative to
the section being executed (code section for function code, e.g. the globals
section for global initializers), so every record is cross-checked against the
static disassembly and only trusted when the mnemonics agree. Note that
komet-node's tracer stops at instructions it cannot decode (it prints them as
`unknown`, e.g. `if`), so a trace can be a prefix of the full execution.

## Verification

The replay logic and pipeline are exercised by 180+ tests (`npm test`):

- **DAP protocol tests** drive the real adapter (capabilities, entry stop,
  forward and reverse stepping at both granularities, locals/stack, Rust source
  breakpoints with forward slide, run-to-breakpoint + reverse-continue,
  disassembly windows, instruction breakpoints, breakpoint locations).
- **DWARF tests** decode the committed debug build of `examples/adder`
  (`test/fixtures/adder-debug.wasm`) and pin the `a + b` line mapping against
  its **matched real trace** (`adder-debug.trace.jsonl`); regenerate the pair
  together with `scripts/make-fixtures.sh`.
- **tx-builder tests** decode every built envelope back with the SDK; envelopes
  are additionally cross-checked against the Stellar CLI's own XDR decoder.
- **pipeline tests** run `TurnkeyPipeline` against an in-process mock komet-node
  and assert the full deploy+invoke sequence and the parsed trace.
- **build integration test** (auto-skips without the toolchain) runs a real
  `stellar contract build` through `ContractBuilder`.
- `scripts/verify-addresses.mjs` re-derives the address-space ground truth
  (komet `pos` convention, DWARF address space) against a live komet-node — the
  regression tool for the M0 findings above.

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
  SorobanDebugSession   DAP handlers (cursor moves + StoppedEvents, disassembly)
  TraceModel            records, cursor, call-depth, line + instruction stepping
  artifacts.ts          wasm bytes -> { mapper, disassembly, validated positions }
  backends/
    RawTraceBackend     replay a JSONL trace file (+ optional wasmPath for symbols)
    LiveBackend         turnkey build + spawn + deploy + trace
komet/
  trace.ts              JSONL -> TraceRecord[] (K-style mnemonics, section-relative pos)
  mnemonics.ts          K-style instr arrays -> wasm mnemonics ('i64.const 255')
  KometClient.ts        JSON-RPC client (getHealth/sendTransaction/traceTransaction/...)
soroban/scval.ts        launch args -> ScVals (@stellar/stellar-sdk)
wasm/
  sections.ts           wasm section walker (offsets, custom-section lookup)
  Disassembly.ts        static disassembly (wasmparser), code-offset addressed
dwarf/                  DWARF v4/v5 .debug_line/.debug_info parser -> LineTable
sourcemap/
  SourceMapper          the mapping seam the adapter talks to
  DwarfSourceMapper     trace index / code offset -> Rust file:line (+ breakpoints)
  NullSourceMapper      no-DWARF fallback (disassembly-only)
```

All replay logic is free of the `vscode` API so it can be unit-tested in plain
Node. The `vscode`-only glue lives in `extension.ts`.

## Develop

```bash
npm install
npm run build        # bundle to dist/extension.js (esbuild)
npm test             # tsc + mocha
npm run check-types  # tsc --noEmit
npm run lint
```

Press **F5** (Run Extension) to open an Extension Development Host with the
extension loaded. It opens the [`examples/`](examples/) workspace — a
self-contained Soroban project with three contracts and captured traces — so
there is something real to debug immediately.

Pick a config from the Run and Debug view. Start with **Soroban: Replay
add(4, 3) with symbols**, which replays the bundled trace *with* the matching
debug wasm: frames land in `adder/src/lib.rs`, breakpoints work on Rust lines,
and the Disassembly View shows annotated wasm — no komet-node required. The
**Debug add(1, 2)** and **Debug increment(5)** configs exercise the full
build → deploy → trace pipeline.

See [`examples/README.md`](examples/README.md) for details.

## Roadmap

- **M3 — Richer time travel:** call-stack reconstruction from call/return depth
  (multi-frame stack traces, frame-scoped locals).
- Column-level breakpoints and inline `values` from DWARF variable info.
