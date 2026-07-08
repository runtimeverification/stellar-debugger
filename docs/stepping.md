# Stepping semantics

The contract between the debugger's replay engine and the user's expectations
when stepping through a recorded trace — at **statement** (Rust source) and
**instruction** (Disassembly View) granularity, forward and backward. The
systematic test suite (`test/stepping*.test.ts`, `test/dap.test.ts`) pins these
rules; every rule ID below is cited by at least one test.

## Model

Every stepping decision is derived from four per-record facts:

- **visible(i)** — the record has a *validated* position (`positions[i] !==
  null`): it corresponds to a real instruction in the disassembly. Records
  that fail validation (global-initializer records whose `pos` is in another
  section's address space, synthetic host records with `pos: null`) are
  **invisible**: no address, no source, nothing to show. *(In a wasm-less
  `rawTrace` replay, the raw `pos` values serve as the positions, so `pos:
  null` records are the invisible ones.)*
- **mapped(i)** — the record has a source location (`lineKey(i) !== null`).
  Mapped ⇒ visible.
- **depth(i)** — the call depth. Because komet-node emits **no record for
  implicit returns** (a callee falling off its end produces no `return`), depth
  cannot be reconstructed from `call`/`return` opcodes alone. When a
  disassembly with function-body ranges is available, depth MUST be derived
  from the function membership of consecutive visible records: entering a
  different function's body right after a `call`-class record pushes a frame;
  a transition back to the site right after the matching call pops it —
  whether or not a `return` record was emitted. Without function ranges
  (wasm-less replay), the opcode-based reconstruction remains the fallback.
- **run(i)** — the *line run* a mapped record belongs to. Scanning the trace
  in order over visible records, a mapped record **starts a new run** iff any
  of:
  - its line key differs from the current run's key, or
  - its depth differs from the current run's depth, or
  - it **re-executes** a code offset the current run has already covered (the
    same source line runs again — a loop back-edge landed inside this run).
    A same-key record at a *new* offset merely extends the run: one line often
    spans several disjoint address ranges (e.g. a loop's condition and its
    back-edge `br` are both the `while` line and form one stop per iteration).
  Unmapped visible records and deeper-frame records in between do **not** break
  the current run (they are glue inside it). A run is identified by its first
  index (its *run start*). One run = one user-perceived execution of one
  source line. In the stepper fixture this yields exactly four line-25 runs:
  the initial loop entry plus one per re-test of the `while` condition.

**Stop points.** At instruction granularity the stop points are the visible
records. At statement granularity the stop points are the run starts. The
cursor must only ever come to rest on a stop point of the active granularity —
never on an invisible record, and (at statement granularity) never on an
unmapped one, except when the trace contains no stop point at all.

## Rules

### Session start and run boundaries

- **S1** (entry stop): the initial stop lands on the first stop point of the
  trace — the first run start when line info exists, else the first visible
  record, else index 0. The user's first view is never a sourceless,
  addressless frame.
- **S2** (forward exhaustion): a forward step (any kind, any granularity) with
  no further stop point ahead moves to the **last** stop point of the trace
  (staying put when already there) and still reports a stop. It never
  strands the cursor on trailing invisible/unmapped records.
- **S3** (backward exhaustion): a backward step with no earlier stop point
  moves to the **first** stop point (staying put when already there). It never
  falls off onto the unmapped records at the head of the trace.

### Statement granularity (source stepping)

- **S4** (step in): `stepIn` moves to the next run start in trace order,
  regardless of depth — entering a callee stops at the callee's first mapped
  line.
- **S5** (step over): `next` moves to the next run start whose depth is ≤ the
  current depth: a call inside the current line is stepped over in one press —
  including calls whose return is implicit (no `return` record). One press,
  one new line.
- **S6** (per-iteration loop stops): a source line that executes again (loop
  back-edge) is a **new** run: `next`/`stepIn` stop once per iteration, even
  when consecutive iterations are separated only by unmapped records.
- **S7** (step out): `stepOut` moves to the next run start whose depth is <
  the current depth. At the outermost recorded depth it behaves like S2
  (runs to the last stop point).
- **S8** (reverse step): `stepBack` at statement granularity is the reverse of
  `next`: it moves to the start of the previous run with depth ≤ the current
  depth, skipping deeper-frame records. Landing is always on a run **start**
  (same index forward `continue`/breakpoints would use), so forward and
  backward visits of a line agree on the cursor position.
- **S9** (reverse at loop): reverse-stepping through a loop revisits the same
  per-iteration stops as forward stepping, in reverse order.

### Instruction granularity (Disassembly View)

- **S10** (visible-only instruction steps): `stepIn`/`next`/`stepBack` with
  `granularity: 'instruction'` move to the next/previous **visible** record.
  Every press moves the Disassembly View highlight by exactly one real
  instruction row (`next` additionally skips deeper frames, i.e. steps over
  calls; `stepIn` does not). No dead presses on invisible records, in either
  direction.
- **S11** (instruction pointer honesty): every stop at instruction granularity
  has a defined `instructionPointerReference` equal to the current record's
  validated position. (At statement granularity stops, the reference is the
  run start's position.)

### Continue and breakpoints

- **S12** (one stop per line execution): a source breakpoint resolves to the
  **run starts** of its line. `continue` hits a line once per execution (once
  per loop iteration), not once per wasm instruction of the line.
- **S13** (reverse/forward symmetry): `reverseContinue` stops at exactly the
  same indices as forward `continue` would for the same breakpoints, in
  reverse order — landing on run starts, not run ends.
- **S14** (continue exhaustion): `continue` with no breakpoint ahead settles on
  the last stop point (S2); `reverseContinue` with none behind settles on the
  first stop point (S3, reported as a plain stop, not a breakpoint hit).
- **S15** (instruction breakpoints): an instruction breakpoint at address A
  stops at every record whose validated position is A — once per execution of
  that instruction (e.g. once per call for an address inside a callee, once
  per iteration for an address inside a loop body).

### Frames

- **S16** (frame consistency): whenever the cursor rests on a mapped record,
  the stack frame carries that record's source and line; the frame is
  sourceless only when the cursor legitimately rests on an unmapped stop point
  (instruction granularity, or no line info at all).

## Build prerequisite: optimization level

Statement stepping is only as good as the DWARF line table the build emits, and
the line table is destroyed by optimization long before any stepping code runs:

- **`opt-level = "z"` / `"s"` / `"3"`** collapse an entire function's statements
  onto a single source line (the `#[contractimpl]`/`impl` line), so a function
  has **one** statement stop — every step-in / step-over / continue / step-back
  is a no-op. This is what made the incrementer contract appear to have no
  working source stepping at all.
- **`opt-level = "1"`** keeps line info for statements that survive as distinct
  operations (e.g. host-call-heavy code) but still folds pure-arithmetic
  functions onto one line and flattens loops to a single stop.
- **`opt-level = "0"`** preserves per-statement line info across every construct
  (sequence, if/else, `for`, `while`, `match`, calls) — this is the only level
  at which stepping behaves as a debugger user expects.

Therefore the debugger builds contracts with `CARGO_PROFILE_RELEASE_OPT_LEVEL=0`
injected (alongside `CARGO_PROFILE_RELEASE_DEBUG=true` /
`CARGO_PROFILE_RELEASE_STRIP=none`; see `ContractBuilder`), overriding the
crate's production `opt-level` for the debug build only — the crate's
`Cargo.toml` is never edited. Traces are correspondingly larger (opt-0 emits
~10–20× more records than opt-z); that is the cost of statement-level debugging.

## Fixtures pinning these rules

- `test/fixtures/adder-debug.{wasm,trace.jsonl}` — straight-line code, 6
  leading invisible records, wide unmapped gaps between mapped runs
  (S1–S3, S10–S12 basics).
- `test/fixtures/stepper-debug.{wasm,trace.jsonl}` — `sum_triples(3)` on
  `examples/stepper`: a real `call` to an `#[inline(never)]` helper **with
  implicit return** (no `return` record — S5, S7, S8), and a 3-iteration
  `while` loop (S6, S9, S12, S13, S15). Ground truth (record ↦ line):
  entry shim = lib.rs:20, loop condition = lib.rs:25 (records 21–26, 39–43,
  56–60, 73–77), call line = lib.rs:26 (27–28, 44–45, 61–62), callee body =
  lib.rs:15 (29–31, 46–48, 63–65), epilogue `return` = lib.rs:20 (84).
  Correct depths: callee records 29–31/46–48/63–65 are one frame deeper than
  the surrounding loop records; the trace both enters and leaves `triple`
  three times.

- `test/fixtures/control-debug.wasm` + `control-{seq,branch,count,while_call,choose}.trace.jsonl`
  — one opt-0 wasm (`examples/control`) shared by five traces, each isolating a
  Rust construct so the suite pins how source stepping crosses it. All five
  functions live in `impl Control` (the `#[contractimpl]` export shim maps to
  `lib.rs:20`, entered at depths 0 then 1; the function body runs at depth 2, a
  called `bump` at depth 3). Statement-stop ground truth (trace index ↦ line):
  - **seq(7)** — pure sequence: 6/21 (:20 shim), 219 (:23 sig), 236 (:24 `let a`),
    249 (:25 `let b`), 262 (:26 `let c`), 265 (:28 return). Lines strictly
    increase; one stop each (S4/S5 basics, no re-execution).
  - **branch(3)** — if/else, `3 <= 10` so the **else** arm runs: 219 (:31 sig),
    226 (:33 `if`), 244 (:36 else arm), 245 (:33 merge), 246 (:38 `r`), 248
    (:39). The **then** arm (`:34`) never appears — stepping enters only the
    taken arm.
  - **count(3)** — `for i in 0..3`: 219 (:42 sig), 228 (:43 `let acc`), then the
    `for` header (:44) and the body `acc += i` (:45) alternate per iteration (:44
    at 233/414/561/708 — three iterations plus the terminating `next() -> None`
    check; :45 at 400/547/694 — the body), 805 (:47 `acc`), 808 (:48). The body
    line stops exactly once per iteration (S6/S12) — the defining loop behavior.
  - **while_call(3)** — `while` + a real `bump` call: 52/53/54 setup, then per
    iteration 55 (`while`), 56 (`acc += bump(i)`), **15/16/18 = `bump` body at
    depth 3**, 57 (`i += 1`); three times; then 55 (final test), 59/60. `stepIn`
    at :56 descends to :15; `next` at :56 steps over to :57 (S4 vs S5); the
    callee returns implicitly (no `return` record — S5/S7/S8).
  - **choose(7)** — `match x % 3`, `7 % 3 == 1` so arm **`1 => 200`** runs: 219
    (:63 sig), 228 (:64 `match`), 240 (:66 arm), 243 (:69 `r`), 245 (:70). Arms
    `0 =>` (:65) and `_ =>` (:67) never appear.

Regenerate all pairs together with `scripts/make-fixtures.sh`.

## Known limitations of depth reconstruction

The frame stack is reconstructed from **function membership** of consecutive
visible records (spec Model/depth), which is robust to komet-node's missing
implicit-return records but has two documented edges the fixtures do not
exercise:

- **Direct self-recursion** (`A` calls `A`) is invisible to a membership-based
  stack: the callee has the same function identity as the caller, so no frame
  is pushed and the recursion appears flat. Mutual recursion (`A → B → A`) is
  handled, because the identities differ. No contract in scope recurses
  directly; revisit if that changes.
- **Indirect and tail calls** (`call_indirect`, `return_call`,
  `return_call_indirect`) are treated as frame entries only if komet-node
  spells them with those exact opcode names. Only plain `call` is confirmed
  against komet output; a contract using trait-object dispatch could emit a
  spelling we don't recognize (or `unknown`), in which case the call would be
  mistaken for straight-line code. Capturing a fixture from such a contract to
  pin the real spelling is future work.
