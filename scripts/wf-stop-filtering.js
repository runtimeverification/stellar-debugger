export const meta = {
  name: 'stop-filtering-tdd',
  description: 'TDD: suppress declaration/brace statement stops (docs/stepping.md S17/S18)',
  phases: [
    { title: 'Red', detail: 'test-writer updates/adds failing tests for S17/S18' },
    { title: 'Red-verify', detail: 'confirm the new tests fail for the right reason' },
    { title: 'Green', detail: 'implementer makes the suite pass' },
    { title: 'Green-verify', detail: 'full suite + check-types + lint green' },
    { title: 'Review', detail: 'adversarial review of tests + implementation' },
  ],
};

// ---------------------------------------------------------------------------
// Authoritative, empirically-verified inputs (measured by a throwaway probe in
// the main session; do NOT re-derive — pin exactly).
// ---------------------------------------------------------------------------

const SPEC = `
docs/stepping.md now defines two new statement-stop rules (already written — read
the "Statement stops: declarations and braces" section and the updated "Fixtures"
section; treat docs/stepping.md as the CONTRACT, do not edit it):

S17 (declaration suppression): a statement-granularity run start whose source
line is a DECLARATION is not a stop. Declarations:
  - attribute lines: trimmed text starts with "#[" or "#![" (includes the
    #[contractimpl] / #[contract] export shim).
  - item headers: fn (with any pub/const/async/unsafe/extern qualifiers), impl,
    trait, mod.
  EXCEPTION: an fn/impl/trait/mod header that is the ONLY run start of its
  function-body frame is KEPT (a fully collapsed one-line function still needs a
  step-in target). Attribute lines are NEVER kept by this exception.

S18 (brace suppression): a run start whose source line trimmed is "}", "};" or
"}," is not a stop UNLESS it is the function's final brace — a brace run start
immediately followed (in run order) by a run start of strictly SHALLOWER depth,
or followed by nothing. That one epilogue brace is kept; inner braces are not.

Global safety: if filtering would remove EVERY stop, the unfiltered run starts
stand (preserve S1/S2/S3). Instruction granularity and breakpoint resolution are
UNCHANGED — S17/S18 shape only where statement stepping rests. S1 (entry) now
lands on the first surviving statement stop.
`;

const INTERFACES = `
Implement exactly these (names/signatures are the contract the tests import):

1. src/debugAdapter/stops.ts — add (pure, no fs/vscode):
   export type LineRole = 'attribute' | 'signature' | 'brace' | 'statement';
   export function classifyLineRole(text: string | null): LineRole;
     - null -> 'statement'; classify the TRIMMED text:
       /^#!?\\[/ -> 'attribute'
       fn/impl/trait/mod item header -> 'signature'
         (fn regex allows leading: pub, pub(...), const, async, unsafe, extern, extern "C")
       /^}[,;]?$/ -> 'brace'
       else -> 'statement'
   export function statementStops(
     runStarts: readonly number[],
     depths: readonly number[],
     roleAt: (index: number) => LineRole,
   ): number[];
     Reference algorithm (VALIDATED — implement precisely):
       keepBrace(p): d = depths[runStarts[p]];
                     return p === runStarts.length-1 || depths[runStarts[p+1]] < d;
       keptSameDepthLater(p): d = depths[runStarts[p]];
         for q = p+1 .. end:
           dq = depths[runStarts[q]];
           if dq < d: return false;               // frame returned
           if dq === d:
             r = roleAt(runStarts[q]);
             if r === 'statement': return true;
             if r === 'brace' && keepBrace(q): return true;
         return false;
       for p in 0..len:
         i = runStarts[p]; r = roleAt(i);
         'attribute' -> drop;
         'statement' -> keep;
         'brace'     -> keep iff keepBrace(p);
         'signature' -> keep iff !keptSameDepthLater(p);
       if result empty && runStarts non-empty -> return [...runStarts];

2. src/sourcemap/SourceMapper.ts — add to the interface:
   sourceTextForIndex(index: number): string | null;   // raw source line, or null

3. src/sourcemap/DwarfSourceMapper.ts — implement sourceTextForIndex:
   use locationForIndex(index); if null -> null; read the file (cache lines per
   normalized path; inject a readFile fn defaulting to fs.readFileSync for
   testability, mirroring the existing fileExists injection); return
   lines[line-1] ?? null. Never throw (return null on read failure).

4. src/sourcemap/NullSourceMapper.ts — sourceTextForIndex returns null.

5. src/debugAdapter/SorobanDebugSession.ts — at the chokepoint where runStarts is
   computed (search "computeRunStarts"), compute the raw run starts, then set
   this.runStarts = statementStops(raw, this.depths,
     (i) => classifyLineRole(source.sourceTextForIndex(i))).
   Nothing else downstream changes.
`;

const GROUND_TRUTH = `
Post-S17/S18 statement stops (trace index = line @ depth). These are the exact
sequences the model-level tests must pin (verified against the committed
fixtures):

control-seq:       236=24@2 249=25@2 262=26@2 265=28@2
control-branch:    226=33@2 244=36@2 245=33@2 246=38@2 248=39@2
control-count:     228=43@2 233=44@2 400=45@2 414=44@2 547=45@2 561=44@2 694=45@2 708=44@2 805=47@2 808=48@2
control-while_call:228=53@2 231=54@2 234=55@2 243=56@2 266=16@3 278=18@3 291=57@2 305=55@2 314=56@2 337=16@3 349=18@3 362=57@2 376=55@2 385=56@2 408=16@3 420=18@3 433=57@2 447=55@2 456=59@2 459=60@2
stepper:           21=25@0 27=26@0 29=15@1 39=25@0 44=26@0 46=15@1 56=25@0 61=26@0 63=15@1 73=25@0
adder:             29=16@0   (single stop; both #[contractimpl] records 6 & 40 dropped)

Dropped by S17 (for reference): control shim 6/21 (:20) in every control trace;
each pub fn signature (seq:219=23, branch:219=31, count:219=42, while_call:219=52,
choose:219=63); control-while_call the 3 'fn bump' signatures (249/320/391 = :15);
stepper shim+epilogue (5 & 84 = :20). KEPT by S17 exception: stepper triple :15
(29/46/63) — its sole frame stop. KEPT by S18: every control function-final '}'.
`;

const CONSTRAINTS = `
STRICT TDD ROLES:
- Test-writer: edits ONLY test/** (and test fixtures/helpers). NEVER touches src/**
  or docs/**. Must make tests fail FIRST (red) for the right reason.
- Implementer: edits ONLY src/**. NEVER edits test/** or docs/**. If a test looks
  wrong, report it — do not change it.
- Both: docs/stepping.md is already written and is the authoritative spec — read
  it, never edit it.

Existing tests that ALREADY encode the OLD (pre-filter) stops and MUST be updated
to the ground truth above:
- test/controlStepping.test.ts  (model-level exact stop arrays; the runStops
  helper must apply statementStops; update every deepStrictEqual and the
  per-construct sub-assertions, e.g. the bump-entry line is now :16 not :15,
  bump body lines are :16/:18).
- test/dapControlStepping.test.ts (DAP-level: entry now lands on the first body
  statement — seq entry :24 not the :20 shim; stepIn at :56 descends to :16).
- test/dapStepping.test.ts and test/dap.test.ts (stepper/adder DAP: adder entry
  is now :16; stepper entry is :25; stepper stepIn into triple stays :15 (kept);
  last-stop/clamp assertions shift to the new final stops).
Do NOT change tests that pin the RAW engine (computeRunStarts/computeDepths in the
"stops:" describes) — filtering is a separate function with its OWN new unit tests.

NEW unit tests required:
- classifyLineRole: attribute (#[..], #![..]), signature (pub fn / fn / const fn /
  impl / trait / mod), brace (}, };, },), statement (let, if, for, while, match,
  assignment, bare expr), and null -> 'statement'.
- statementStops: drops attributes; keeps a function-final brace but drops an
  inner brace; drops a signature that has a later same-depth stop; keeps a
  signature that is its frame's sole stop; never returns empty for non-empty input.

Run tests with:  npm run pretest >/tmp/pt.txt 2>&1 && npx mocha out/test/<file>.test.js
Full suite: npm test  (compiles via pretest first). check-types: npm run check-types.
`;

// Schemas kept intentionally minimal (only the field the control flow needs is
// required) — an over-strict schema aborted a prior run on a cosmetic retry cap.
const ROLE_SCHEMA = {
  type: 'object',
  required: ['summary'],
  properties: {
    summary: { type: 'string' },
    filesTouched: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
};

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    details: { type: 'string' },
    failingTests: { type: 'array', items: { type: 'string' } },
    rightReason: { type: 'boolean' },
  },
};

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['approved'],
  properties: {
    approved: { type: 'boolean' },
    testIssues: { type: 'array', items: { type: 'string' } },
    implIssues: { type: 'array', items: { type: 'string' } },
  },
};

// ---------------------------------------------------------------------------

// RED phase already completed by the test-writer in a prior run and the red
// state was verified out-of-band (the only compile errors are the intended
// missing statementStops/classifyLineRole/LineRole/sourceTextForIndex symbols;
// the DAP test files compile clean). The test edits are on disk:
// test/stops.test.ts (new) + controlStepping/dap/dapStepping/dapControlStepping
// (updated). This run resumes the loop at Green.
log('Red pre-verified out-of-band (test-writer complete; red state confirmed). Starting Green.');

phase('Green');
let implFeedback = '';
let greenOk = false;
let greenInfo = null;
let reviewInfo = null;
for (let round = 0; round < 3 && !greenOk; round++) {
  await agent(
    `You are the IMPLEMENTER in a strict TDD loop for the simbolik-komet Soroban debugger at /workspace.
The failing tests define the target behavior. Make the WHOLE suite pass.

${SPEC}
${INTERFACES}
${GROUND_TRUTH}
${CONSTRAINTS}

${round > 0 ? `Previous attempt still not green / review found issues:\n${implFeedback}\nAddress it.` : ''}

Edit ONLY src/**. Implement classifyLineRole + statementStops in stops.ts,
sourceTextForIndex in SourceMapper interface + DwarfSourceMapper + NullSourceMapper,
and wire statementStops into SorobanDebugSession at the runStarts chokepoint.
Do NOT edit any test/** or docs/**. If a test appears wrong, report it in notes
instead of editing it. Run npm test + npm run check-types until green.`,
    { label: 'implementer', phase: 'Green', schema: ROLE_SCHEMA },
  );

  phase('Green-verify');
  greenInfo = await agent(
    `You verify the GREEN state for a TDD loop at /workspace. Run, capturing output:
  npm run check-types  (expect exit 0)
  npm run lint         (expect exit 0)
  npm test             (expect 0 failing)
Report ok=true ONLY if check-types is clean, lint is clean, and the full mocha suite
has 0 failing. List any failing test names and the salient error lines in details.`,
    { label: 'green-verify', phase: 'Green-verify', schema: VERIFY_SCHEMA },
  );
  if (greenInfo?.ok !== true) {
    implFeedback = `Not green yet: ${greenInfo?.details ?? ''}\nFailing: ${(greenInfo?.failingTests ?? []).join(', ')}`;
    log(`Green not reached (round ${round + 1}).`);
    continue;
  }

  phase('Review');
  reviewInfo = await agent(
    `You are the REVIEWER in a strict TDD loop at /workspace. The suite is green.
Adversarially review the diff for this change (git diff on src/** and test/**;
docs/stepping.md is the spec — read but it's out of scope to change).

Judge BOTH:
- Test quality: do the tests actually pin S17/S18 per docs/stepping.md and the
  ground truth? Would a plausible wrong implementation (e.g. dropping ALL braces
  incl. the epilogue, or dropping a collapsed one-liner's sole signature stop, or
  keeping the #[contractimpl] shim) still pass? Are the exact stop arrays correct?
- Impl quality: does classifyLineRole handle the qualifier/edge cases; does
  statementStops match the reference algorithm (epilogue-brace kept, inner brace
  dropped, signature kept only as sole frame stop, never-empty fallback); is the
  session wired at the single chokepoint without breaking instruction granularity
  or breakpoints; does sourceTextForIndex never throw?

Return approved=true only if both are sound. Put concrete, actionable problems in
testIssues[] (routed to the test-writer) and implIssues[] (routed to the implementer).`,
    { label: 'reviewer', phase: 'Review', schema: REVIEW_SCHEMA },
  );

  if (reviewInfo?.approved === true) {
    greenOk = true;
    break;
  }
  // Route review issues back.
  if ((reviewInfo?.testIssues ?? []).length > 0) {
    await agent(
      `TEST-WRITER: the reviewer raised issues with the TESTS. Fix ONLY test/**.
${SPEC}
${GROUND_TRUTH}
Issues:\n- ${(reviewInfo.testIssues).join('\n- ')}\nApply fixes now and report.`,
      { label: 'test-writer:fix', phase: 'Review', schema: ROLE_SCHEMA },
    );
  }
  implFeedback = `Reviewer not approved. implIssues:\n- ${(reviewInfo.implIssues ?? []).join('\n- ')}\ntestIssues:\n- ${(reviewInfo.testIssues ?? []).join('\n- ')}`;
  log(`Review round ${round + 1} not approved; routing issues back.`);
}

return {
  status: greenOk ? 'APPROVED' : 'NEEDS_ATTENTION',
  green: greenInfo,
  review: reviewInfo,
};
