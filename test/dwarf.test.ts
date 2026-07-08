import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Cursor, DwarfParseError } from '../src/dwarf/cursor';
import { parseAbbrevTable } from '../src/dwarf/abbrev';
import { scanCompilationUnits } from '../src/dwarf/info';
import { parseLineProgram } from '../src/dwarf/line';
import { DwarfLineTable } from '../src/dwarf/LineTable';
import { parseWasmSections } from '../src/wasm/sections';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const ADDER_WASM = path.join(FIXTURES, 'adder-debug.wasm');
const ADDER_TRACE = path.join(FIXTURES, 'adder-debug.trace.jsonl');
const STRIPPED_WASM = path.join(FIXTURES, 'sample_contract.wasm');

/** Suffix of the resolved path of the adder contract source (comp_dir + 'src' + 'lib.rs'). */
const LIB_RS_SUFFIX = 'examples/adder/src/lib.rs';

describe('dwarf/cursor', () => {
  describe('Cursor', () => {
    it('decodes a multi-byte ULEB128', () => {
      const c = new Cursor(Uint8Array.from([0xe5, 0x8e, 0x26]));
      assert.strictEqual(c.uleb(), 624485);
      assert.strictEqual(c.pos, 3);
      assert.strictEqual(c.atEnd, true);
    });

    it('decodes a single-byte ULEB128', () => {
      const c = new Cursor(Uint8Array.from([0x7f, 0x00]));
      assert.strictEqual(c.uleb(), 127);
      assert.strictEqual(c.uleb(), 0);
    });

    it('decodes negative SLEB128 values', () => {
      const c = new Cursor(Uint8Array.from([0x7f, 0x9b, 0xf1, 0x59, 0x02]));
      assert.strictEqual(c.sleb(), -1);
      assert.strictEqual(c.sleb(), -624485);
      assert.strictEqual(c.sleb(), 2);
    });

    it('reads u8/u16/u32 little-endian', () => {
      const c = new Cursor(Uint8Array.from([0xab, 0x34, 0x12, 0x78, 0x56, 0x34, 0x12]));
      assert.strictEqual(c.u8(), 0xab);
      assert.strictEqual(c.u16(), 0x1234);
      assert.strictEqual(c.u32(), 0x12345678);
      assert.strictEqual(c.pos, 7);
    });

    it('reads NUL-terminated UTF-8 strings, consuming the NUL', () => {
      const c = new Cursor(Uint8Array.from(Buffer.from('src\0lib.rs\0', 'utf8')));
      assert.strictEqual(c.cstring(), 'src');
      assert.strictEqual(c.cstring(), 'lib.rs');
      assert.strictEqual(c.atEnd, true);
    });

    it('initialLength() reads a plain u32 length', () => {
      const c = new Cursor(Uint8Array.from([0x10, 0x00, 0x00, 0x00]));
      assert.strictEqual(c.initialLength(), 16);
    });

    it('initialLength() rejects 64-bit DWARF escape values with DwarfParseError', () => {
      assert.throws(
        () => new Cursor(Uint8Array.from([0xff, 0xff, 0xff, 0xff])).initialLength(),
        DwarfParseError,
      );
      assert.throws(
        () => new Cursor(Uint8Array.from([0xf0, 0xff, 0xff, 0xff])).initialLength(),
        DwarfParseError,
      );
    });

    it('bytes(n) returns the slice and advances; skip(n) advances', () => {
      const c = new Cursor(Uint8Array.from([1, 2, 3, 4, 5]));
      assert.deepStrictEqual(Array.from(c.bytes(2)), [1, 2]);
      c.skip(1);
      assert.strictEqual(c.pos, 3);
      assert.strictEqual(c.remaining, 2);
      assert.strictEqual(c.atEnd, false);
    });

    it('throws DwarfParseError on any read past the end', () => {
      assert.throws(() => new Cursor(Uint8Array.from([])).u8(), DwarfParseError);
      assert.throws(() => new Cursor(Uint8Array.from([1, 2, 3])).u32(), DwarfParseError);
      // Continuation bit set on the last byte.
      assert.throws(() => new Cursor(Uint8Array.from([0x80])).uleb(), DwarfParseError);
      assert.throws(() => new Cursor(Uint8Array.from([0x80])).sleb(), DwarfParseError);
      // No NUL terminator before the end.
      assert.throws(() => new Cursor(Uint8Array.from([0x61, 0x62])).cstring(), DwarfParseError);
      assert.throws(() => new Cursor(Uint8Array.from([1, 2])).bytes(3), DwarfParseError);
      assert.throws(() => new Cursor(Uint8Array.from([1, 2])).skip(3), DwarfParseError);
    });
  });
});

describe('dwarf/abbrev', () => {
  // Hand-built .debug_abbrev table preceded by two junk bytes (parse starts at
  // offset 2) and followed by trailing garbage after the code-0 terminator.
  //
  // decl 1: code 1, DW_TAG_compile_unit (0x11), has children,
  //   DW_AT_name (0x03) : DW_FORM_strp (0x0e)
  //   DW_AT_comp_dir (0x1b) : DW_FORM_line_strp (0x1f)
  //   DW_AT_stmt_list (0x10) : DW_FORM_sec_offset (0x17)
  // decl 2: code 2, DW_TAG_subprogram (0x2e), no children,
  //   DW_AT_name (0x03) : DW_FORM_string (0x08)
  //   DW_AT_type (0x49) : DW_FORM_implicit_const (0x21), value -5 (SLEB 0x7b)
  const table = Uint8Array.from([
    0xde, 0xad,
    0x01, 0x11, 0x01, 0x03, 0x0e, 0x1b, 0x1f, 0x10, 0x17, 0x00, 0x00,
    0x02, 0x2e, 0x00, 0x03, 0x08, 0x49, 0x21, 0x7b, 0x00, 0x00,
    0x00,
    0xff, 0xee,
  ]);

  it('parses declarations, attribute specs, and implicit_const values', () => {
    const abbrevs = parseAbbrevTable(table, 2);
    assert.strictEqual(abbrevs.size, 2);

    const cu = abbrevs.get(1);
    assert.ok(cu);
    assert.strictEqual(cu.tag, 0x11);
    assert.strictEqual(cu.hasChildren, true);
    assert.strictEqual(cu.attrs.length, 3);
    assert.strictEqual(cu.attrs[0].at, 0x03);
    assert.strictEqual(cu.attrs[0].form, 0x0e);
    assert.strictEqual(cu.attrs[1].at, 0x1b);
    assert.strictEqual(cu.attrs[1].form, 0x1f);
    assert.strictEqual(cu.attrs[2].at, 0x10);
    assert.strictEqual(cu.attrs[2].form, 0x17);

    const sub = abbrevs.get(2);
    assert.ok(sub);
    assert.strictEqual(sub.tag, 0x2e);
    assert.strictEqual(sub.hasChildren, false);
    assert.strictEqual(sub.attrs.length, 2);
    assert.strictEqual(sub.attrs[1].at, 0x49);
    assert.strictEqual(sub.attrs[1].form, 0x21);
    assert.strictEqual(sub.attrs[1].implicitConst, -5);
  });

  it('stops at the code-0 terminator without consuming trailing bytes as decls', () => {
    const abbrevs = parseAbbrevTable(table, 2);
    assert.deepStrictEqual(Array.from(abbrevs.keys()).sort(), [1, 2]);
  });
});

describe('dwarf/info', () => {
  it('scans the adder fixture CUs and extracts stmt_list and comp_dir', async () => {
    const bytes = await fs.readFile(ADDER_WASM);
    const parsed = parseWasmSections(bytes);
    const info = parsed.customSection('.debug_info');
    const abbrev = parsed.customSection('.debug_abbrev');
    assert.ok(info, 'fixture must have .debug_info');
    assert.ok(abbrev, 'fixture must have .debug_abbrev');

    const cus = scanCompilationUnits({
      info,
      abbrev,
      str: parsed.customSection('.debug_str'),
      lineStr: parsed.customSection('.debug_line_str'),
    });
    assert.ok(cus.length >= 1, 'expected at least one compilation unit');

    const adder = cus.find(
      (cu: { compDir?: string }) => cu.compDir !== undefined && cu.compDir.endsWith('examples/adder'),
    );
    assert.ok(adder, 'expected the adder CU (comp_dir ending examples/adder)');
    assert.ok(adder.compDir !== undefined && adder.compDir.startsWith('/'), 'comp_dir must be absolute');
    assert.strictEqual(typeof adder.stmtListOffset, 'number');

    const debugLine = parsed.customSection('.debug_line');
    assert.ok(debugLine);
    for (const cu of cus) {
      if (cu.stmtListOffset !== undefined) {
        assert.ok(
          cu.stmtListOffset >= 0 && cu.stmtListOffset < debugLine.length,
          `stmt_list offset ${cu.stmtListOffset} must point into .debug_line`,
        );
      }
    }
  });
});

describe('dwarf/line', () => {
  it('parses every unit of the adder fixture .debug_line, header-only units included', async () => {
    const bytes = await fs.readFile(ADDER_WASM);
    const parsed = parseWasmSections(bytes);
    const debugLine = parsed.customSection('.debug_line');
    assert.ok(debugLine, 'fixture must have .debug_line');
    assert.ok(parsed.codeSection, 'fixture must have a code section');
    const codeSize = parsed.codeSection.payloadEnd - parsed.codeSection.payloadStart;

    const units = [];
    let offset = 0;
    while (offset < debugLine.length) {
      const unit = parseLineProgram(debugLine, offset);
      assert.ok(unit.endOffset > offset, 'a unit must consume at least its header');
      units.push(unit);
      offset = unit.endOffset;
    }
    assert.strictEqual(offset, debugLine.length, 'units must tile the section exactly');

    assert.ok(units.length >= 2, 'fixture has multiple line-program units');
    assert.ok(
      units.some((u) => u.rows.length === 0),
      'header-only units must yield zero rows without throwing',
    );

    const rows = units.flatMap((u) => u.rows);
    assert.ok(rows.length > 0, 'expected line rows overall');
    for (const row of rows) {
      if (!row.endSequence) {
        assert.ok(
          row.address >= 0 && row.address < codeSize,
          `row address ${row.address} must be a code offset within [0, ${codeSize})`,
        );
      }
    }
  });
});

describe('dwarf/LineTable', () => {
  describe('fromWasm on the adder debug fixture', () => {
    let table: DwarfLineTable;

    before(async () => {
      const bytes = await fs.readFile(ADDER_WASM);
      const result = DwarfLineTable.fromWasm(bytes);
      assert.ok(result, 'expected a line table from the debug build');
      table = result;
    });

    it('has entries sorted by address', () => {
      assert.ok(table.entries.length > 0);
      for (let i = 1; i < table.entries.length; i++) {
        assert.ok(
          table.entries[i].address >= table.entries[i - 1].address,
          `entries out of order at index ${i}`,
        );
      }
    });

    it('files() is unique, sorted, includes the adder lib.rs, and is ".."-normalized', () => {
      const files: string[] = table.files();
      assert.deepStrictEqual(files, Array.from(new Set(files)).sort());
      assert.ok(
        files.some((f) => f.endsWith(LIB_RS_SUFFIX)),
        `expected a file ending ${LIB_RS_SUFFIX}, got: ${files.join(', ')}`,
      );
      for (const f of files) {
        assert.ok(!f.split('/').includes('..'), `path not normalized: ${f}`);
      }
    });

    it('addressesFor(lib.rs, 16) is non-empty (the `a + b` expression)', () => {
      const libRs = table.files().find((f: string) => f.endsWith(LIB_RS_SUFFIX));
      assert.ok(libRs);
      const addrs = table.addressesFor(libRs, 16);
      assert.ok(addrs.length > 0, 'expected code offsets for lib.rs:16');
      assert.deepStrictEqual(table.addressesFor(libRs, 999999), []);
      assert.deepStrictEqual(table.addressesFor('/no/such/file.rs', 16), []);
    });

    it('lookup(pos) of the traced i32.add record maps into lib.rs line 16', async () => {
      const text = await fs.readFile(ADDER_TRACE, 'utf8');
      const records = text
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { pos: number | null; instr: unknown[] });
      const add = records.find(
        (r) => r.pos !== null && r.instr[0] === 'add' && r.instr[1] === 'i32',
      );
      assert.ok(add, 'trace fixture must contain an ["add","i32"] record with a pos');
      assert.ok(add.pos !== null);

      const entry = table.lookup(add.pos);
      assert.ok(entry, `expected a mapping for code offset ${add.pos}`);
      assert.strictEqual(entry.endSequence, false);
      assert.ok(
        entry.path.endsWith(LIB_RS_SUFFIX),
        `expected ${LIB_RS_SUFFIX}, got ${entry.path}`,
      );
      assert.strictEqual(entry.line, 16);
    });

    it('lookup() returns the greatest entry at or below the offset', () => {
      // Derive a gap from the table itself: a non-endSequence entry whose
      // successor is more than one byte away.
      const entries = table.entries;
      const i = entries.findIndex(
        (e: { address: number; endSequence: boolean }, k: number) =>
          !e.endSequence && k + 1 < entries.length && entries[k + 1].address > e.address + 1,
      );
      assert.ok(i >= 0, 'expected at least one address gap in the table');
      const hit = table.lookup(entries[i].address + 1);
      assert.ok(hit);
      assert.strictEqual(hit.address, entries[i].address);
      assert.strictEqual(hit.line, entries[i].line);
    });

    it('lookup() past the last sequence end is null', () => {
      const last = table.entries[table.entries.length - 1];
      assert.strictEqual(table.lookup(last.address + 1), null);
      assert.strictEqual(table.lookup(last.address + 100000), null);
    });

    it('lookup() below the first entry is null', () => {
      const first = table.entries[0];
      // The fixture's first mapped instruction sits after the code-section
      // count/size ULEBs, so offset 0 has no entry at or below it.
      assert.ok(first.address > 0, 'fixture precondition: no entry at address 0');
      assert.strictEqual(table.lookup(0), null);
      assert.strictEqual(table.lookup(first.address - 1), null);
    });
  });

  it('fromWasm returns null for a stripped module (no debug sections)', async () => {
    const bytes = await fs.readFile(STRIPPED_WASM);
    assert.strictEqual(DwarfLineTable.fromWasm(bytes), null);
  });

  it('fromWasm propagates DwarfParseError for an unsupported line-program version', async () => {
    const doctored = Uint8Array.from(await fs.readFile(ADDER_WASM));
    const debugLine = parseWasmSections(doctored).sections.find((s) => s.name === '.debug_line');
    assert.ok(debugLine);
    // The version u16 sits right after the 4-byte unit_length of the first unit.
    doctored[debugLine.payloadStart + 4] = 3;
    doctored[debugLine.payloadStart + 5] = 0;
    assert.throws(() => DwarfLineTable.fromWasm(doctored), DwarfParseError);
  });
});
