# `stellar-trace` — Rust-level execution trace (CLI)

> **Audience:** `stellar contract developer` (outside VS Code) · `CI / scripting user` ·
> `AI agent integrator`
>
> **TL;DR:** `stellar-trace` builds and runs a contract once and prints a
> Rust-source-level execution trace as JSONL — one record per source statement,
> with the in-scope variables at that point. Built for scripts, CI, and AI
> agents that want to *read* an execution rather than step through it
> interactively. It can also replay a previously recorded run fully offline. For
> the standalone DAP server, see [`dap-cli.md`](./dap-cli.md); for internals, see
> [`trace-cli-internal.md`](./trace-cli-internal.md).

`stellar-trace` is a thin front-end over the same replay engine the VS Code
extension uses. It emits one JSON object per line: a leading `meta` record, one
`stop` per source-level statement (in execution order), and a trailing
`result`.

## Building

```sh
npm install
npm run build
```

This produces `dist/trace.js`. Run it directly with `node dist/trace.js …`, or
expose it as the `stellar-trace` command by installing the package
(`npm install -g .`, or `npm link` for local development). (`npm run build` also
builds the DAP server — see [`dap-cli.md`](./dap-cli.md).)

The marketplace build of the extension does not install these CLIs; they are built from this repository.

Live mode (the primary use below) builds and runs a contract, so it needs the
same tools as the editor — the [Stellar
CLI](https://developers.stellar.org/docs/tools/cli) and
[komet-node](https://github.com/runtimeverification/komet-node) on your `PATH`
(see the [main README](../README.md#requirements)). The offline replay at the end
needs no toolchain.

## Usage

`stellar-trace --help`:

```text
stellar-trace — emit a Rust source-level execution trace as JSONL

Usage:
  stellar-trace --raw-trace <file> [--wasm <file>] [options]     (offline replay)
  stellar-trace --contract <dir> --function <name> [options]     (build & run live)

Options:
  --raw-trace <file>    Recorded JSONL trace to replay (offline mode).
  --wasm <file>         Contract .wasm supplying DWARF debug info (source + variables).
  --contract <dir>      Crate directory to build and run (live mode).
  --function <name>     Contract function to invoke (required in live mode).
  --args-json <json>    Function arguments keyed by parameter name, e.g. '{"a":1,"b":2}'.
  --out <file>          Write JSONL to a file instead of stdout.
  --depth <n>           Max variable-expansion depth (default 3).
  --max-children <n>    Max children materialized per aggregate (default 64).
  --allow-no-source     Don't error when the trace has no source-level stops.
  -h, --help            Show this help.

Examples:
  stellar-trace --raw-trace run.jsonl --wasm contract.wasm
  stellar-trace --contract . --function add --args-json '{"a":1,"b":2}'
```

## Quick start (build → deploy → run → trace)

Trace the bundled [`examples/adder`](../examples/adder) contract — a debug build
of `add(a, b) -> u32` — invoking `add(4, 3)`. Run from the repository root:

```sh
node dist/trace.js \
  --contract  examples/adder \
  --function  add \
  --args-json '{"a":4,"b":3}'
```

This builds the crate with DWARF debug info at opt-level 0, spawns komet-node,
deploys, invokes `add(4, 3)`, and streams the resulting source-level trace as
JSONL to stdout:

```jsonl
{"kind":"meta","function":"add","records":41,"stops":1,"hasDwarf":true}
{"kind":"stop","step":0,"traceIndex":29,"depth":0,"pc":"0x2d","function":"invoke_raw_extern","frames":[{"level":0,"name":"add","kind":"inline","pc":"0x2d","source":{"path":".../examples/adder/src/lib.rs","line":16}},{"level":1,"name":"invoke_raw","kind":"inline","pc":"0x2d","source":{"path":".../examples/adder/src/lib.rs","line":12}},{"level":2,"name":"adder::__add::invoke_raw_extern","kind":"rust","pc":"0x2d","source":{"path":".../examples/adder/src/lib.rs","line":12}}],"instr":"i32.add","source":{"path":".../examples/adder/src/lib.rs","line":16,"column":9},"variables":[{"name":"arg_0","type":"Val","value":"17179869188"},{"name":"arg_1","type":"Val","value":"12884901892"}]}
{"kind":"result","terminated":true}
```

Each `stop` carries the source location, the enclosing function, the call
`depth`, the wasm `pc`/`instr`, and the in-scope variables decoded from DWARF
(aggregates expand into a nested `children` array, bounded by `--depth` /
`--max-children`). The full `SourceStop` / `TraceVar` field reference is in
[`trace-cli-internal.md`](./trace-cli-internal.md).

### The call stack: `frames`

`frames` is the whole call stack at that stop, innermost first — the same frames the editor's Callstack view shows, derived by the same shared code, so a script and a debug session never disagree about who called whom.
Each frame states its `name`, its `pc`, where it stands (`source`), and which rung of the precision ladder placed it:

| `kind` | meaning |
| --- | --- |
| `rust` | a wasm activation located by DWARF |
| `inline` | a Rust frame the optimizer inlined into the activation below it |
| `wasm` | an activation with no source-level identity (no DWARF at its pc) |
| `contract` | a host-level contract invocation — a boundary marker, not a code position |

An outer frame stands at the CALL it is suspended in, not at its own first line, and a frame the user did not write (Rust toolchain, a crates.io dependency, or any sourceless frame in a session that has line info) carries `"subtle": true`, so a consumer can fold the noise away without losing it.
The example above is a build above opt-level 0, where `add` survives only as an inline frame inside the `#[contractimpl]` wrapper — the rules are specified in [`callstack.md`](./callstack.md).

### Machine state: `globals` and `ledger`

When the trace carries them, a `stop` also reports the machine and chain state at that point — the same state the editor's **Globals** and **Ledger** scopes show. `meta` announces both up front (`hasGlobals`, `hasLedger`) so a consumer can branch without probing every stop:

```jsonl
{"kind":"meta","records":812,"stops":9,"hasDwarf":true,"hasGlobals":true,"hasLedger":true}
{"kind":"stop","step":3,"traceIndex":214,"pc":"0x2d","instr":"i32.add",
 "globals":{"0":{"type":"i32","value":"1048560"}},
 "ledger":{"contract":"CADQO…","storage":[{"durability":"instance","key":"symbol(COUNTER)","value":"5","liveUntil":100,"changed":true}],
           "accounts":[{"account":"GADQO…","balance":9876543210}],
           "info":{"sequence":42,"timestamp":1712345678},
           "hostObjects":[{"index":0,"value":"COUNTER"}],
           "callStack":[{"from":"GADQO…","to":"CADQO…","function":"increment","depth":1,"args":["5"]}]}}
```

- `globals` is keyed by **module-relative global index** — the same index space DWARF uses — so it lines up with a variable's location expression.
- `ledger.storage` covers the executing contract across all three durabilities, each entry with its `liveUntil`. `changed: true` marks entries that moved since the **previous stop**, so a diff of two whole trees is unnecessary; it is absent on the first stop and on entries that did not move.
- Both keys are omitted entirely for a trace that does not carry them, rather than emitted empty.

Storage is reconstructed from the trace's own contract-call baselines and write events, including undoing the writes of a sub-call that trapped, so the values shown are what the contract would actually read. The rules are specified in [`state-inspection.md`](./state-inspection.md).

Add `--out trace.jsonl` to write to a file instead of stdout. Other bundled
crates to try: `examples/increment --function increment`,
`examples/stepper --function sum_triples`, `examples/greeter --function store`
(see [`examples/README.md`](../examples/README.md) for each contract's shape).

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
