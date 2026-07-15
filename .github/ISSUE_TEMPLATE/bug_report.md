---
name: Bug report
about: Report something that doesn't work as expected
title: ''
labels: bug
assignees: ''
---

## What happened

A clear description of the bug.

## What you expected

What you expected to happen instead.

## Steps to reproduce

1. …
2. …

## Repro trace (very helpful!)

Because the debugger replays a captured trace, the most useful thing you can
attach is a JSONL trace file that reproduces the problem. Add it to a launch
config via `rawTrace` and share it here — it reproduces the session with no
toolchain or komet-node required. If the issue involves Rust source mapping,
attach the matching `.wasm` too.

## Environment

- Extension version:
- VSCode version:
- OS:
- komet-node version (if using the live pipeline):
- Stellar CLI version (if using the live pipeline):

## Logs

Any relevant output from the Debug Console or the extension's output channel.
