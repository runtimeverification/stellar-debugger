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
  point of execution.
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

Add a `soroban` configuration to your `.vscode/launch.json`. The common case is:
build a contract, run a function on a local network, and debug the result.

```jsonc
{
  "type": "soroban",
  "request": "launch",
  "name": "Debug add(1, 2)",
  "contract": "${workspaceFolder}",   // crate dir containing Cargo.toml
  "function": "add",
  "args": [
    { "value": 1, "type": "u32" },
    { "value": 2, "type": "u32" }
  ]
}
```

Set a breakpoint in your contract's Rust source, start the configuration, and
step through — forward or backward.

### Configuration reference

| Attribute | Description |
|-----------|-------------|
| `function` *(required)* | Name of the contract function to invoke and debug. |
| `args` | Function arguments, each `{ "value": …, "type": "u32" \| "i128" \| "symbol" \| "address" \| … }`. |
| `contract` | Path to the contract crate directory (with `Cargo.toml`). Defaults to `${workspaceFolder}`. |
| `wasmPath` | Path to a prebuilt `.wasm`. Overrides building from `contract`. |
| `debugInfo` | Build with debug info for Rust source mapping (default `true`; set `false` to debug at the wasm level only). |
| `rawTrace` | Replay a previously recorded run from a file instead of building and deploying. |
| `node` | Local-network connection/spawn settings: `attach`, `host`, `port`, `command`, `ioDir`. |
| `sourceSecret` | Optional source account secret (`S…`). A fresh account is used if omitted. |

Two settings let you point at executables that aren't on your `PATH`:
`soroban.stellar.path` and `soroban.kometNode.path`.

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
