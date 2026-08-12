# Changelog

All notable changes to this extension are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Stellar ledger inspection.** A new **Ledger** scope shows the chain state at
  every step: contract storage across all three durabilities with their TTLs,
  account balances, the ledger sequence and close time, the executing contract's
  wasm hash and instance TTL, the host object table, and the open contract-call
  stack. Values render as Soroban types with `C…`/`G…` addresses, and composites
  expand. Storage is reconstructed from the trace's own call baselines and write
  events — including undoing the writes of a sub-call that trapped — so it
  matches what the contract would read.
- **WebAssembly globals.** A new **Globals** scope lists the executing module's
  globals by module-relative index, for traces that carry them.
- The `soroban-trace` CLI reports the same state per stop as `globals` and
  `ledger`, with a `changed` flag marking the storage entries that moved since
  the previous stop, and `hasGlobals`/`hasLedger` announced in `meta`.
- New contributor spec: [`docs/state-inspection.md`](docs/state-inspection.md),
  whose numbered rules (G1–G4, L1–L15) the test suite pins.

### Changed

- **Requires komet v0.1.87 or newer.** That release reorganised the trace: every
  record now names itself with a `kind` field, and the operands that used to ride
  inside `instr` are named fields of the record. The parser reads that shape and
  rejects a record without a `kind`, so a trace recorded against an older komet
  no longer replays — re-record it. Failing loudly is deliberate: a trace this
  parser cannot classify would otherwise open a session with every state view
  mysteriously empty.
- The cross-contract gate no longer relies on komet-node tagging each trace
  record with the contract executing at it. The adapter folds that out of the
  `callContract`/`endWasm` boundaries the trace already carries, so nothing needs
  to be sent per record for it.

### Fixed

- Debug sessions start ~6 seconds faster: rendering Stellar addresses no longer
  pulls `@stellar/stellar-sdk` into the debug adapter's module graph (a local
  strkey encoder replaces it), which had been delaying every session past the
  DAP handshake timeout.

- Launch argument encoding now rejects invalid integer values instead of
  silently accepting them: non-integer and out-of-range `u32`/`i32` values (the
  SDK encoded these verbatim) and out-of-range wide integers such as `u64`
  `2^64` (the SDK silently wrapped these to `0`) now raise a clear
  `ScValEncodeError`.
- DWARF type resolution no longer hangs on malformed debug info containing a
  cyclic `typedef`/qualifier chain; `stripTypedefs` now terminates on cycles.

[Unreleased]: https://github.com/runtimeverification/simbolik-komet/compare/v0.0.1...HEAD

## [0.0.1]

Initial release: time-travel debugging for Stellar/Soroban smart contracts, with
Rust source-level and WebAssembly stepping (forward and backward), state
inspection, a one-click build-deploy-debug pipeline, and offline replay of
recorded runs.

[0.0.1]: https://github.com/runtimeverification/simbolik-komet/releases/tag/v0.0.1
