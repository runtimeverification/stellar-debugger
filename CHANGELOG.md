# Changelog

All notable changes to this extension are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- When a dependency is missing, the debugger now says which one, how to install it, and where to set its path, and links to the README's new Troubleshooting section. This replaces messages like `build command exited with code 127` and `trace line 1: 'kind' must be a non-empty string`, which named a symptom rather than a cause.
- A komet-node that cannot be started — not installed, or not executable — fails the launch immediately instead of after the 60-second health-check timeout.
- A komet-node that exits during startup is reported with its exit code and its own last output, rather than as a health-check timeout.
- A komet-node older than komet v0.1.87 is now diagnosed as out of date, both when it rejects the `traceTransaction` request and when it returns the pre-v0.1.87 trace shape.
- An attach-mode launch (`node.attach`) that finds nothing listening says so, instead of suggesting an install you already have.
- A failed contract build is classified from its output: a missing Stellar CLI, a missing Rust toolchain, a missing WebAssembly target, and an ordinary compile failure each get their own message and fix.
- An unreadable `rawTrace` or `wasmPath` names the attribute it came from and why the file could not be read, instead of surfacing a raw `ENOENT`.
- `stellar-trace` and `stellar-dap` print these messages on their own, without a stack trace in front of them.

### Added

- `node.healthTimeoutMs` sets how long to wait for komet-node to start answering requests (default 60 s).

## [0.1.0] — 2026-08-21

This is the first public release. The extension debugs Stellar smart contracts written in Rust, in VSCode or from the command line, and it steps backward as readily as forward.

### Added

- You can set breakpoints in your Rust source and step through it line by line, inspecting your own variables at every stop.
- You can step backward. Stepping back, stepping back out of a call, and running backward to the previous breakpoint are all as fast as going forward, so overshooting the bug costs you nothing.
- The call stack shows every function that led to the current line, including the ones the compiler inlined away. Selecting a frame shows that frame's variables and jumps to its line.
- Stepping stays in the code you wrote. The debugger steps over Rust standard-library and dependency sources rather than into them, unless you set `justMyCode` to `false`.
- A launch configuration runs an ordered sequence of deployments and calls against one fresh local network, and names the call you want to debug. You can therefore set up state — run a constructor, deploy a second contract, seed storage — before the call under test.
- Call arguments are written as JSON, keyed by the parameter names in your contract's own signature. Structs, enums, tuples, vectors and maps all work without encoding anything by hand.
- The Ledger view shows the chain as your contract sees it at the current step: contract storage with its expiry, account balances, the ledger sequence number and close time, and the contracts currently on the call stack. It travels with you as you step.
- When you need to go below your source, the debugger also shows WebAssembly locals, the operand stack, globals and linear memory, and VSCode's Disassembly View steps through the instructions themselves in either direction.
- Debugging a contract takes one keypress. The extension builds it, starts a local network, deploys it, makes the call, and opens the session.
- A recorded run can be replayed later with no network and no toolchain installed. That makes a saved recording a reproducible bug report you can hand to someone else.
- Outside the editor, `stellar-trace` prints the execution of a call as JSON lines for use in scripts and CI, and `stellar-dap` serves the debugger over TCP so that editors such as Neovim, IntelliJ and Emacs can drive it.

### Requirements

- Debugging a contract requires [komet-node](https://github.com/runtimeverification/komet-node), the local Stellar network that runs it. It must be built with komet v0.1.87 or newer; an older build produces recordings this version cannot open, and says so rather than opening an empty session.
- Building and deploying a contract also requires a Rust toolchain with a WebAssembly target and the Stellar CLI. Replaying a recording requires neither.

[Unreleased]: https://github.com/runtimeverification/stellar-debugger/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/runtimeverification/stellar-debugger/releases/tag/v0.1.0
