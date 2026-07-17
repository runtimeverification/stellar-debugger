import * as assert from 'assert';
import { parseLineProgram } from '../src/dwarf/line';
import { DwarfParseError } from '../src/dwarf/cursor';
import * as C from '../src/dwarf/constants';

// ---------------------------------------------------------------------------
// Byte-encoding helpers for hand-assembling DWARF v5 .debug_line units. The
// committed fixtures are all DWARF v4, so these synthetic units are the only
// way to exercise the v5 header machinery (parseV5Tables / readPath /
// readDirectoryIndex) and the rarer state-machine opcodes.
// ---------------------------------------------------------------------------

function uleb(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return out;
}

function sleb(n: number): number[] {
  const out: number[] = [];
  let more = true;
  let v = n;
  while (more) {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    // sign bit of the byte is bit 6 (0x40)
    if ((v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0)) {
      more = false;
    } else {
      b |= 0x80;
    }
    out.push(b);
  }
  return out;
}

const u16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const u32 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const cstr = (s: string): number[] => [...Buffer.from(s, 'utf8'), 0];

/** Standard opcode operand-length table for opcode_base = 13 (DWARF default). */
const STD_OPCODE_LENGTHS = [0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1];

interface V5Opts {
  addressSize?: number;
  lineBase?: number; // signed; default -5 exercises the toSigned8 negative branch
  directoryFormat: Array<[number, number]>; // [content_type, form]
  directories: number[][]; // pre-encoded bytes per directory entry
  fileFormat: Array<[number, number]>;
  files: number[][];
  program: number[];
}

/** Assemble one complete DWARF v5 line-program unit. */
function assembleV5(o: V5Opts): number[] {
  const addressSize = o.addressSize ?? 4;
  const lineBase = o.lineBase ?? -5;

  const format = (pairs: Array<[number, number]>): number[] => [
    pairs.length,
    ...pairs.flatMap(([ct, form]) => [...uleb(ct), ...uleb(form)]),
  ];

  const headerBody = [
    1, // minimum_instruction_length
    1, // maximum_operations_per_instruction
    1, // default_is_stmt
    lineBase & 0xff, // line_base (signed byte)
    12, // line_range
    13, // opcode_base
    ...STD_OPCODE_LENGTHS,
    ...format(o.directoryFormat),
    ...uleb(o.directories.length),
    ...o.directories.flat(),
    ...format(o.fileFormat),
    ...uleb(o.files.length),
    ...o.files.flat(),
  ];

  const afterHeaderLength = [
    ...u16(5), // version
    addressSize, // address_size
    0, // segment_selector_size
    ...u32(headerBody.length), // header_length
    ...headerBody,
    ...o.program,
  ];
  return [...u32(afterHeaderLength.length), ...afterHeaderLength];
}

/** A program that emits three rows and exercises many opcodes. */
function richProgram(): number[] {
  return [
    // DW_LNE_set_address 0x10 (extended opcode: 0, len, sub-opcode, operand)
    0, ...uleb(1 + 4), C.DW_LNE_set_address, ...u32(0x10),
    C.DW_LNS_set_column, ...uleb(5),
    C.DW_LNS_set_file, ...uleb(0),
    C.DW_LNS_advance_line, ...sleb(9), // line 1 -> 10
    C.DW_LNS_copy, // emit row #1
    C.DW_LNS_advance_pc, ...uleb(4),
    C.DW_LNS_negate_stmt,
    14, // special opcode -> emit row #2
    C.DW_LNS_const_add_pc,
    C.DW_LNS_fixed_advance_pc, ...u16(0x20),
    C.DW_LNS_set_isa, ...uleb(1), // standard opcode with 1 operand -> default skip
    16, // special opcode -> emit row #3
    // DW_LNE_end_sequence
    0, ...uleb(1), C.DW_LNE_end_sequence,
  ];
}

describe('dwarf/line — DWARF v5 units', () => {
  it('parses directories and files (line_strp path, data1 dir index, skipped extra column)', () => {
    // .debug_line_str backing store: offset 0 = "lib.rs", offset 7 = "mod.rs".
    const lineStr = Uint8Array.from([...cstr('lib.rs'), ...cstr('mod.rs')]);

    const unit = assembleV5({
      directoryFormat: [[C.DW_LNCT_path, C.DW_FORM_string]],
      directories: [cstr('/work'), cstr('src')],
      fileFormat: [
        [C.DW_LNCT_path, C.DW_FORM_line_strp],
        [C.DW_LNCT_directory_index, C.DW_FORM_data1],
        [0x03 /* DW_LNCT_timestamp */, C.DW_FORM_udata], // exercises the skipByForm branch
      ],
      files: [
        [...u32(0), 0, ...uleb(111)], // path @0 "lib.rs", dir 0, ts
        [...u32(7), 1, ...uleb(222)], // path @7 "mod.rs", dir 1, ts
      ],
      program: richProgram(),
    });

    const result = parseLineProgram(Uint8Array.from(unit), 0, { lineStr });
    assert.strictEqual(result.version, 5);
    assert.strictEqual(result.endOffset, unit.length);
    assert.deepStrictEqual(result.directories, ['/work', 'src']);
    assert.deepStrictEqual(result.files, [
      { name: 'lib.rs', dirIndex: 0 },
      { name: 'mod.rs', dirIndex: 1 },
    ]);

    // Three matrix rows plus the end_sequence row.
    const emitted = result.rows.filter((r) => !r.endSequence);
    assert.strictEqual(emitted.length, 3);
    assert.strictEqual(emitted[0].address, 0x10);
    assert.strictEqual(emitted[0].line, 10);
    assert.strictEqual(emitted[0].column, 5);
    assert.strictEqual(emitted[0].isStmt, true);
    // Row #2 followed negate_stmt.
    assert.strictEqual(emitted[1].isStmt, false);
    assert.ok(result.rows.some((r) => r.endSequence), 'expected an end_sequence row');
  });

  it('reads a path via DW_FORM_strp and directory index via DW_FORM_data2/udata', () => {
    const str = Uint8Array.from([...cstr('root.rs')]);
    const unit = assembleV5({
      directoryFormat: [[C.DW_LNCT_path, C.DW_FORM_strp]],
      directories: [u32(0)], // "root.rs" via .debug_str
      fileFormat: [
        [C.DW_LNCT_path, C.DW_FORM_string],
        [C.DW_LNCT_directory_index, C.DW_FORM_data2],
      ],
      files: [[...cstr('a.rs'), ...u16(7)]],
      program: [],
    });
    const result = parseLineProgram(Uint8Array.from(unit), 0, { str });
    assert.deepStrictEqual(result.directories, ['root.rs']);
    assert.deepStrictEqual(result.files, [{ name: 'a.rs', dirIndex: 7 }]);

    const unit2 = assembleV5({
      directoryFormat: [[C.DW_LNCT_path, C.DW_FORM_string]],
      directories: [cstr('.')],
      fileFormat: [
        [C.DW_LNCT_path, C.DW_FORM_string],
        [C.DW_LNCT_directory_index, C.DW_FORM_udata],
      ],
      files: [[...cstr('b.rs'), ...uleb(300)]],
      program: [],
    });
    const r2 = parseLineProgram(Uint8Array.from(unit2), 0, {});
    assert.strictEqual(r2.files[0].dirIndex, 300);
  });

  it('throws on an unsupported directory-index form', () => {
    const unit = assembleV5({
      directoryFormat: [[C.DW_LNCT_path, C.DW_FORM_string]],
      directories: [cstr('.')],
      fileFormat: [
        [C.DW_LNCT_path, C.DW_FORM_string],
        [C.DW_LNCT_directory_index, C.DW_FORM_data4], // not data1/data2/udata
      ],
      files: [[...cstr('c.rs'), ...u32(1)]],
      program: [],
    });
    assert.throws(() => parseLineProgram(Uint8Array.from(unit), 0, {}), DwarfParseError);
  });

  it('falls back to empty path for an unknown path form (still consuming bytes)', () => {
    const unit = assembleV5({
      directoryFormat: [[C.DW_LNCT_path, C.DW_FORM_string]],
      directories: [cstr('.')],
      fileFormat: [[C.DW_LNCT_path, C.DW_FORM_data1]], // path via a non-string form
      files: [[42]],
      program: [],
    });
    const result = parseLineProgram(Uint8Array.from(unit), 0, {});
    assert.strictEqual(result.files[0].name, '');
  });
});

describe('dwarf/line — malformed unit guards', () => {
  function validUnit(): number[] {
    return assembleV5({
      directoryFormat: [[C.DW_LNCT_path, C.DW_FORM_string]],
      directories: [cstr('.')],
      fileFormat: [[C.DW_LNCT_path, C.DW_FORM_string]],
      files: [[...cstr('x.rs')]],
      program: [],
    });
  }

  it('throws when the unit_length extends past the section', () => {
    const unit = validUnit();
    // Inflate unit_length so endOffset exceeds the buffer.
    const bumped = Uint8Array.from(unit);
    bumped.set(u32(unit.length + 50), 0);
    assert.throws(() => parseLineProgram(bumped, 0, {}), /extends past the section/);
  });

  it('throws when header_length points past the unit', () => {
    const unit = Uint8Array.from(validUnit());
    // header_length is the u32 at bytes [8..12) of the unit (after the 4-byte
    // unit_length, version(2), address_size(1), segment_selector_size(1)).
    unit.set(u32(9999), 8);
    assert.throws(() => parseLineProgram(unit, 0, {}), /extends past its unit/);
  });

  it('throws when the tables overrun header_length (too-small header_length)', () => {
    const unit = Uint8Array.from(validUnit());
    unit.set(u32(1), 8); // header_length far too small for the real tables
    assert.throws(() => parseLineProgram(unit, 0, {}), /overrun header_length/);
  });
});
