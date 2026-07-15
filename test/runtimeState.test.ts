import * as assert from 'assert';
import { TraceRecord, TypedValue, MemRun } from '../src/komet/trace';
import { MemoryImage } from '../src/debugAdapter/MemoryImage';
import { makeRuntimeState } from '../src/debugAdapter/runtimeState';

// One full-memory snapshot run.
function run(addr: number, bytes: number[]): MemRun {
  return { addr, bytes: Uint8Array.from(bytes) };
}

function rec(fields: Partial<TraceRecord>): TraceRecord {
  return {
    pos: null,
    instr: ['nop'],
    stack: [],
    locals: {},
    ...fields,
  };
}

describe('makeRuntimeState', () => {
  it('exposes locals/globals/stack as numeric values (i64-string -> BigInt, bool -> 0/1)', () => {
    const record = rec({
      // i32 comes as a JS number; i64 may arrive as a decimal string; a
      // boolean maps to 0/1.
      locals: {
        '0': ['i32', 5] as TypedValue,
        '1': ['i64', '18446744073709551615'] as TypedValue,
        '2': ['i32', true] as TypedValue,
      },
      globals: {
        '0': ['i32', 42] as TypedValue,
        '1': ['f64', 3.5] as TypedValue,
      },
      // Operand stack: top-of-stack LAST; exposed by raw index i.
      stack: [
        ['i32', 100] as TypedValue,
        ['i32', 200] as TypedValue,
        ['i32', 300] as TypedValue,
      ],
    });
    const state = makeRuntimeState(record, new MemoryImage([record]), 0);

    // locals
    assert.strictEqual(state.localValue(0), 5);
    assert.strictEqual(state.localValue(1), BigInt('18446744073709551615'));
    assert.strictEqual(state.localValue(2), 1); // boolean true -> 1
    assert.strictEqual(state.localValue(9), undefined); // missing index

    // globals
    assert.strictEqual(state.globalValue(0), 42);
    assert.strictEqual(state.globalValue(1), 3.5);
    assert.strictEqual(state.globalValue(9), undefined); // missing index

    // stack by raw index (index 0 is bottom, last is top-of-stack)
    assert.strictEqual(state.stackValue(0), 100);
    assert.strictEqual(state.stackValue(2), 300);
    assert.strictEqual(state.stackValue(9), undefined); // out of range
  });

  it('returns undefined for globalValue when the record has no globals', () => {
    const record = rec({ locals: { '0': ['i32', 1] as TypedValue } });
    const state = makeRuntimeState(record, new MemoryImage([record]), 0);
    assert.strictEqual(state.globalValue(0), undefined);
  });

  it('delegates readMemory to the MemoryImage at the bound cursor', () => {
    // Each record carries its own FULL memory snapshot; the cursor bound into
    // the RuntimeState selects which snapshot is read.
    const records: TraceRecord[] = [
      rec({ mem: [run(0, [1, 2, 3, 4])] }),
      rec({ mem: [run(0, [5, 6, 7, 8])] }),
    ];
    const memory = new MemoryImage(records);

    // A state bound to cursor 1 sees the snapshot at record 1.
    const s1 = makeRuntimeState(records[1], memory, 1);
    assert.deepStrictEqual(Array.from(s1.readMemory(0, 4)!), [5, 6, 7, 8]);

    // A state bound to cursor 0 sees the snapshot at record 0.
    const s0 = makeRuntimeState(records[0], memory, 0);
    assert.deepStrictEqual(Array.from(s0.readMemory(0, 4)!), [1, 2, 3, 4]);

    // Invalid reads propagate the MemoryImage's undefined.
    assert.strictEqual(s0.readMemory(0, 0), undefined);
  });
});
