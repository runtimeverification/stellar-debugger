# Stellar Debugger

**Time-travel debugging for Stellar/Soroban smart contracts, right inside your
editor.** Set a breakpoint in your Rust contract, hit debug, and step **forward
and backward** through exactly what your contract did — line by line.

No `println!` archaeology, no redeploy-and-guess. Run your contract once and
explore the entire execution as a recording you can scrub through in both
directions.

## Features

- 🦀 **Debug your Rust source.** Breakpoints, stack frames, and stepping work on
  your actual `.rs` files — not opaque bytecode.
- ⏪ **Step backward.** Step back and reverse-continue as easily as going
  forward. Overshot the bug? Just step back. Backward stepping is instant.
- 🔎 **Inspect state at every step.** See the values in play at the current
  point of execution — your Rust variables, the wasm locals, stack and globals.
- 🏦 **See the ledger, not just the code.** Contract storage (instance,
  persistent, temporary) with TTLs, account balances, ledger sequence and close
  time, the host object table, and the contract-call stack — all at the step
  you're on, and all time-travelling with you.
- 🚀 **One click from source to debugger.** Point the debugger at a contract and
  a function; it builds, deploys to a local network, runs the call, and drops
  you into the debug session. No manual setup.
- 🔬 **Drop to WebAssembly when you need to.** VSCode's built-in Disassembly
  View shows the annotated wasm with its own breakpoints and stepping — handy
  for optimized builds or low-level investigation.
- 📼 **Replay a recorded run offline.** Debug a captured execution with no
  network and no toolchain — perfect for sharing a reproducible bug report.

## Requirements

To build, deploy, and debug a contract you'll need:

- A Rust toolchain with a wasm target (`wasm32v1-none` or
  `wasm32-unknown-unknown`)
- The [**Stellar CLI**](https://developers.stellar.org/docs/tools/cli)
- [**komet-node**](https://github.com/runtimeverification/komet-node), the local
  Stellar network the debugger runs your contract on

The extension ships with a [devcontainer](.devcontainer/Dockerfile) that has all
of this preinstalled if you'd rather not set it up by hand.

## Getting started

1. Install the extension.
2. Open your Soroban contract project.
3. Add a debug configuration (below) and press **F5**.

The bundled [`examples/`](examples/) workspace has several ready-to-run
contracts and configurations — including offline replays that need no toolchain
at all — so you can see the debugger working in seconds. See
[`examples/README.md`](examples/README.md) for a tour.

## Usage

Add a `soroban` configuration to your `.vscode/launch.json`. A configuration describes an ordered sequence of transactions run against one fresh local ledger, and names which transaction to trace and debug — the last one by default. This lets you set up whatever state the call under test depends on (deploy other contracts, run a constructor, seed storage) before the transaction you actually want to step through.

```jsonc
{
  "type": "soroban",
  "request": "launch",
  "name": "Debug supply",
  "transactions": [
    // deploy: build a crate dir (or point `wasm` at a prebuilt .wasm) and
    // register it under a handle `id` that later invokes reference.
    { "kind": "deploy", "id": "pool", "contract": "${workspaceFolder}" },

    // invoke: call a function on a deployed handle. `args` is an object keyed
    // by the function's parameter names.
    { "kind": "invoke", "contract": "pool", "function": "__constructor",
      "args": { "admin": "${sourceAddress}" } },
    { "kind": "invoke", "contract": "pool", "function": "supply",
      "args": { "requests": [[{ "tag": "Native" }, "1000"]] } }
  ],
  "trace": "last"
}
```

Set a breakpoint in your contract's Rust source, start the configuration, and step through the traced transaction — forward or backward.

Even the simplest single-call session is one `deploy` plus one `invoke` — there is one config shape, so a two-contract system is just a longer `transactions` array. See [`docs/debug-config.md`](docs/debug-config.md) for the complete reference, including multi-contract systems, composite argument types, and offline replay.

### Configuration reference

Top-level attributes:

| Attribute | Description |
|-----------|-------------|
| `transactions` | Ordered, non-empty array of `deploy` / `invoke` steps (see below) — the live sequence to run. |
| `trace` | Which transaction feeds the debug session: `"last"` (default), a 0-based index into `transactions`, or a step `id` (a deploy's `id` or an invoke's optional `id`). |
| `sourceSecret` | Source account secret (`S…`) used to sign every transaction. A deterministic account is derived if omitted. Its address is available in `args` as `${sourceAddress}`. |
| `node` | Local-network connection/spawn settings: `attach`, `host`, `port`, `command`, `ioDir`. |
| `rawTrace` | Replay a previously recorded run from a file instead of building and deploying (optionally with `wasmPath` for source mapping). |

A **`deploy`** step uploads a contract and registers a handle:

| Field | Description |
|-------|-------------|
| `kind` *(required)* | `"deploy"`. |
| `id` *(required)* | Handle name that later `invoke` steps reference via their `contract` field, and that `trace` can select. |
| `contract` | Path to the contract crate directory (with `Cargo.toml`) to build. |
| `wasm` | Path to a prebuilt `.wasm`. Overrides building from `contract`; one of `contract` / `wasm` is required. |
| `buildCommand` | Command used to build a `contract` dir (default `stellar contract build`). |
| `debugInfo` | Build with debug info for Rust source mapping (default `true`; set `false` to debug at the wasm level only). |

An **`invoke`** step calls a function on a deployed handle:

| Field | Description |
|-------|-------------|
| `kind` *(required)* | `"invoke"`. |
| `contract` *(required)* | Handle `id` of an earlier `deploy` step. |
| `function` *(required)* | Name of the contract function to call. |
| `args` | Arguments, as an object keyed by the function's parameter names. Values follow the contract's own spec, so composites work: an enum is `{ "tag": "Native" }` or `{ "tag": "Other", "values": [7] }`, a tuple or vec is a JSON array, an `i128` is a decimal string, an address is a `G…`/`C…` string. |
| `id` | Optional label so `trace` can select this invoke's transaction. |

Two substitution tokens are expanded inside string `args` values: `${sourceAddress}` (the source account's address) and `${contract:<id>}` (the deployed address behind a handle).

Two settings let you point at executables that aren't on your `PATH`: `soroban.stellar.path` and `soroban.kometNode.path`. For the full reference — multi-contract systems, every argument shape, and offline replay — see [`docs/debug-config.md`](docs/debug-config.md).

### Beyond the editor

The debugger is also available outside VS Code:

- [**`soroban-trace`**](docs/trace-cli.md) — a one-shot CLI that prints a
  Rust-level execution trace as JSONL, for scripts, CI, and AI agents.
- [**`soroban-dap`**](docs/dap-cli.md) — the debug adapter served over TCP, so other
  editors (nvim-dap, IntelliJ, Emacs) can drive it.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for how to
build, run, and test the extension, and for an overview of how it works
internally.

## Roadmap

- Multi-frame call stacks with per-frame locals
- A source-level Variables view with inline values
- Column-level breakpoints

## License

[BSD-3-Clause](LICENSE) © Runtime Verification, Inc.
