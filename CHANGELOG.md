# Changelog

All notable changes to this extension are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

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
