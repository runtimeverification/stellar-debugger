import * as assert from 'assert';
import { parseTraceJsonl, toTraceRecord, toTraceRecords, TraceParseError, opcode } from '../src/komet/trace';

describe('trace parsing', () => {
  it('parses a well-formed JSONL trace', () => {
    const jsonl =
      '{"kind":"instr","pos":100,"instr":["local.get",0],"stack":[],"locals":{"0":["i64",4]}}\n' +
      '{"kind":"instr","pos":null,"instr":["host.return"],"stack":[["u32",7]],"locals":{}}\n';
    const records = parseTraceJsonl(jsonl);
    assert.strictEqual(records.length, 2);
    assert.strictEqual(records[0].pos, 100);
    assert.strictEqual(opcode(records[0]), 'local.get');
    assert.deepStrictEqual(records[0].locals['0'], ['i64', 4]);
    assert.strictEqual(records[1].pos, null);
  });

  it('skips blank lines', () => {
    const jsonl = '\n{"kind":"instr","pos":1,"instr":["nop"],"stack":[],"locals":{}}\n\n';
    assert.strictEqual(parseTraceJsonl(jsonl).length, 1);
  });

  it('defaults missing stack/locals to empty', () => {
    const rec = toTraceRecord({ kind: 'instr', pos: 1, instr: ['nop'] }, 1);
    assert.deepStrictEqual(rec.stack, []);
    assert.deepStrictEqual(rec.locals, {});
  });

  it('rejects a record with a non-array instr', () => {
    assert.throws(() => toTraceRecord({ pos: 1, instr: 'nop' }, 1), TraceParseError);
  });

  it('rejects a bad pos', () => {
    assert.throws(() => toTraceRecord({ kind: 'instr', pos: 'x', instr: ['nop'] }, 1), TraceParseError);
  });

  it('rejects malformed stack pairs', () => {
    assert.throws(() => toTraceRecord({ kind: 'instr', pos: 1, instr: ['nop'], stack: [['i64']] }, 1), TraceParseError);
  });

  it('reports the line number on invalid JSON', () => {
    assert.throws(
      () => parseTraceJsonl('{"kind":"instr","pos":1,"instr":["nop"]}\nnot json\n'),
      /trace line 2/,
    );
  });

  // komet-node's `traceTransaction` returns the trace as a JSON ARRAY of record
  // objects (not a JSONL string); toTraceRecords validates that array shape.
  it('validates an array of already-parsed record objects', () => {
    const records = toTraceRecords([
      { kind: 'instr', pos: 3, instr: ['const', 'i32', 1048576], stack: [], locals: {} },
      // An interleaved Soroban VM event (pos null, no stack/locals) is accepted.
      { kind: 'callContract', from: {}, to: {}, function: 'add', args: [] },
    ]);
    assert.strictEqual(records.length, 2);
    assert.strictEqual(records[0].pos, 3);
    assert.strictEqual(opcode(records[1]), 'callContract');
  });

  it('toTraceRecords accepts an empty array', () => {
    assert.deepStrictEqual(toTraceRecords([]), []);
  });

  it('toTraceRecords reports the offending element index on a malformed record', () => {
    assert.throws(
      () => toTraceRecords([{ kind: 'instr', pos: 1, instr: ['nop'] }, { kind: 'instr', pos: 'x', instr: ['nop'] }]),
      /trace line 2/,
    );
  });
});

describe('trace parsing: a pre-v0.1.87 komet-node', () => {
  it('explains the old record shape as a stale komet-node, not as a parse error', () => {
    // The old shape carried no `kind` field (see the 0.1.0 release notes).
    assert.throws(
      () => toTraceRecord({ pos: null, instr: ['callContract'], stack: [], locals: {} }, 1),
      (e: unknown) => {
        assert.ok(e instanceof TraceParseError, 'must stay a TraceParseError for existing handlers');
        assert.match((e as Error).message, /komet v0\.1\.87/);
        assert.match((e as Error).message, /kup install komet-node/);
        assert.match((e as Error).message, /README\.md/);
        return true;
      },
    );
  });

  it('reports the record number so a partially-old trace is locatable', () => {
    assert.throws(
      () => toTraceRecords([
        { kind: 'instr', pos: 1, instr: ['nop'] },
        { pos: 2, instr: ['nop'] },
      ]),
      /record 2|line 2/,
    );
  });

  it('still reports a plainly malformed record as a malformed record', () => {
    assert.throws(() => toTraceRecord({ foo: 1 }, 1), /'kind'/);
    assert.throws(() => toTraceRecord({ foo: 1 }, 1), (e: unknown) => {
      assert.doesNotMatch((e as Error).message, /komet v0\.1\.87/);
      return true;
    });
  });
});
