# Soroban Debugger — example workspace

> **Audience:** `new user` · `soroban developer` (getting started)
>
> **TL;DR:** A guided tour of the ready-to-run example contracts and launch
> configs. Start with the zero-dependency **Replay … with symbols** configs to
> see source-level, forward-and-backward debugging in seconds — no toolchain
> needed — then graduate to the full build-and-run pipeline.

This folder is a **self-contained example workspace** for the Soroban Debugger
(komet) extension. Pressing **F5** ("Run Extension") in the extension repo opens
this folder in an Extension Development Host with the extension already loaded,
so you have a real Soroban project to debug immediately.

## Contents

- `greeter/` — a contract whose entry point `store(value)` returns **nothing**
  (unit / `Void`). Uses instance storage.
- `adder/` — the simplest possible contract (`add(a, b) -> u32`, pure arithmetic).
- `increment/` — a stateful counter (`increment(by) -> u32`, uses instance storage).
- `stepper/` — `sum_triples(n)`: a real `#[inline(never)]` call inside a `while`
  loop, for exercising step-in / step-over across a call and per-iteration stops.
- `control/` — one entry point per Rust construct (`seq`, `branch` if/else,
  `count` `for`, `while_call` `while`+call, `choose` `match`). It is the fixture
  behind the systematic stepping suite (`test/control*Stepping.test.ts`); the
  debugger builds it at **opt-level=0** so every statement keeps its own line
  (higher optimization collapses a whole function onto one line — see
  `../docs/stepping.md`).
- `traces/add.trace.jsonl` — a captured `komet-node` execution trace for `add`,
  so the debugger works with **no toolchain and no komet-node**. It is the same
  real trace as `../test/fixtures/adder-debug.trace.jsonl`; paired with
  `../test/fixtures/adder-debug.wasm` (a debug build of `adder/`) it also
  demonstrates full **Rust source mapping** offline.

Each contract is an independent crate (its own `Cargo.toml`/`Cargo.lock`/
`target/`), which is what the extension's `contract` launch attribute expects.

## Try it

Open the Run and Debug view and pick a config from `.vscode/launch.json`:

1. **Soroban: Replay add(4, 3) with symbols** — zero dependencies. Replays the
   bundled trace together with its matching debug wasm: stack frames open
   `adder/src/lib.rs`, breakpoints verify on Rust lines (sliding forward to the
   nearest executed line), stepping is statement-granular, and right-clicking
   the stack frame offers **Open Disassembly View** (annotated wasm,
   instruction breakpoints, instruction-granular stepping — also backwards).
   Start here.
2. **Soroban: Replay add(4, 3) trace** — the same trace without the wasm: the
   no-DWARF fallback. Frames carry only an instruction pointer; you debug in
   the Disassembly View.
3. **Soroban: Replay control while_call(3) / count(3) / branch(3) with symbols**
   — zero-dependency replays of the control fixtures, one per Rust construct:
   step into `bump` and back out of a `while` loop, watch a `for` body stop once
   per iteration, or see an `if`/`else` enter only the taken arm.
4. **Soroban: Debug store(42) / add(1, 2) / increment(5) / control while_call(3)**
   — the full turnkey pipeline: builds the crate **with DWARF debug info at
   opt-level 0** (the extension injects `CARGO_PROFILE_RELEASE_DEBUG=true` /
   `CARGO_PROFILE_RELEASE_STRIP=none` / `CARGO_PROFILE_RELEASE_OPT_LEVEL=0`; no
   `Cargo.toml` changes needed — opt-level 0 is what keeps per-statement source
   stepping working), spawns komet-node, deploys, invokes, and replays the
   resulting trace with Rust source mapping. Requires the toolchain (Rust + wasm
   target, Stellar CLI, komet-node), all present in the devcontainer. Set
   `"debugInfo": false` in a launch config to opt out of the debug build (you
   then debug at the wasm level only).

Note: komet-node's tracer stops at instructions it cannot decode (it reports
them as `unknown`, e.g. `if`), so a trace can end before the invocation does —
depending on codegen, some contracts replay only partially.

## komet-node version note

Earlier versions of komet-node reported a `FAILED` transaction for any contract
call that **returns a value** (its `callTx` handling asserted a `Void` result, so
functions like `add`/`increment` got stuck; only no-return functions like
`greeter::store` completed). This is fixed in komet-node — `callTx` now uses
`uncheckedCallTx`, which does not assert the return value.

The fix isn't on the nix binary cache yet, so the `komet-node` on `$PATH` in this
devcontainer is still the older build. `.vscode/settings.json` therefore points
the extension at the rebuilt node via:

```json
{ "soroban.kometNode.path": "/home/node/.komet-node/bin/komet-node" }
```

Once the nix cache ships the fix, delete that setting and the extension will use
`komet-node` from `$PATH`. (The `soroban.stellar.path` setting works the same way
for the Stellar CLI.)

## Adding your own contract

Drop a new crate directory here (with a `Cargo.toml` exposing a `#[contract]`),
then add a launch config pointing `contract` at it and naming the `function`.
