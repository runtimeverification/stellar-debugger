import * as assert from 'assert';
import { parseTraceJsonl, toTraceRecord, TraceParseError, opcode } from '../src/komet/trace';

describe('trace parsing', () => {
  it('parses a well-formed JSONL trace', () => {
    const jsonl =
      '{"pos": 100, "instr": ["local.get", 0], "stack": [], "locals": {"0": ["i64", 4]}}\n' +
      '{"pos": null, "instr": ["host.return"], "stack": [["u32", 7]], "locals": {}}\n';
    const records = parseTraceJsonl(jsonl);
    assert.strictEqual(records.length, 2);
    assert.strictEqual(records[0].pos, 100);
    assert.strictEqual(opcode(records[0]), 'local.get');
    assert.deepStrictEqual(records[0].locals['0'], ['i64', 4]);
    assert.strictEqual(records[1].pos, null);
  });

  it('skips blank lines', () => {
    const jsonl = '\n{"pos": 1, "instr": ["nop"], "stack": [], "locals": {}}\n\n';
    assert.strictEqual(parseTraceJsonl(jsonl).length, 1);
  });

  it('defaults missing stack/locals to empty', () => {
    const rec = toTraceRecord({ pos: 1, instr: ['nop'] }, 1);
    assert.deepStrictEqual(rec.stack, []);
    assert.deepStrictEqual(rec.locals, {});
  });

  it('rejects a record with a non-array instr', () => {
    assert.throws(() => toTraceRecord({ pos: 1, instr: 'nop' }, 1), TraceParseError);
  });

  it('rejects a bad pos', () => {
    assert.throws(() => toTraceRecord({ pos: 'x', instr: ['nop'] }, 1), TraceParseError);
  });

  it('rejects malformed stack pairs', () => {
    assert.throws(() => toTraceRecord({ pos: 1, instr: ['nop'], stack: [['i64']] }, 1), TraceParseError);
  });

  it('reports the line number on invalid JSON', () => {
    assert.throws(
      () => parseTraceJsonl('{"pos":1,"instr":["nop"]}\nnot json\n'),
      /trace line 2/,
    );
  });
});
