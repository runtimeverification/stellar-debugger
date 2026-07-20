# `soroban-dap` — standalone DAP server (TCP)

> **Audience:** `other-editor user` (nvim-dap / IntelliJ / Emacs) · `tooling integrator`
>
> **TL;DR:** `soroban-dap` serves the Soroban debug adapter over a TCP socket
> (DAP's canonical "server mode"), so debuggers *other* than VS Code can drive
> it. For the one-shot JSONL trace CLI, see [`trace-cli.md`](./trace-cli.md); for
> internals, see [`dap-cli-internal.md`](./dap-cli-internal.md).

`soroban-dap` runs the debug adapter as a TCP server. Each client connection
gets its own independent session; the launch configuration is sent by the client
over the wire, exactly as in the editor.

## Building

```sh
npm install
npm run build
```

This produces `dist/dap-server.js`. Run it directly with
`node dist/dap-server.js …`, or expose it as the `soroban-dap` command by
installing the package (`npm install -g .`, or `npm link` for local
development). (`npm run build` also builds the trace CLI — see
[`trace-cli.md`](./trace-cli.md).)

Debugging a real contract needs the same tools as the editor — the [Stellar
CLI](https://developers.stellar.org/docs/tools/cli) and
[komet-node](https://github.com/runtimeverification/komet-node) on your `PATH`
(see the [main README](../README.md#requirements)) — unless the client launches
with a recorded `rawTrace` (offline replay).

## Usage

`soroban-dap --help`:

```text
soroban-dap — serve the Soroban debug adapter over a TCP socket

Usage:
  soroban-dap [--port <n>] [--host <addr>]

Options:
  --port <n>     TCP port to listen on (default 4711).
  --host <addr>  Interface to bind (default 127.0.0.1, loopback only).
  -h, --help     Show this help.

Connect any DAP client to the port (e.g. VS Code "debugServer": <port>).
```

```sh
node dist/dap-server.js --port 4711
# → Soroban DAP server listening on 127.0.0.1:4711
```

The server binds **loopback** by default — it does not expose the debugger to
the network. Only override `--host` on a trusted, isolated network.

## Connecting a client

Any DAP client that can attach to a running server works. From VS Code, point a
launch configuration at the port with `debugServer`:

```jsonc
{
  "type": "soroban",
  "request": "launch",
  "name": "Attach to soroban-dap",
  "debugServer": 4711,
  "rawTrace": "test/fixtures/adder-debug.trace.jsonl",
  "wasmPath": "test/fixtures/adder-debug.wasm"
}
```

Other editors use their own attach mechanism (e.g. nvim-dap's `server`/`port`
adapter config) — the wire protocol is standard DAP, so any conformant client
can drive it. The full set of launch attributes is the same as the editor's
[configuration reference](../README.md#configuration-reference).

> Plain request/response HTTP is intentionally not offered: DAP is a
> bidirectional, event-driven protocol that doesn't fit HTTP's request/response
> shape. A WebSocket transport could be added if a browser-based client needs one.
