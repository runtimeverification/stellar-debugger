# `soroban-trace` — Rust-level execution trace (CLI)

> **Audience:** `soroban developer` (outside VS Code) · `CI / scripting user` ·
> `AI agent integrator`
>
> **TL;DR:** `soroban-trace` builds and runs a contract once and prints a
> Rust-source-level execution trace as JSONL — one record per source statement,
> with the in-scope variables at that point. Built for scripts, CI, and AI
> agents that want to *read* an execution rather than step through it
> interactively. It can also replay a previously recorded run fully offline. For
> the standalone DAP server, see [`dap-cli.md`](./dap-cli.md); for internals, see
> [`trace-cli-internal.md`](./trace-cli-internal.md).

`soroban-trace` is a thin front-end over the same replay engine the VS Code
extension uses. It emits one JSON object per line: a leading `meta` record, one
`stop` per source-level statement (in execution order), and a trailing
`result`.

## Building

```sh
npm install
npm run build
```

This produces `dist/trace.js`. Run it directly with `node dist/trace.js …`, or
expose it as the `soroban-trace` command by installing the package
(`npm install -g .`, or `npm link` for local development). (`npm run build` also
builds the DAP server — see [`dap-cli.md`](./dap-cli.md).)

Live mode (the primary use below) builds and runs a contract, so it needs the
same tools as the editor — the [Stellar
CLI](https://developers.stellar.org/docs/tools/cli) and
[komet-node](https://github.com/runtimeverification/komet-node) on your `PATH`
(see the [main README](../README.md#requirements)). The offline replay at the end
needs no toolchain.

## Usage

`soroban-trace --help`:

```text
soroban-trace — emit a Rust source-level execution trace as JSONL

Usage:
  soroban-trace --raw-trace <file> [--wasm <file>] [options]     (offline replay)
  soroban-trace --contract <dir> --function <name> [options]     (build & run live)

Options:
  --raw-trace <file>    Recorded JSONL trace to replay (offline mode).
  --wasm <file>         Contract .wasm supplying DWARF debug info (source + variables).
  --contract <dir>      Crate directory to build and run (live mode).
  --function <name>     Contract function to invoke (required in live mode).
  --args-json <json>    Function arguments, e.g. '[{"value":1,"type":"u32"}]'.
  --out <file>          Write JSONL to a file instead of stdout.
  --depth <n>           Max variable-expansion depth (default 3).
  --max-children <n>    Max children materialized per aggregate (default 64).
  --allow-no-source     Don't error when the trace has no source-level stops.
  -h, --help            Show this help.

Examples:
  soroban-trace --raw-trace run.jsonl --wasm contract.wasm
  soroban-trace --contract . --function add --args-json '[{"value":1,"type":"u32"}]'
```

## Quick start (build → deploy → run → trace)

Trace the bundled [`examples/adder`](../examples/adder) contract — a debug build
of `add(a, b) -> u32` — invoking `add(4, 3)`. Run from the repository root:

```sh
node dist/trace.js \
  --contract  examples/adder \
  --function  add \
  --args-json '[{"value":4,"type":"u32"},{"value":3,"type":"u32"}]'
```

This builds the crate with DWARF debug info at opt-level 0, spawns komet-node,
deploys, invokes `add(4, 3)`, and streams the resulting source-level trace as
JSONL to stdout:

```jsonl
{"kind":"meta","function":"add","args":[{"value":4,"type":"u32"},{"value":3,"type":"u32"}],"records":41,"stops":1,"hasDwarf":true}
{"kind":"stop","step":0,"traceIndex":29,"depth":0,"pc":"0x2d","function":"invoke_raw_extern","instr":"i32.add","source":{"path":".../examples/adder/src/lib.rs","line":16,"column":9},"variables":[{"name":"arg_0","type":"Val","value":"17179869188"},{"name":"arg_1","type":"Val","value":"12884901892"}]}
{"kind":"result","terminated":true}
```

Each `stop` carries the source location, the enclosing function, the call
`depth`, the wasm `pc`/`instr`, and the in-scope variables decoded from DWARF
(aggregates expand into a nested `children` array, bounded by `--depth` /
`--max-children`). The full `SourceStop` / `TraceVar` field reference is in
[`trace-cli-internal.md`](./trace-cli-internal.md).

Add `--out trace.jsonl` to write to a file instead of stdout. Other bundled
crates to try: `examples/increment --function increment`,
`examples/stepper --function sum_triples`, `examples/greeter --function store`
(see [`examples/README.md`](../examples/README.md) for each contract's shape).

> **komet-node in this devcontainer:** the `komet-node` on `$PATH` here is a
> stale build that hangs on value-returning calls (`add`, `increment`). Prefix
> the rebuilt node — `PATH=/home/node/.komet-node/bin:$PATH node dist/trace.js …`
> — until the fix lands on `$PATH`. See
> [`examples/README.md`](../examples/README.md#komet-node-version-note) for the
> full note.

## Offline replay (a recorded run, no toolchain)

Already have a recorded `komet-node` trace? Replay it with no build and no
komet-node — pass the matching debug `--wasm` to get source-level stops:

```sh
node dist/trace.js \
  --raw-trace test/fixtures/adder-debug.trace.jsonl \
  --wasm      test/fixtures/adder-debug.wasm
```

This produces the same trace as the live command above (it *is* a recorded
`add(4, 3)` run of `examples/adder`), which makes it a handy zero-dependency way
to see the output format.

If the trace has no Rust source-level stops (no matching `--wasm`, or a
non-debug build) the command exits non-zero with a message, rather than emitting
a misleading trace — pass `--allow-no-source` to override.
