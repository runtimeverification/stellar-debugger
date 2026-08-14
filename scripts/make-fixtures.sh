#!/usr/bin/env bash
# Regenerates the golden fixture pairs under test/fixtures/:
#   adder-debug.{wasm,trace.jsonl}     — examples/adder, a trace of add(4, 3)
#   stepper-debug.{wasm,trace.jsonl}   — examples/stepper, a trace of sum_triples(3)
#   control-debug.wasm + one control-<fn>.trace.jsonl per control-flow construct
#
# Each wasm and its trace MUST be regenerated together — the trace's `pos`
# values are byte offsets into that exact binary, so they only make sense as a
# matched pair. `scripts/verify-addresses.mjs` re-checks each pair afterwards.
#
# Prereqs: the `stellar` CLI and `komet-node` on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."

# Compile src/ to out/, which both scripts below load the real parsers from.
npm run pretest

# Build with DWARF: keep debug info and skip symbol stripping. The wasm under
# release/deps/ is the pristine wasm-ld output — `stellar contract build`'s
# metadata injection rewrites release/<name>.wasm and EMPTIES its .debug_line
# programs, so only the deps/ binary is usable for source mapping. opt-level=0
# is what preserves per-statement line info (docs/stepping.md, "Build
# prerequisite"); the adder and stepper fixtures deliberately keep the default
# optimization instead, so the suite also covers optimized builds.
build() { # <example-dir> <crate-name> <fixture-name> [extra env...]
  local dir=$1 crate=$2 fixture=$3
  shift 3
  (cd "examples/$dir" && \
    env CARGO_PROFILE_RELEASE_DEBUG=true CARGO_PROFILE_RELEASE_STRIP=none "$@" \
    stellar contract build)
  cp "examples/$dir/target/wasm32v1-none/release/deps/$crate.wasm" "test/fixtures/$fixture.wasm"
}

capture() { # <fixture-name> <function> <args-json> [trace-name]
  local fixture=$1 fn=$2 args=$3 name=${4:-$1}
  node scripts/capture-trace.mjs \
    --wasm "test/fixtures/$fixture.wasm" \
    --function "$fn" --args-json "$args" \
    --trace-out "test/fixtures/$name.trace.jsonl"
  node scripts/verify-addresses.mjs \
    --wasm "test/fixtures/$fixture.wasm" \
    --trace "test/fixtures/$name.trace.jsonl"
}

build adder adder adder-debug
capture adder-debug add '{"a":4,"b":3}'

# The stepper contract exercises a real `call` (#[inline(never)] helper) and a
# loop (backward br_if) — the fixture behind the stepping-semantics tests.
build stepper stepper stepper-debug
capture stepper-debug sum_triples '{"n":3}'

# The control contract isolates one Rust construct per entry point. One wasm
# feeds all five traces.
build control control control-debug CARGO_PROFILE_RELEASE_OPT_LEVEL=0
capture control-debug seq        '{"n":7}' control-seq
capture control-debug branch     '{"n":3}' control-branch
capture control-debug count      '{"n":3}' control-count
capture control-debug while_call '{"n":3}' control-while_call
capture control-debug choose     '{"n":7}' control-choose
