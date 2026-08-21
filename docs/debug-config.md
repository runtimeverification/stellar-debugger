# Debug configuration reference

> **Audience:** `stellar contract developer` · `getting started` · `writing launch.json`
>
> **TL;DR:** A `stellar` launch configuration describes an ordered sequence of
> transactions run against one fresh local ledger, and names which transaction
> to trace and debug. You set up whatever state your call depends on (deploy
> other contracts, run a constructor, seed storage) as earlier transactions,
> then point `trace` at the one you want to step through. This document covers
> every field, the argument encodings (including enums, tuples, structs, and
> addresses), the `${…}` substitution tokens, and offline replay — with worked
> examples. For the editor tour see [`../examples/README.md`](../examples/README.md);
> for the CLIs see [`trace-cli.md`](./trace-cli.md) and [`dap-cli.md`](./dap-cli.md).

## Two modes

A launch configuration runs in one of two modes:

- **Live** — the default. You give a `transactions` array; the debugger spawns
  (or attaches to) a local komet-node, runs the whole sequence against one fresh
  ledger, and drops you into a debug session on the transaction named by
  `trace`.
- **Replay** — you give a `rawTrace` file. The debugger replays a previously
  recorded execution with no network and no toolchain. Optionally pair it with a
  `wasmPath` for Rust source mapping. See [Replay mode](#replay-mode).

A configuration is one JSON object in your `.vscode/launch.json` under
`configurations`. Every live configuration shares this skeleton:

```jsonc
{
  "type": "stellar",
  "request": "launch",
  "name": "…",            // shown in the Run and Debug dropdown
  "transactions": [ … ],  // the ordered sequence (required)
  "trace": "last"         // which transaction to debug (optional, default "last")
}
```

## The `transactions` sequence

`transactions` is an ordered, non-empty array of **steps**. Each step is either
a `deploy` (upload a contract and register a handle) or an `invoke` (call a
function on a deployed handle). Steps run in order against one accumulating
ledger, so state written by one step is visible to later steps.

```jsonc
"transactions": [
  { "kind": "deploy", "id": "pool", "contract": "${workspaceFolder}" },
  { "kind": "invoke", "contract": "pool", "function": "__constructor",
    "args": { "admin": "${sourceAddress}" } },
  { "kind": "invoke", "contract": "pool", "function": "supply",
    "args": { "requests": [[{ "tag": "Native" }, "1000"]] } }
]
```

Notes on semantics that shape how you author a sequence:

- **A constructor is just an invoke.** komet runs a function literally named
  `__constructor` as an ordinary call, and its storage writes persist — so
  express contract initialization as an explicit `invoke` step, not as part of
  the deploy.
- **Every transaction gets a distinct hash.** Two byte-identical invokes would
  otherwise be deduplicated by the node; the runner assigns an incrementing
  account sequence per submission so repeated identical calls each execute.
- **A reverting transaction stays debuggable.** The sequence never stops on a
  failed transaction; the traced step's trace is fetched regardless of status.
  Every transaction's status is reported in the debug console as it settles, so
  a step that failed earlier in the sequence is visible rather than silent.

### `deploy` step

| Field | Required | Description |
|-------|----------|-------------|
| `kind` | ✅ | `"deploy"`. |
| `id` | ✅ | Handle name. Later `invoke` steps reference it via their `contract` field, and `trace` can select this deploy's transaction by this id. Must be unique. |
| `contract` | one of `contract`/`wasm` | Path to a contract crate directory (containing `Cargo.toml`) to build. |
| `wasm` | one of `contract`/`wasm` | Path to a prebuilt `.wasm`. Overrides building from `contract`. |
| `buildCommand` | | Command used to build a `contract` directory. Defaults to `stellar contract build` (or the `stellar.cliPath` setting). Ignored when `wasm` is given. |
| `debugInfo` | | Build with DWARF debug info for Rust source mapping (default `true`). Set `false` to debug at the wasm level only. Ignored when `wasm` is given. |

### `invoke` step

| Field | Required | Description |
|-------|----------|-------------|
| `kind` | ✅ | `"invoke"`. |
| `contract` | ✅ | Handle `id` of an earlier `deploy` step. |
| `function` | ✅ | Name of the contract function to call. |
| `args` | | Arguments to the function (see [Arguments](#arguments)). |
| `id` | | Optional label so `trace` can select this invoke's transaction. |

## `trace`

`trace` names which transaction feeds the debug session:

| Value | Meaning |
|-------|---------|
| `"last"` (default) | The final step in `transactions`. |
| a number | A 0-based index into `transactions`. |
| a string | A step `id` — a deploy's `id` or an invoke's optional `id`. |

## Arguments

An invoke step's `args` is an **object keyed by the function's parameter
names**. Values follow the contract's own spec, so composite types work
naturally:

| Rust type | JSON value |
|-----------|------------|
| `u32` / `i32` / `bool` | `1`, `-2`, `true` |
| `u64`/`i64`/`u128`/`i128`/`u256`/`i256` | a decimal string, e.g. `"1000"` (avoids JS precision loss) |
| `Symbol` / `String` | `"hello"` |
| `Address` | a `G…` (account) or `C…` (contract) string |
| a unit enum variant | `{ "tag": "Native" }` |
| an enum variant with data | `{ "tag": "Other", "values": [7] }` |
| a tuple or `Vec` | a JSON array, e.g. `[a, b]` |
| a struct | an object keyed by field name |
| `Bytes` | a hex string |

Composites nest, so a `Vec<(Asset, i128)>` where `Asset` is an enum is:

```jsonc
"args": { "requests": [ [ { "tag": "Native" }, "1000" ],
                        [ { "tag": "Other", "values": ["C…"] }, "-50" ] ] }
```

## Substitution tokens

Two tokens are expanded inside string `args` values (and inside nested
composites):

| Token | Expands to |
|-------|-----------|
| `${sourceAddress}` | The source account's address (the account that signs every transaction). |
| `${contract:<id>}` | The deployed contract address behind the handle `<id>`. Use it to wire one deployed contract's address into another's call. |

Alongside these, the standard VS Code variables such as `${workspaceFolder}`
work in path fields like `contract` and `wasm`.

## Top-level fields

| Field | Description |
|-------|-------------|
| `transactions` | The ordered live sequence (required for live mode). |
| `trace` | Which transaction to debug (see [`trace`](#trace)). |
| `sourceSecret` | Source account secret (`S…`) used to sign every transaction. A deterministic account is derived and self-seeded if omitted; its address is available as `${sourceAddress}`. |
| `node` | Local-network connection/spawn settings: `attach`, `host`, `port`, `command`, `ioDir`, and `timeoutMs` (per-RPC timeout, default 10 min — raise it for very large contracts that take longer to upload or execute). |
| `rawTrace` | Replay mode: path to a recorded JSONL trace to replay instead of running a live sequence. |
| `wasmPath` | Replay mode only: a `.wasm` supplying disassembly and DWARF source mapping for the replayed trace. |

Two VS Code settings let you point at executables that aren't on your `PATH`:
`stellar.cliPath` and `stellar.kometNode.path`.

## Replay mode

Replay needs no toolchain and no node — it re-reads a trace you (or a teammate)
recorded earlier, which makes it ideal for reproducible bug reports. Give a
`rawTrace` path; add a `wasmPath` to get Rust source mapping instead of the
wasm-level fallback:

```jsonc
{
  "type": "stellar",
  "request": "launch",
  "name": "Replay add(4, 3)",
  "rawTrace": "${workspaceFolder}/traces/add.trace.jsonl",
  "wasmPath": "${workspaceFolder}/../test/fixtures/adder-debug.wasm"
}
```

Record a trace with the [`stellar-trace`](./trace-cli.md) CLI.

## Examples

### 1. Debug a single transaction

The smallest live configuration: build the crate in the workspace folder, invoke
one function, and debug it. There is one deploy and one invoke, and `trace`
defaults to the last step.

```jsonc
{
  "type": "stellar",
  "request": "launch",
  "name": "Debug add(1, 2)",
  "transactions": [
    { "kind": "deploy", "id": "adder", "contract": "${workspaceFolder}" },
    { "kind": "invoke", "contract": "adder", "function": "add",
      "args": { "a": 1, "b": 2 } }
  ]
}
```

### 2. Deploy a complex system, debug one call into it

Deploy several contracts, initialize them, wire their addresses together with
`${contract:<id>}`, seed some state, then debug a later call. Here we trace the
`swap` invoke by giving it an `id` and pointing `trace` at it — so the earlier
setup runs but the session opens on the call you care about.

```jsonc
{
  "type": "stellar",
  "request": "launch",
  "name": "Debug router.swap",
  "transactions": [
    { "kind": "deploy", "id": "token_a", "wasm": "${workspaceFolder}/wasm/token.wasm" },
    { "kind": "deploy", "id": "token_b", "wasm": "${workspaceFolder}/wasm/token.wasm" },
    { "kind": "deploy", "id": "router", "contract": "${workspaceFolder}/router" },

    { "kind": "invoke", "contract": "token_a", "function": "__constructor",
      "args": { "admin": "${sourceAddress}", "decimals": 7, "name": "A", "symbol": "A" } },
    { "kind": "invoke", "contract": "token_b", "function": "__constructor",
      "args": { "admin": "${sourceAddress}", "decimals": 7, "name": "B", "symbol": "B" } },

    { "kind": "invoke", "contract": "router", "function": "__constructor",
      "args": { "token_a": "${contract:token_a}", "token_b": "${contract:token_b}" } },

    { "kind": "invoke", "contract": "token_a", "function": "mint",
      "args": { "to": "${sourceAddress}", "amount": "1000000" } },

    { "kind": "invoke", "id": "the_swap", "contract": "router", "function": "swap",
      "args": { "from": "${sourceAddress}", "amount_in": "1000", "min_out": "990" } }
  ],
  "trace": "the_swap"
}
```

### 3. Complex parameter types

Enums, tuples, structs, nested vectors, addresses, and large integers, all in
named `args`:

```jsonc
{
  "type": "stellar",
  "request": "launch",
  "name": "Debug pool.submit",
  "transactions": [
    { "kind": "deploy", "id": "pool", "contract": "${workspaceFolder}" },
    { "kind": "invoke", "contract": "pool", "function": "submit",
      "args": {
        "from": "${sourceAddress}",
        "spender": "${sourceAddress}",
        "requests": [
          [ { "tag": "Supply" }, "${contract:pool}", "1000000" ],
          [ { "tag": "Borrow" }, "${contract:pool}", "-500" ]
        ],
        "config": { "collateral": true, "cap": "170141183460469231731687303715884105727" }
      } }
  ],
  "trace": "last"
}
```
