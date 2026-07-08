export const meta = {
  name: 'control-stepping-tdd',
  description: 'TDD: pin per-construct source stepping over the control fixtures + inject opt-level=0 in ContractBuilder',
  phases: [
    { title: 'Red' },
    { title: 'Red-verify' },
    { title: 'Green' },
    { title: 'Green-verify' },
    { title: 'Review' },
  ],
}

// ---------------------------------------------------------------------------
// Shared context handed to every agent (fresh contexts — no shared memory).
// ---------------------------------------------------------------------------
const REPO = '/workspace'

const GROUND_TRUTH = `
GROUND TRUTH (verified live against komet-node AND offline via buildDebugArtifacts;
also written in docs/stepping.md "Fixtures"). One opt-0 wasm test/fixtures/control-debug.wasm
is SHARED by five traces test/fixtures/control-<fn>.trace.jsonl. Source: examples/control/src/lib.rs.
The #[contractimpl] export shim maps to lib.rs:20 (entered at depth 0 then 1); the function
body runs at depth 2; a called bump() runs at depth 3.

computeRunStarts (statement stop points), as "traceIndex=line@depth":
  seq(7):        6=20@0  21=20@1  219=23@2  236=24@2  249=25@2  262=26@2  265=28@2
  branch(3):     6=20@0  21=20@1  219=31@2  226=33@2  244=36@2  245=33@2  246=38@2  248=39@2
  count(3):      6=20@0  21=20@1  219=42@2  228=43@2  233=44@2  400=45@2  414=44@2  547=45@2  561=44@2  694=45@2  708=44@2  805=47@2  808=48@2
  while_call(3): 6=20@0  21=20@1  219=52@2  228=53@2  231=54@2  234=55@2  243=56@2  249=15@3  266=16@3  278=18@3  291=57@2  305=55@2  314=56@2  320=15@3  337=16@3  349=18@3  362=57@2  376=55@2  385=56@2  391=15@3  408=16@3  420=18@3  433=57@2  447=55@2  456=59@2  459=60@2
  choose(7):     6=20@0  21=20@1  219=63@2  228=64@2  240=66@2  243=69@2  245=70@2

Source line meanings (examples/control/src/lib.rs):
  15 bump fn sig | 16 let y=... | 17 y.wrapping_mul(2) | 18 }
  20 #[contractimpl] (export shim) | 21 impl Control {
  seq:    23 fn sig | 24 let a | 25 let b | 26 let c | 27 c | 28 }
  branch: 31 fn sig | 32 let r; | 33 if x>10 { | 34 THEN r=sub(10) | 35 } else { | 36 ELSE r=add(100) | 37 } | 38 r | 39 }
  count:  42 let acc | 43 for i in 0..n { | 44 acc+=i (body) | 45 } (back-edge) | 47 acc | 48 }
  while_call: 52 fn sig | 53 let acc | 54 let i | 55 while i<n { | 56 acc+=bump(i) | 57 i+=1 | 58 } | 59 acc | 60 }
  choose: 63 fn sig | 64 let r = match x%3 { | 65 0=>100 | 66 1=>200 (arm taken, 7%3==1) | 67 _=>300 | 68 } | 69 r | 70 }

Behavioral truths the suite MUST pin (cite docs/stepping.md rule IDs S1..S16):
  * seq: statement lines strictly increase; one stop per assignment (23,24,25,26) then return (28).
  * branch(3): the ELSE arm (:36) is a stop; the THEN arm (:34) NEVER appears (only-taken-arm).
  * count(3): the loop body line :44 stops once per iteration (>=3 times) — per-iteration loop stops (S6/S12).
  * while_call(3): stepIn at :56 descends into bump body (:15, one frame deeper); next (step-over) at :56
    goes to :57 WITHOUT stopping in bump; bump returns implicitly (no return record) yet depth returns to
    the caller (S5/S7/S8); bump body records are exactly one depth deeper than the surrounding loop.
  * choose(7): only the taken arm (:66) is a stop; arms :65 and :67 NEVER appear.
`

const HARNESS = `
TEST HARNESS FACTS:
- Offline replay uses the committed fixtures — NO komet-node needed. Run tests with: npm run pretest && npm test
  (pretest compiles src+test to out/ via tsconfig.test.json; test runs mocha; ~1-2 min; DAP tests spawn a child adapter).
- Pure/model-level pattern: see test/stepping.test.ts. Its fixture(name) helper loads <name>.wasm + <name>.trace.jsonl.
  The control fixtures do NOT follow that 1:1 naming (one control-debug.wasm feeds five control-<fn>.trace.jsonl),
  so add a helper that loads a given wasm + a given trace (e.g. fixturePair('control-debug','control-seq')).
  Build artifacts with buildDebugArtifacts(wasm, model, ()=>{}) then computeDepths(model.records, positions,
  disassembly.functionRanges) and computeRunStarts(positions, depths, i=>source.lineKeyForIndex(i)); map an index
  to a line with source.locationForIndex(i).line.
- DAP-level pattern: see test/dapStepping.test.ts. Launch a fixture with { rawTrace: <trace path>, wasmPath:
  test/fixtures/control-debug.wasm, function: '<fn>' } through DebugClient against test/support/adapterEntry.js.
  Stops are read from the top stack frame; its name carries a '[<index>/<last>]' probe (see the top()/expect() helpers).
  Use granularity 'statement' and 'instruction'. Reuse the existing helpers' style; keep to the same imports.
`

const CONSTRAINTS = `
HARD CONSTRAINTS:
- Repo root: /workspace. Only src/extension.ts may import 'vscode' — keep new/edited modules vscode-free.
- Do NOT modify committed fixtures (test/fixtures/*), scripts/*, examples/*, or docs/* — they are established ground truth.
- Never weaken a test to make it pass. If a test looks wrong, report it; do not silently edit around it.
- The one intended behavioral change is in src/build/ContractBuilder.ts: inject CARGO_PROFILE_RELEASE_OPT_LEVEL=0
  into the build env alongside the existing DEBUG/STRIP vars, guarded by the same debugInfo!==false condition
  (so debugInfo:false injects none of the three). Everything else (the stops.ts engine) already behaves per the
  ground truth above — characterization tests for it should pass as-is; if any fails that is a REAL bug to fix.
`

phase('Red')
const red = await agent(
  `You are the TEST-WRITER in a strict-TDD workflow. Write FAILING-FIRST tests; you may ONLY create/edit files
under ${REPO}/test/. You are FORBIDDEN from touching ${REPO}/src/ (if you think src is wrong, report it, don't edit it).

Deliver two things:

(1) A behavioral RED test for the one production change: extend ${REPO}/test/contractBuilder.test.ts so it also
asserts the build injects CARGO_PROFILE_RELEASE_OPT_LEVEL=0 by default and injects NONE of the three cargo env vars
when debugInfo:false. Follow the existing ENV_RECORDING_COMMAND pattern in that file (record the env var into env.txt
and assert on it). This test MUST fail right now (ContractBuilder does not yet inject opt-level) with an ASSERTION
failure (not a compile error).

(2) A CHARACTERIZATION suite pinning per-construct source stepping over the control fixtures. Create
${REPO}/test/controlStepping.test.ts (model level, mirroring test/stepping.test.ts) and add DAP-level cases to a new
${REPO}/test/dapControlStepping.test.ts (mirroring test/dapStepping.test.ts). Pin every "behavioral truth" listed in
the ground truth below, each citing the relevant S-rule from docs/stepping.md. These characterization tests should
PASS against the current engine (it is already correct) — that is expected and fine; they lock the behavior against
regression and prove the fixtures step as a user expects.

${GROUND_TRUTH}
${HARNESS}
${CONSTRAINTS}

When done, run \`cd ${REPO} && npm run pretest && npm test\` yourself to confirm the ContractBuilder opt-level test is
RED (assertion failure) and the characterization tests are GREEN. Report the exact names of the test(s) you intend to
be red. Return the new/edited test file paths, the red test name(s), and a one-paragraph summary.`,
  {
    phase: 'Red',
    label: 'test-writer',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        files: { type: 'array', items: { type: 'string' } },
        redTestNames: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string' },
      },
      required: ['files', 'redTestNames', 'summary'],
    },
  },
)
log(`test-writer: ${red?.files?.length ?? 0} files; red=${JSON.stringify(red?.redTestNames)}`)

phase('Red-verify')
const redCheck = await agent(
  `You are an INDEPENDENT VERIFIER. Do not edit anything. Run \`cd ${REPO} && npm run pretest && npm test\` and report
results. The test-writer intends these test(s) to be RED (failing) right now: ${JSON.stringify(red?.redTestNames)}.
For EACH named test, classify its status as one of: "pass", "fail-assertion" (it ran and an assertion failed — the
RIGHT kind of red), "fail-error" (it failed to compile or threw before asserting — the WRONG kind of red), or
"missing" (no such test found). Also report the whole suite's total/passing/failing counts and the tail of any
failures. Return structured results.`,
  {
    phase: 'Red-verify',
    label: 'red-verify',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        total: { type: 'number' },
        passing: { type: 'number' },
        failing: { type: 'number' },
        named: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              status: { type: 'string', enum: ['pass', 'fail-assertion', 'fail-error', 'missing'] },
            },
            required: ['name', 'status'],
          },
        },
        unexpectedFailures: { type: 'array', items: { type: 'string' } },
        outputTail: { type: 'string' },
      },
      required: ['total', 'passing', 'failing', 'named', 'unexpectedFailures', 'outputTail'],
    },
  },
)
const rightReasonRed = (redCheck?.named ?? []).some((t) => t.status === 'fail-assertion')
log(`red-verify: total=${redCheck?.total} failing=${redCheck?.failing} rightReasonRed=${rightReasonRed}`)
if (!rightReasonRed) {
  log('WARNING: no right-reason red among the named tests — the behavioral change may not be genuinely test-first. Continuing to implementation; the reviewer will scrutinize this.')
}

let implIssuesText = ''
let testIssuesText = ''
let review = null
const MAX_ROUNDS = 3
for (let round = 1; round <= MAX_ROUNDS; round++) {
  phase('Green')
  const impl = await agent(
    `You are the IMPLEMENTER in a strict-TDD workflow (round ${round}). You may edit ${REPO}/src/ only; you are
FORBIDDEN from editing any file under ${REPO}/test/ (if a test looks wrong, report it — do not edit it).

Make the whole suite green. The one intended change: in ${REPO}/src/build/ContractBuilder.ts, inject
CARGO_PROFILE_RELEASE_OPT_LEVEL=0 into the build env alongside the existing CARGO_PROFILE_RELEASE_DEBUG=true and
CARGO_PROFILE_RELEASE_STRIP=none, under the SAME debugInfo!==false guard (so debugInfo:false injects none of the
three). Update the BuildOptions.debugInfo doc-comment to mention opt-level. If any CHARACTERIZATION test is red, that
is a real engine bug — fix it in src/ (do NOT touch tests), consistent with docs/stepping.md.

${round > 1 ? `Reviewer implementation issues to address this round:\n${implIssuesText}\n` : ''}
${CONSTRAINTS}

When done run \`cd ${REPO} && npm run pretest && npm test && npm run check-types && npm run lint\`. Return the src files
you changed, whether everything is green, and a one-paragraph summary.`,
    {
      phase: 'Green',
      label: `implementer-r${round}`,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          filesChanged: { type: 'array', items: { type: 'string' } },
          allGreen: { type: 'boolean' },
          summary: { type: 'string' },
        },
        required: ['filesChanged', 'allGreen', 'summary'],
      },
    },
  )
  log(`implementer-r${round}: allGreen=${impl?.allGreen} changed=${JSON.stringify(impl?.filesChanged)}`)

  // If the reviewer routed test issues back, let the test-writer fix them (tests-only).
  if (round > 1 && testIssuesText) {
    await agent(
      `You are the TEST-WRITER (round ${round}). Address these reviewer test issues by editing ONLY files under
${REPO}/test/ (never ${REPO}/src/). Do not weaken coverage; fix the issues and keep pinning the ground truth.
Reviewer test issues:\n${testIssuesText}\n${GROUND_TRUTH}\n${HARNESS}\n${CONSTRAINTS}
Run \`cd ${REPO} && npm run pretest && npm test\` and report what you changed.`,
      { phase: 'Green', label: `test-fix-r${round}` },
    )
  }

  phase('Green-verify')
  const greenCheck = await agent(
    `INDEPENDENT VERIFIER (round ${round}). Do not edit anything. Run
\`cd ${REPO} && npm run pretest && npm test && npm run check-types && npm run lint\`.
Report total/passing/failing test counts, whether check-types and lint are clean, and the tail of any failure.`,
    {
      phase: 'Green-verify',
      label: `green-verify-r${round}`,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          testsGreen: { type: 'boolean' },
          typesClean: { type: 'boolean' },
          lintClean: { type: 'boolean' },
          total: { type: 'number' },
          failing: { type: 'number' },
          outputTail: { type: 'string' },
        },
        required: ['testsGreen', 'typesClean', 'lintClean', 'total', 'failing', 'outputTail'],
      },
    },
  )
  log(`green-verify-r${round}: green=${greenCheck?.testsGreen} types=${greenCheck?.typesClean} lint=${greenCheck?.lintClean} failing=${greenCheck?.failing}`)

  phase('Review')
  review = await agent(
    `You are the REVIEWER in a strict-TDD workflow (round ${round}) — adversarial and independent. Read the diff of
this milestone with \`cd ${REPO} && git diff\` and \`git status\` (new files: test/controlStepping.test.ts,
test/dapControlStepping.test.ts; edits: test/contractBuilder.test.ts, src/build/ContractBuilder.ts). Judge BOTH:

TEST QUALITY — do the tests actually PIN the ground truth, or would a plausible bug slip through? Specifically verify:
  * The ContractBuilder opt-level test asserts =0 and would FAIL if the injection were removed (it is genuinely
    test-first — independent verify reported right-reason red = ${rightReasonRed}).
  * branch/choose pin that the NON-taken arm never appears (not merely that the taken arm does).
  * count pins per-iteration loop stops (body line stops >= number of iterations), not just "the body appears once".
  * while_call pins stepIn-descends vs next-steps-over AND that bump's body is exactly one depth deeper AND that the
    implicit return still restores the caller depth.
  * Tests assert exact lines/indices from the ground truth, not loose "> 0" checks.

IMPL QUALITY — ContractBuilder injects opt-level=0 under the correct guard; debugInfo:false still injects nothing;
no vscode import leaked into a non-extension module; no committed fixture/script/example/doc was modified; any engine
fix (if a characterization test was red) is correct and consistent with docs/stepping.md.

Independent verify this round: testsGreen=${greenCheck?.testsGreen} typesClean=${greenCheck?.typesClean} lintClean=${greenCheck?.lintClean} failing=${greenCheck?.failing}.
Do NOT approve if anything is not green. Return a structured verdict; put each issue under testIssues (route to
test-writer) or implIssues (route to implementer) with a severity and a concrete, actionable description.`,
    {
      phase: 'Review',
      label: `reviewer-r${round}`,
      effort: 'high',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          approved: { type: 'boolean' },
          testIssues: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
                file: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['severity', 'description'],
            },
          },
          implIssues: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
                file: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['severity', 'description'],
            },
          },
          summary: { type: 'string' },
        },
        required: ['approved', 'testIssues', 'implIssues', 'summary'],
      },
    },
  )
  log(`reviewer-r${round}: approved=${review?.approved} testIssues=${review?.testIssues?.length ?? 0} implIssues=${review?.implIssues?.length ?? 0}`)

  const blockers = [...(review?.testIssues ?? []), ...(review?.implIssues ?? [])].filter(
    (i) => i.severity === 'blocker' || i.severity === 'major',
  )
  if (review?.approved && greenCheck?.testsGreen && greenCheck?.typesClean && greenCheck?.lintClean && blockers.length === 0) {
    log(`APPROVED in round ${round}`)
    break
  }
  implIssuesText = (review?.implIssues ?? []).map((i) => `- [${i.severity}] ${i.file ?? ''}: ${i.description}`).join('\n')
  testIssuesText = (review?.testIssues ?? []).map((i) => `- [${i.severity}] ${i.file ?? ''}: ${i.description}`).join('\n')
  if (round === MAX_ROUNDS) {
    log(`NOT approved after ${MAX_ROUNDS} rounds — escalating to main session.`)
  }
}

return {
  redVerify: redCheck,
  finalReview: review,
  redTestNames: red?.redTestNames,
  testFiles: red?.files,
}
