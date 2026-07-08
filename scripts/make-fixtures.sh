#!/usr/bin/env bash
# Regenerates the golden fixture pairs:
#   test/fixtures/adder-debug.wasm          — pristine deps build of examples/adder with DWARF
#   test/fixtures/adder-debug.trace.jsonl   — a real komet-node trace of add(4, 3) on that wasm
#   test/fixtures/stepper-debug.wasm        — pristine deps build of examples/stepper with DWARF
#   test/fixtures/stepper-debug.trace.jsonl — a real komet-node trace of sum_triples(3)
#
# Each wasm and its trace MUST be regenerated together — the trace's `pos`
# values are byte offsets into this exact binary, so they only make sense as a
# matched pair.
#
# Prereqs: the `stellar` CLI and `komet-node` on PATH (verify-addresses.mjs
# captures the trace against a live komet-node it spawns itself).
set -euo pipefail
cd "$(dirname "$0")/.."

# Build with DWARF: keep debug info and skip symbol stripping. The wasm under
# release/deps/ is the pristine wasm-ld output — `stellar contract build`'s
# metadata injection rewrites release/adder.wasm and EMPTIES its .debug_line
# programs, so only the deps/ binary is usable for source mapping.
(cd examples/adder && \
  CARGO_PROFILE_RELEASE_DEBUG=true CARGO_PROFILE_RELEASE_STRIP=none \
  stellar contract build)
cp examples/adder/target/wasm32v1-none/release/deps/adder.wasm test/fixtures/adder-debug.wasm

# Capture the matching trace (and re-verify the address convention) against
# komet-node. Needs out/ from a compile of src/.
npm run pretest
node scripts/verify-addresses.mjs \
  --wasm test/fixtures/adder-debug.wasm \
  --trace-out test/fixtures/adder-debug.trace.jsonl

# The stepper contract exercises a real `call` (#[inline(never)] helper) and a
# loop (backward br_if) — the fixture behind the stepping-semantics tests.
(cd examples/stepper && \
  CARGO_PROFILE_RELEASE_DEBUG=true CARGO_PROFILE_RELEASE_STRIP=none \
  stellar contract build)
cp examples/stepper/target/wasm32v1-none/release/deps/stepper.wasm test/fixtures/stepper-debug.wasm
node scripts/capture-trace.mjs \
  --wasm test/fixtures/stepper-debug.wasm \
  --function sum_triples \
  --args-json '[{"value":3,"type":"u32"}]' \
  --trace-out test/fixtures/stepper-debug.trace.jsonl

# The control contract isolates one Rust construct per entry point (sequence,
# if/else, for, while+call, match). It is built at opt-level=0 (unlike adder/
# stepper) because only opt-0 keeps per-statement DWARF line info for pure code
# — see docs/stepping.md "Build prerequisite". One wasm feeds all five traces.
(cd examples/control && \
  CARGO_PROFILE_RELEASE_DEBUG=true CARGO_PROFILE_RELEASE_STRIP=none CARGO_PROFILE_RELEASE_OPT_LEVEL=0 \
  stellar contract build)
cp examples/control/target/wasm32v1-none/release/deps/control.wasm test/fixtures/control-debug.wasm

control_case() { # <function> <args-json>
  node scripts/capture-trace.mjs \
    --wasm test/fixtures/control-debug.wasm \
    --function "$1" --args-json "$2" \
    --trace-out "test/fixtures/control-$1.trace.jsonl"
}
control_case seq        '[{"value":7,"type":"u32"}]'
control_case branch     '[{"value":3,"type":"u32"}]'
control_case count      '[{"value":3,"type":"u32"}]'
control_case while_call '[{"value":3,"type":"u32"}]'
control_case choose     '[{"value":7,"type":"u32"}]'
