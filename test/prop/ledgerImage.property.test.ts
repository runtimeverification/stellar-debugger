import * as assert from 'assert';
import * as fc from 'fast-check';
import { toTraceRecords } from '../../src/komet/trace';
import { LedgerImage } from '../../src/debugAdapter/LedgerImage';

/**
 * Property tests for the ledger reconstruction invariants that hand-written
 * cases cannot cover exhaustively (docs/state-inspection.md):
 *
 *   - L12 path independence, against an INDEPENDENT reference fold that replays
 *     the events from the start for every cursor. The production image
 *     precomputes shared versions; the reference is the obvious O(n^2) reading
 *     of the spec, so agreement pins the optimization.
 *   - L5 rollback: a failed call leaves the ledger exactly as it was before it.
 *   - L13: version count never exceeds the number of state-changing records.
 */

const CONTRACT = { type: 'address', addrType: 'contract', value: '63' };
const ACCOUNT = { type: 'address', addrType: 'account', value: '61' };

type Obj = Record<string, unknown>;

/** The generated event vocabulary, kept small so sequences stay meaningful. */
type Step =
  | { op: 'nop' }
  | { op: 'put'; key: string; value: number }
  | { op: 'del'; key: string }
  | { op: 'call' }
  | { op: 'end'; success: boolean };

function toRecord(step: Step, depth: number): Obj {
  switch (step.op) {
    case 'nop':
      return { pos: 1, instr: ['nop'], stack: [], locals: {} };
    case 'put':
      return {
        pos: null,
        instr: ['contractData', 'put', 'instance'],
        contract: CONTRACT,
        args: [
          { type: 'symbol', value: step.key },
          { type: 'u32', value: step.value },
        ],
      };
    case 'del':
      return {
        pos: null,
        instr: ['contractData', 'del', 'instance'],
        contract: CONTRACT,
        args: [{ type: 'symbol', value: step.key }],
      };
    case 'call':
      return {
        pos: null,
        instr: ['callContract'],
        from: ACCOUNT,
        to: CONTRACT,
        function: 'f',
        args: [],
        depth,
        storage: [],
      };
    case 'end':
      return { pos: null, instr: ['endWasm'], success: step.success, depth, result: null };
  }
}

/** Turn a step list into records, tracking call depth so the events are coherent. */
function toRecords(steps: Step[]): Obj[] {
  const out: Obj[] = [];
  let depth = 0;
  for (const step of steps) {
    if (step.op === 'call') {
      depth++;
      out.push(toRecord(step, depth));
    } else if (step.op === 'end') {
      out.push(toRecord(step, Math.max(1, depth)));
      depth = Math.max(0, depth - 1);
    } else {
      out.push(toRecord(step, depth));
    }
  }
  return out;
}

/**
 * Independent reference: storage at `cursor` by replaying from the start, with
 * an explicit save stack. Deliberately naive (no sharing, no precomputation) so
 * it encodes the spec rather than the implementation.
 */
function referenceStorage(steps: Step[], cursor: number): string[] {
  const records = toRecords(steps);
  let storage = new Map<string, number>();
  const saved: Map<string, number>[] = [];
  for (let i = 0; i < records.length; i++) {
    const step = steps[i];
    // Snapshot-class effects land AT the record (L15); `call` has an empty
    // baseline here, so only its save matters.
    if (step.op === 'call') {
      saved.push(new Map(storage));
    }
    if (i === cursor) {
      return [...storage.entries()].map(([k, v]) => `${k}=${v}`).sort();
    }
    // Mutations land from the next record on (L15).
    if (step.op === 'put') {
      storage.set(step.key, step.value);
    } else if (step.op === 'del') {
      storage.delete(step.key);
    } else if (step.op === 'end') {
      const restore = saved.pop();
      if (!step.success && restore !== undefined) {
        storage = restore;
      }
    }
  }
  return [...storage.entries()].map(([k, v]) => `${k}=${v}`).sort();
}

function actualStorage(image: LedgerImage, cursor: number): string[] {
  return image
    .storageAt(cursor)
    .map((e) => `${String(e.key.value)}=${String(e.value.value)}`)
    .sort();
}

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.constant<Step>({ op: 'nop' }),
  fc
    .tuple(fc.constantFrom('a', 'b', 'c'), fc.integer({ min: 0, max: 9 }))
    .map(([key, value]): Step => ({ op: 'put', key, value })),
  fc.constantFrom('a', 'b', 'c').map((key): Step => ({ op: 'del', key })),
  fc.constant<Step>({ op: 'call' }),
  fc.boolean().map((success): Step => ({ op: 'end', success })),
);

const stepsArb = fc.array(stepArb, { minLength: 1, maxLength: 40 });

describe('LedgerImage properties', () => {
  it('L12: agrees with an independent replay-from-start reference at every cursor', () => {
    fc.assert(
      fc.property(stepsArb, (steps) => {
        const image = new LedgerImage(toTraceRecords(toRecords(steps)));
        for (let cursor = 0; cursor < steps.length; cursor++) {
          assert.deepStrictEqual(
            actualStorage(image, cursor),
            referenceStorage(steps, cursor),
            `cursor ${cursor} of ${JSON.stringify(steps)}`,
          );
        }
      }),
      { numRuns: 300 },
    );
  });

  it('L12: querying backward gives the same answers as querying forward', () => {
    fc.assert(
      fc.property(stepsArb, (steps) => {
        const records = toTraceRecords(toRecords(steps));
        const image = new LedgerImage(records);
        const forward: string[][] = [];
        for (let i = 0; i < records.length; i++) {
          forward.push(actualStorage(image, i));
        }
        for (let i = records.length - 1; i >= 0; i--) {
          assert.deepStrictEqual(actualStorage(image, i), forward[i], `cursor ${i}`);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('L5: a failed call restores the ledger it started from', () => {
    fc.assert(
      fc.property(stepsArb, (inner) => {
        // A well-formed call whose body is arbitrary and which then FAILS.
        const steps: Step[] = [
          { op: 'put', key: 'seed', value: 1 },
          { op: 'call' },
          ...inner.filter((s) => s.op !== 'end' && s.op !== 'call'),
          { op: 'end', success: false },
          { op: 'nop' },
        ];
        const image = new LedgerImage(toTraceRecords(toRecords(steps)));
        // Cursor 1 is the callContract (state on entry); the last nop is after
        // the rollback. They must agree.
        const onEntry = actualStorage(image, 1);
        const afterRollback = actualStorage(image, steps.length - 1);
        assert.deepStrictEqual(afterRollback, onEntry);
      }),
      { numRuns: 200 },
    );
  });

  it('L13: never materializes more versions than there are state-changing records', () => {
    fc.assert(
      fc.property(stepsArb, (steps) => {
        const changing = steps.filter((s) => s.op !== 'nop').length;
        const image = new LedgerImage(toTraceRecords(toRecords(steps)));
        // One base version plus at most one per changing record; a `call` can
        // publish a frame push and its baseline in a single version.
        assert.ok(
          image.versionCount() <= changing + 1,
          `${image.versionCount()} versions for ${changing} changing records`,
        );
      }),
      { numRuns: 200 },
    );
  });
});
