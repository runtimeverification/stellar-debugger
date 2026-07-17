import * as assert from 'assert';
import * as fc from 'fast-check';
import { Disassembly } from '../../src/wasm/Disassembly';
import { TraceModel } from '../../src/debugAdapter/TraceModel';
import { TraceRecord } from '../../src/komet/trace';

/** Build a trace-derived Disassembly from a set of code offsets. */
function disassemblyFrom(positions: number[]): Disassembly {
  const records: TraceRecord[] = positions.map((pos) => ({
    pos,
    instr: ['nop'] as [string, ...unknown[]],
    stack: [],
    locals: {},
  }));
  return Disassembly.fromTrace(new TraceModel(records));
}

/** The specification of indexForAddress, computed by a simple linear scan. */
function oracleIndex(addresses: number[], addr: number): number {
  let result = -1;
  for (let i = 0; i < addresses.length; i++) {
    if (addresses[i] <= addr) result = i;
    else break; // addresses are sorted ascending
  }
  return result;
}

describe('property: Disassembly.indexForAddress matches a linear-scan oracle', () => {
  it('agrees with the oracle for arbitrary sorted instruction sets and queries', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 10000 }), { minLength: 0, maxLength: 40 }),
        fc.integer({ min: -50, max: 10050 }),
        (positions, query) => {
          const dis = disassemblyFrom(positions);
          const addresses = dis.instructions.map((i) => i.address);
          assert.strictEqual(dis.indexForAddress(query), oracleIndex(addresses, query));
        },
      ),
    );
  });

  it('exact-hit, below-first, above-last, and gap queries', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 30 }),
        (positions) => {
          const dis = disassemblyFrom(positions);
          const addresses = dis.instructions.map((i) => i.address);

          // Exact hit on every instruction address.
          addresses.forEach((a, i) => assert.strictEqual(dis.indexForAddress(a), i));
          // Below the first address -> -1.
          assert.strictEqual(dis.indexForAddress(addresses[0] - 1), -1);
          // Above the last address -> last index.
          assert.strictEqual(dis.indexForAddress(addresses[addresses.length - 1] + 1), addresses.length - 1);
        },
      ),
    );
  });

  it('an empty disassembly always returns -1', () => {
    const dis = disassemblyFrom([]);
    fc.assert(fc.property(fc.integer(), (q) => assert.strictEqual(dis.indexForAddress(q), -1)));
  });
});
