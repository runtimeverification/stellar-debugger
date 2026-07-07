# Soroban Debugger — example workspace

This folder is a **self-contained example workspace** for the Soroban Debugger
(komet) extension. Pressing **F5** ("Run Extension") in the extension repo opens
this folder in an Extension Development Host with the extension already loaded,
so you have a real Soroban project to debug immediately.

## Contents

- `greeter/` — a contract whose entry point `store(value)` returns **nothing**
  (unit / `Void`). Uses instance storage.
- `adder/` — the simplest possible contract (`add(a, b) -> u32`, pure arithmetic).
- `increment/` — a stateful counter (`increment(by) -> u32`, uses instance storage).
- `traces/add.trace.jsonl` — a captured `komet-node` execution trace for `add`,
  so the debugger works with **no toolchain and no komet-node**.

Each contract is an independent crate (its own `Cargo.toml`/`Cargo.lock`/
`target/`), which is what the extension's `contract` launch attribute expects.

## Try it

Open the Run and Debug view and pick a config from `.vscode/launch.json`:

1. **Soroban: Replay add(4, 3) trace** — zero dependencies. Replays the bundled
   trace so you can step forward/backward, set breakpoints, and inspect the
   stack/locals. Start here.
2. **Soroban: Debug store(42) / add(1, 2) / increment(5)** — the full turnkey
   pipeline: builds the crate, spawns komet-node, deploys, invokes, and replays
   the resulting trace. Requires the toolchain (Rust + wasm target, Stellar CLI,
   komet-node), all present in the devcontainer.

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
