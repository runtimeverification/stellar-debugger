import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import { DwarfLineTable } from '../src/dwarf/LineTable';
import { Disassembly, WasmInstruction } from '../src/wasm/Disassembly';
import { parseTraceJsonl, TraceRecord } from '../src/komet/trace';
import { TraceModel } from '../src/debugAdapter/TraceModel';
import { buildDebugArtifacts, validatedPositions } from '../src/debugAdapter/artifacts';
import { DwarfSourceMapper } from '../src/sourcemap/DwarfSourceMapper';
import { NullSourceMapper } from '../src/sourcemap/NullSourceMapper';
import { MappedLocation, SourceMapper } from '../src/sourcemap/SourceMapper';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const ADDER_WASM = path.join(FIXTURES, 'adder-debug.wasm');
const ADDER_TRACE = path.join(FIXTURES, 'adder-debug.trace.jsonl');
const STRIPPED_WASM = path.join(FIXTURES, 'sample_contract.wasm');

/** Suffix of the DWARF-resolved path of the adder contract source. */
const LIB_RS_SUFFIX = 'examples/adder/src/lib.rs';

/** Deterministic existence check: only the adder lib.rs "exists" on disk. */
const libExists = (p: string): boolean => p.endsWith(LIB_RS_SUFFIX);

/**
 * Fixture ground truth (see adder-debug.trace.jsonl and the DWARF line table):
 *   - indices 0..2 are global-initializer records (pos 3/11/19, i32.const
 *     1048576) whose pos lives in the globals section's address space;
 *   - indices 3..5 have pos null (synthetic records);
 *   - pos 5,7,9,11,62 map to lib.rs:12 -> trace indices 6,7,8,9,40;
 *   - pos 45..51 map to lib.rs:16 -> trace indices 29..33 (the i32.add run).
 */
const LINE_12_INDICES = [6, 7, 8, 9, 40];
const LINE_16_INDICES = [29, 30, 31, 32, 33];

function indexOfPos(records: TraceRecord[], pos: number): number {
  // Only usable for positions carried by exactly one record.
  const matches = records.map((r, i) => (r.pos === pos ? i : -1)).filter((i) => i >= 0);
  assert.strictEqual(matches.length, 1, `expected exactly one record at pos ${pos}`);
  return matches[0];
}

function assertLibRsLocation(loc: MappedLocation | null, line: number): void {
  assert.ok(loc, 'expected a mapped location');
  assert.ok(path.isAbsolute(loc.path), `path must be absolute, got ${loc.path}`);
  assert.ok(loc.path.endsWith(LIB_RS_SUFFIX), `expected ${LIB_RS_SUFFIX}, got ${loc.path}`);
  assert.strictEqual(loc.line, line);
}

describe('debugAdapter/artifacts', () => {
  let wasmBytes: Uint8Array;
  let records: TraceRecord[];
  let model: TraceModel;
  let disassembly: Disassembly;

  before(async () => {
    wasmBytes = await fs.readFile(ADDER_WASM);
    records = parseTraceJsonl(await fs.readFile(ADDER_TRACE, 'utf8'));
    model = new TraceModel(records);
    disassembly = Disassembly.fromWasm(wasmBytes);
  });

  describe('validatedPositions on the adder fixture', () => {
    let valid: (number | null)[];

    before(() => {
      valid = validatedPositions(model, disassembly);
    });

    it('produces one entry per trace record', () => {
      assert.strictEqual(valid.length, model.length);
    });

    it('rejects the global-initializer records at pos 3/11/19', () => {
      for (const i of [0, 1, 2]) {
        assert.deepStrictEqual(records[i].instr, ['const', 'i32', 1048576]);
        assert.strictEqual(valid[i], null, `record ${i} (pos ${records[i].pos}) must be invalid`);
      }
    });

    it('maps null-pos records to null', () => {
      for (const i of [3, 4, 5]) {
        assert.strictEqual(records[i].pos, null);
        assert.strictEqual(valid[i], null);
      }
    });

    it('keeps the pos of mnemonic-matching code records', () => {
      const add = indexOfPos(records, 45);
      assert.strictEqual(valid[add], 45);
      const nonNull = valid.filter((v) => v !== null);
      assert.ok(nonNull.length >= 30, `expected >= 30 validated records, got ${nonNull.length}`);
    });
  });

  describe('validatedPositions mnemonic rules (synthetic records)', () => {
    function positionsOf(...recs: [number | null, string[]][]): (number | null)[] {
      const synthetic = recs.map(
        ([pos, instr]): TraceRecord => ({ pos, instr: instr as [string, ...unknown[]], stack: [], locals: {} }),
      );
      return validatedPositions(new TraceModel(synthetic), disassembly);
    }

    it('an unknown mnemonic is valid iff an instruction starts exactly at pos', () => {
      assert.deepStrictEqual(positionsOf([45, ['unknown']], [3, ['unknown']]), [45, null]);
    });

    it('a decoded mnemonic must also match the disassembly text', () => {
      // The instruction at code offset 45 is i32.add: 'sub' must not validate.
      assert.deepStrictEqual(
        positionsOf([45, ['add', 'i32']], [45, ['sub', 'i32']], [12, ['add', 'i32']]),
        [45, null, null],
      );
    });
  });

  describe('buildDebugArtifacts', () => {
    it('returns a DWARF-backed mapper and a wasm disassembly for the debug fixture', () => {
      const messages: string[] = [];
      const { source, disassembly: dis } = buildDebugArtifacts(wasmBytes, model, (m: string) =>
        messages.push(m),
      );
      assert.strictEqual(source.hasLineInfo(), true);
      const at45 = dis.instructions.find((i: WasmInstruction) => i.address === 45);
      assert.ok(at45, 'expected the wasm disassembly (instruction at code offset 45)');
      assert.ok(at45.text.startsWith('i32.add'));
    });

    it('degrades to NullSourceMapper (with a report) when the wasm has no DWARF', async () => {
      const stripped = await fs.readFile(STRIPPED_WASM);
      const messages: string[] = [];
      const { source, disassembly: dis } = buildDebugArtifacts(stripped, model, (m: string) =>
        messages.push(m),
      );
      assert.strictEqual(source.hasLineInfo(), false);
      assert.strictEqual(source.locationForIndex(0), null);
      assert.ok(dis.instructions.length > 0, 'still disassembles the wasm');
      assert.ok(messages.length > 0, 'expected a note about missing debug info');
    });

    it('falls back to a trace-derived disassembly when the bytes are not wasm at all', () => {
      const messages: string[] = [];
      const garbage = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4]);
      const { source, disassembly: dis } = buildDebugArtifacts(garbage, model, (m: string) =>
        messages.push(m),
      );
      assert.strictEqual(source.hasLineInfo(), false);
      assert.ok(messages.length > 0, 'expected a warning about the unreadable wasm');
      const uniquePos = new Set(records.map((r) => r.pos).filter((p): p is number => p !== null));
      assert.strictEqual(dis.instructions.length, uniquePos.size);
    });
  });
});

describe('sourcemap/DwarfSourceMapper (adder debug fixture)', () => {
  let records: TraceRecord[];
  let model: TraceModel;
  let table: DwarfLineTable;
  let validPos: (number | null)[];
  let mapper: DwarfSourceMapper;
  let libRs: string;

  before(async () => {
    const wasmBytes = await fs.readFile(ADDER_WASM);
    records = parseTraceJsonl(await fs.readFile(ADDER_TRACE, 'utf8'));
    model = new TraceModel(records);
    const result = DwarfLineTable.fromWasm(wasmBytes);
    assert.ok(result, 'fixture must yield a line table');
    table = result;
    validPos = validatedPositions(model, Disassembly.fromWasm(wasmBytes));
    mapper = new DwarfSourceMapper(model, table, validPos, libExists);
    const found = table.files().find((f) => f.endsWith(LIB_RS_SUFFIX));
    assert.ok(found, 'fixture must reference the adder lib.rs');
    libRs = found;
  });

  it('hasLineInfo() is true (at least one record maps to an existing source)', () => {
    assert.strictEqual(mapper.hasLineInfo(), true);
  });

  describe('locationForIndex', () => {
    it('maps the ["add","i32"] record (pos 45) to lib.rs:16', () => {
      const add = indexOfPos(records, 45);
      assert.deepStrictEqual(records[add].instr, ['add', 'i32']);
      assertLibRsLocation(mapper.locationForIndex(add), 16);
    });

    it('maps the whole pos-45..51 run to lib.rs:16 and the lib.rs:12 indices to line 12', () => {
      for (const i of LINE_16_INDICES) {
        assertLibRsLocation(mapper.locationForIndex(i), 16);
      }
      for (const i of LINE_12_INDICES) {
        assertLibRsLocation(mapper.locationForIndex(i), 12);
      }
    });

    it('global-initializer records (pos 3/11/19) are unmapped', () => {
      for (const i of [0, 1, 2]) {
        assert.strictEqual(mapper.locationForIndex(i), null, `index ${i} must be unmapped`);
      }
    });

    it('records mapping to non-existent crate sources (val.rs/unwrap.rs) are unmapped', () => {
      // pos 14 -> val.rs:735, pos 18 -> unwrap.rs:41; both fail fileExists.
      assert.strictEqual(mapper.locationForIndex(indexOfPos(records, 14)), null);
      assert.strictEqual(mapper.locationForIndex(indexOfPos(records, 18)), null);
    });

    it('DWARF line-0 rows (compiler-generated code) never map, even for existing files', () => {
      const allExist = new DwarfSourceMapper(model, table, validPos, () => true);
      // pos 20 falls on the unwrap.rs row with line 0; pos 18 on unwrap.rs:41.
      assert.strictEqual(allExist.locationForIndex(indexOfPos(records, 20)), null);
      const mapped = allExist.locationForIndex(indexOfPos(records, 18));
      assert.ok(mapped, 'the line-41 row must map when the file exists');
      assert.strictEqual(mapped.line, 41);
    });
  });

  describe('lineKeyForIndex', () => {
    it('is consistent with locationForIndex across the whole trace', () => {
      for (let i = 0; i < model.length; i++) {
        const loc = mapper.locationForIndex(i);
        const key = mapper.lineKeyForIndex(i);
        if (loc === null) {
          assert.strictEqual(key, null, `index ${i}: key must be null when unmapped`);
        } else {
          assert.strictEqual(key, `${loc.path}:${loc.line}`, `index ${i}: key mismatch`);
        }
      }
    });
  });

  describe('resolveBreakpoint', () => {
    it('(lib.rs, 16) resolves in place with the indices of the pos-45..51 run', () => {
      const resolved = mapper.resolveBreakpoint(libRs, 16);
      assert.ok(resolved);
      assert.strictEqual(resolved.line, 16);
      assert.deepStrictEqual([...resolved.indices].sort((a, b) => a - b), LINE_16_INDICES);
    });

    it('(lib.rs, 13) slides FORWARD to 16 (lines 13..15 have no executed code)', () => {
      const resolved = mapper.resolveBreakpoint(libRs, 13);
      assert.ok(resolved);
      assert.strictEqual(resolved.line, 16);
      assert.deepStrictEqual([...resolved.indices].sort((a, b) => a - b), LINE_16_INDICES);
    });

    it('(lib.rs, 1) slides to the first executed line 12, uniting non-contiguous runs', () => {
      const resolved = mapper.resolveBreakpoint(libRs, 1);
      assert.ok(resolved);
      assert.strictEqual(resolved.line, 12);
      assert.deepStrictEqual([...resolved.indices].sort((a, b) => a - b), LINE_12_INDICES);
    });

    it('(lib.rs, 99) is null (no executed line at or after 99)', () => {
      assert.strictEqual(mapper.resolveBreakpoint(libRs, 99), null);
    });

    it('files without executed mapped lines are null', () => {
      assert.strictEqual(mapper.resolveBreakpoint('/no/such/file.rs', 1), null);
      // val.rs appears in the DWARF but never maps (fileExists is false for it).
      const valRs = table.files().find((f) => f.endsWith('/val.rs'));
      assert.ok(valRs);
      assert.strictEqual(mapper.resolveBreakpoint(valRs, 1), null);
    });

    it('normalizes the incoming path', () => {
      const unnormalized = `${path.dirname(libRs)}${path.sep}.${path.sep}lib.rs`;
      const resolved = mapper.resolveBreakpoint(unnormalized, 16);
      assert.ok(resolved, `expected ${unnormalized} to resolve after normalization`);
      assert.strictEqual(resolved.line, 16);
    });
  });

  describe('locationForAddress', () => {
    it('maps code offset 45 to lib.rs:16 and offset 5 to lib.rs:12', () => {
      assertLibRsLocation(mapper.locationForAddress(45), 16);
      assertLibRsLocation(mapper.locationForAddress(5), 12);
    });

    it('is null for addresses mapping to non-existent files (val.rs)', () => {
      assert.strictEqual(mapper.locationForAddress(14), null);
    });

    it('is null for line-0 rows and before the first row', () => {
      const allExist = new DwarfSourceMapper(model, table, validPos, () => true);
      assert.strictEqual(allExist.locationForAddress(20), null); // unwrap.rs line 0
      assert.strictEqual(mapper.locationForAddress(0), null); // first row starts at 2
    });
  });

  describe('executedLines', () => {
    it('lists the distinct executed lib.rs lines within a range, ascending', () => {
      assert.deepStrictEqual(mapper.executedLines(libRs, 1, 99), [12, 16]);
    });

    it('respects the range bounds inclusively', () => {
      assert.deepStrictEqual(mapper.executedLines(libRs, 16, 16), [16]);
      assert.deepStrictEqual(mapper.executedLines(libRs, 13, 15), []);
    });

    it('is empty for an unknown file', () => {
      assert.deepStrictEqual(mapper.executedLines('/no/such/file.rs', 1, 99), []);
    });
  });

  it('checks each unique path at most once (existence cache)', () => {
    const calls: string[] = [];
    const spy = (p: string): boolean => {
      calls.push(p);
      return libExists(p);
    };
    const cached = new DwarfSourceMapper(model, table, validPos, spy);
    for (let i = 0; i < model.length; i++) {
      cached.locationForIndex(i);
    }
    for (const addr of [0, 5, 14, 20, 45, 76, 86, 90]) {
      cached.locationForAddress(addr);
    }
    assert.strictEqual(
      calls.length,
      new Set(calls).size,
      `duplicate existence checks: ${calls.sort().join(', ')}`,
    );
  });
});

describe('sourcemap/NullSourceMapper', () => {
  const mapper: SourceMapper = new NullSourceMapper();

  it('has no line info and answers null everywhere', () => {
    assert.strictEqual(mapper.hasLineInfo(), false);
    assert.strictEqual(mapper.locationForIndex(0), null);
    assert.strictEqual(mapper.locationForAddress(0), null);
    assert.strictEqual(mapper.lineKeyForIndex(0), null);
    assert.strictEqual(mapper.resolveBreakpoint('/any/file.rs', 1), null);
    assert.deepStrictEqual(mapper.executedLines('/any/file.rs', 1, 99), []);
  });
});
