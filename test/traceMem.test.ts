import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import { toTraceRecord, parseTraceJsonl, TraceParseError } from '../src/komet/trace';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const ADDER_TRACE = path.join(FIXTURES, 'adder-debug.trace.jsonl');

// Lowercase-hex encoding of a raw byte sequence — the way komet-node now
// encodes a memory snapshot run on the wire.
function hex(bytes: number[]): string {
  return Buffer.from(Uint8Array.from(bytes)).toString('hex');
}

describe('trace parsing — mem sparse snapshot (hex) + globals (PA4)', () => {
  it('parses a record whose mem is a hex-run snapshot array', () => {
    // mem is a FULL sparse snapshot: a list of { addr, bytes:<lowercase-hex> }
    // runs. Two runs at different addresses; bytes decode to a Uint8Array.
    const rec = toTraceRecord(
      {
        pos: 10,
        instr: ['i32.store'],
        stack: [],
        locals: {},
        mem: [
          { addr: 1048576, bytes: hex([14, 29, 244, 101]) }, // "0e1df465"
          { addr: 16, bytes: hex([255]) }, // "ff"
        ],
      },
      1,
    );

    assert.ok(rec.mem);
    assert.strictEqual(rec.mem.length, 2);
    // addr survives as an integer, order is preserved.
    assert.strictEqual(rec.mem[0].addr, 1048576);
    // bytes is decoded from hex into a Uint8Array with the exact bytes.
    assert.ok(rec.mem[0].bytes instanceof Uint8Array);
    assert.deepStrictEqual(Array.from(rec.mem[0].bytes), [14, 29, 244, 101]);
    assert.strictEqual(rec.mem[1].addr, 16);
    assert.deepStrictEqual(Array.from(rec.mem[1].bytes), [255]);
  });

  it('decodes a known lowercase-hex string to the exact bytes', () => {
    const rec = toTraceRecord(
      { pos: 1, instr: ['nop'], stack: [], locals: {}, mem: [{ addr: 0, bytes: '00ff0a10' }] },
      1,
    );
    assert.ok(rec.mem);
    assert.deepStrictEqual(Array.from(rec.mem[0].bytes), [0x00, 0xff, 0x0a, 0x10]);
  });

  it('accepts an empty mem array and empty run bytes', () => {
    // An empty snapshot list is valid (nothing written yet is normally null,
    // but an explicit [] must parse), as is a zero-length run.
    const emptyList = toTraceRecord({ pos: 1, instr: ['nop'], stack: [], locals: {}, mem: [] }, 1);
    assert.deepStrictEqual(emptyList.mem, []);

    const emptyRun = toTraceRecord(
      { pos: 1, instr: ['nop'], stack: [], locals: {}, mem: [{ addr: 0, bytes: '' }] },
      1,
    );
    assert.ok(emptyRun.mem);
    assert.strictEqual(emptyRun.mem[0].addr, 0);
    assert.deepStrictEqual(Array.from(emptyRun.mem[0].bytes), []);
  });

  it('treats "mem": null as no snapshot (undefined)', () => {
    const rec = toTraceRecord({ pos: 1, instr: ['nop'], stack: [], locals: {}, mem: null }, 1);
    assert.strictEqual(rec.mem, undefined);
  });

  it('treats an absent mem key as no snapshot (undefined)', () => {
    const rec = toTraceRecord({ pos: 1, instr: ['nop'], stack: [], locals: {} }, 1);
    assert.strictEqual(rec.mem, undefined);
  });

  it('still parses the existing adder trace fixture (no mem/globals fields)', async () => {
    const text = await fs.readFile(ADDER_TRACE, 'utf8');
    const records = parseTraceJsonl(text);
    assert.ok(records.length > 0, 'adder fixture must parse into records');
    // The legacy fixture carries neither field.
    for (const rec of records) {
      assert.strictEqual(rec.mem, undefined);
      assert.strictEqual(rec.globals, undefined);
    }
  });

  it('rejects a mem that is neither an array nor null', () => {
    assert.throws(
      () => toTraceRecord({ pos: 1, instr: ['nop'], mem: { addr: 0, bytes: '01' } }, 1),
      TraceParseError,
    );
    assert.throws(
      () => toTraceRecord({ pos: 1, instr: ['nop'], mem: 'ff' }, 1),
      TraceParseError,
    );
  });

  it('rejects a mem run missing addr', () => {
    assert.throws(
      () => toTraceRecord({ pos: 1, instr: ['nop'], mem: [{ bytes: '01' }] }, 1),
      TraceParseError,
    );
  });

  it('rejects a mem run with a non-numeric addr', () => {
    assert.throws(
      () => toTraceRecord({ pos: 1, instr: ['nop'], mem: [{ addr: '0', bytes: '01' }] }, 1),
      TraceParseError,
    );
  });

  it('rejects a mem run whose bytes are not a string', () => {
    assert.throws(
      () => toTraceRecord({ pos: 1, instr: ['nop'], mem: [{ addr: 0, bytes: 123 }] }, 1),
      TraceParseError,
    );
  });

  it('rejects a mem run whose bytes contain non-hex characters', () => {
    assert.throws(
      () => toTraceRecord({ pos: 1, instr: ['nop'], mem: [{ addr: 0, bytes: 'zz' }] }, 1),
      TraceParseError,
    );
  });

  it('rejects a mem run whose bytes have odd length', () => {
    assert.throws(
      () => toTraceRecord({ pos: 1, instr: ['nop'], mem: [{ addr: 0, bytes: 'abc' }] }, 1),
      TraceParseError,
    );
  });

  it('parses globals when present and leaves them undefined when absent (optional)', () => {
    // globals is unchanged from M7: Record<string, [wasmType, value]>.
    const withGlobals = toTraceRecord(
      {
        pos: 1,
        instr: ['nop'],
        stack: [],
        locals: {},
        globals: { '0': ['i32', 66], '1': ['i64', '4294967296'] },
      },
      1,
    );
    assert.deepStrictEqual(withGlobals.globals, {
      '0': ['i32', 66],
      '1': ['i64', '4294967296'],
    });

    const noGlobals = toTraceRecord({ pos: 1, instr: ['nop'], stack: [], locals: {} }, 1);
    assert.strictEqual(noGlobals.globals, undefined);
  });

  it('rejects globals that are not an object of [type, value] pairs', () => {
    assert.throws(
      () => toTraceRecord({ pos: 1, instr: ['nop'], globals: [['i32', 1]] }, 1),
      TraceParseError,
    );
    assert.throws(
      () => toTraceRecord({ pos: 1, instr: ['nop'], globals: { '0': ['i32'] } }, 1),
      TraceParseError,
    );
  });
});
