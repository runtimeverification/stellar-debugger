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
- 🧭 **Follow the call stack.** Every Rust frame that led to the current line, including the ones the optimizer inlined away — select any frame to inspect *its* variables and jump to *its* line.
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

- A Rust toolchain with a wasm target (`wasm32v1-none` or `wasm32-unknown-unknown`)
- The [**Stellar CLI**](https://developers.stellar.org/docs/tools/cli)
- [**komet-node**](https://github.com/runtimeverification/komet-node), the local Stellar network the debugger runs your contract on. It must bundle **komet v0.1.87 or newer** — that is a komet-node at or after the commit that bumped to komet v0.1.88 (`7545bd8`); `kup install komet-node` installs the newest. An older build records the previous trace shape, which this extension rejects rather than replaying: a trace it cannot classify would open a session with every state view mysteriously empty.

Replaying an already-recorded trace needs none of the above — no toolchain, no network, no komet-node.

The repository ships a [devcontainer](.devcontainer/Dockerfile) with all of it preinstalled if you'd rather not set it up by hand. If something is missing, the debugger says which tool it is and how to get it, and links back to [Troubleshooting](#troubleshooting) below.

### Installing komet-node

komet-node is distributed with [`kup`](https://github.com/runtimeverification/kup), Runtime Verification's package manager, which builds on Nix:

```bash
curl -L https://kframework.org/install | bash                       # installs kup
kup install komet-node                                              # kup update komet-node, if already installed
```

The node and its K semantics are published to Runtime Verification's binary cache, so this downloads prebuilt binaries rather than compiling them; `kup` offers to register the caches that make that work the first time it needs them. `kup list komet-node` reports the installed version and whether a newer one exists.

## Install

Install **Stellar Debugger** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=runtimeverification.stellar-debugger), or from the command line:

```bash
code --install-extension runtimeverification.stellar-debugger
```

Cursor, Windsurf and VSCodium install the same extension from [Open VSX](https://open-vsx.org/extension/runtimeverification/stellar-debugger).

## Getting started

1. Install the extension.
2. Open your Soroban contract project.
3. Add a debug configuration (below) and press **F5**.

To see it working before pointing it at your own code, clone this repository and open its [`examples/`](examples/) workspace: it has several ready-to-run contracts and configurations — including offline replays that need no toolchain at all. See [`examples/README.md`](examples/README.md) for a tour.

## Usage

Add a `stellar` configuration to your `.vscode/launch.json`. A configuration describes an ordered sequence of transactions run against one fresh local ledger, and names which transaction to trace and debug — the last one by default. This lets you set up whatever state the call under test depends on (deploy other contracts, run a constructor, seed storage) before the transaction you actually want to step through.

```jsonc
{
  "type": "stellar",
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
| `node` | Local-network connection/spawn settings: `attach`, `host`, `port`, `command`, `ioDir`, `timeoutMs`, `healthTimeoutMs`. |
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

Two settings let you point at executables that aren't on your `PATH`: `stellar.cliPath` and `stellar.kometNode.path`. For the full reference — multi-contract systems, every argument shape, and offline replay — see [`docs/debug-config.md`](docs/debug-config.md).

### Beyond the editor

The debugger is also available outside VS Code:

- [**`stellar-trace`**](docs/trace-cli.md) — a one-shot CLI that prints a
  Rust-level execution trace as JSONL, for scripts, CI, and AI agents.
- [**`stellar-dap`**](docs/dap-cli.md) — the debug adapter served over TCP, so other
  editors (nvim-dap, IntelliJ, Emacs) can drive it.

Both are built from this repository rather than installed by the extension: clone it, `npm install && npm run build`, and either run `node dist/trace.js` directly or `npm install -g .` to put `stellar-trace` and `stellar-dap` on your `PATH`.

## Troubleshooting

Every message the debugger raises about a missing dependency links here. Each row is what it says and what to do about it.

| What you see | What it means | What to do |
|---|---|---|
| *komet-node could not be started: there is no executable named `komet-node` on your `PATH`* | The local network is not installed. | `kup install komet-node`. If it lives off your `PATH`, set the `stellar.kometNode.path` setting (or `node.command` in the launch configuration) to its full path. |
| *komet-node could not be started: … is not executable* | The file is there but has no execute bit. | `chmod +x <path>`, or point the setting at the right file. |
| *komet-node exited … before it was ready to serve requests* | The node started and died; its own output is quoted in the message and in the Debug Console. | Most often port 8000 is already taken by an earlier run — set `node.port` to a free port, or stop the other process. |
| *komet-node did not become ready within 60s* | The node is running but never answered. | Check the Debug Console for its output. A very large contract can need longer to boot: raise `node.healthTimeoutMs`. |
| *No komet-node answered at http://… — your launch configuration sets `node.attach`* | Nothing is listening where you told the debugger to attach. | Start a node yourself (`komet-node --host <host> --port <port>`), or drop `node.attach` and let the debugger spawn one. |
| *This execution trace was recorded by a komet-node that is too old* | The installed node predates komet v0.1.87 and records the old trace shape. | `kup install komet-node`, then run again. Re-record any saved trace file with the upgraded node. |
| *komet-node does not support the `traceTransaction` request* | Same cause, seen one step earlier: the node cannot trace at all. | `kup install komet-node`. |
| *The contract build failed: `stellar` was not found* | No Stellar CLI. | Install the [Stellar CLI](https://developers.stellar.org/docs/tools/cli), or point `stellar.cliPath` (or a deploy step's `buildCommand`) at it. |
| *The contract build failed: `cargo` was not found* | No Rust toolchain. | Install one from [rustup.rs](https://rustup.rs). |
| *The contract build failed: the Rust WebAssembly target is missing* | The toolchain has no wasm target. | `rustup target add wasm32v1-none` (toolchains older than Rust 1.84 use `wasm32-unknown-unknown`). |
| *The contract build failed: `<command>` exited with code …* | An ordinary build failure; the message quotes the tail and the Debug Console has the whole log. | Fix the build as you would from a terminal — the same command run by hand reproduces it. |
| *The contract build reported success but produced no WebAssembly file* | The build ran but wrote no `.wasm` where the debugger looks. | Check that the directory is a contract crate (a `Cargo.toml` with `crate-type = ["cdylib"]`) and that the build command really builds it. |
| *Cannot read the recorded trace (`rawTrace`) at …* | The replay input is missing or unreadable. | Point `rawTrace` at an existing JSONL trace, or record one with `stellar-trace --out <file>`. |

Two things worth knowing before you start diagnosing:

- **Replay needs nothing.** A configuration with `rawTrace` uses no komet-node, no Stellar CLI and no Rust toolchain, so it is the quickest way to tell a broken toolchain apart from a broken configuration.
- **The Debug Console has the full log.** Every message above is also written there, along with the output of komet-node and of the build, which is usually where the specific cause is named.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for how to
build, run, and test the extension, and for an overview of how it works
internally.

## Known limitations

- **A trace can stop short of the invocation's end.** komet-node's tracer halts at instructions it cannot decode (it reports them as `unknown`), so depending on codegen some contracts replay only partially. The session opens and steps normally; it just ends earlier than the call did.
- **Source stepping wants an unoptimized build.** The live pipeline builds with debug info at opt-level 0 for exactly this reason — at higher optimization levels a whole function can collapse onto a single line. See [`docs/stepping.md`](docs/stepping.md).
- **A recording carries the source paths of the machine that built the contract.** They are absolute paths taken from the wasm's debug info, so a trace someone hands you opens its frames at paths that need not exist on your disk: the session still replays, steps and shows variables, but the editor cannot show the source itself unless the files sit where that build left them.
- **One transaction per session.** A launch config can run a whole sequence of transactions, but exactly one of them (`trace`) is the one you step through.

## Roadmap

- Variable values shown inline in the editor, next to your code
- Column-level breakpoints

## License

[BSD-3-Clause](LICENSE) © Runtime Verification, Inc.
