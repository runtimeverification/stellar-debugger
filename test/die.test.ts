import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import { parseDebugInfo, dieName, dieRef, dieUint, Die } from '../src/dwarf/die';
import { DwarfParseError } from '../src/dwarf/cursor';
import { parseWasmSections } from '../src/wasm/sections';
import {
  DW_TAG_compile_unit,
  DW_TAG_base_type,
  DW_TAG_subprogram,
  DW_TAG_formal_parameter,
  DW_TAG_variable,
  DW_AT_type,
  DW_AT_byte_size,
} from '../src/dwarf/constants';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const ADDER_WASM = path.join(FIXTURES, 'adder-debug.wasm');

// --- DWARF form / attribute / tag byte constants used only in the encoders ---
const FORM_string = 0x08;
const FORM_data1 = 0x0b;
const FORM_ref4 = 0x13;
const FORM_ref_addr = 0x10;
const AT_name = 0x03;
const AT_byte_size_b = 0x0b;
const AT_encoding = 0x3e;
const AT_type_b = 0x49;
const ATE_unsigned = 0x07;

/**
 * A little-endian byte builder that tracks its own length so callers can record
 * the absolute offset of each structure as they encode it. Everything is written
 * into one buffer, so recorded offsets are section-absolute — exactly what the
 * DIE parser keys `dieByOffset` on.
 */
class ByteWriter {
  private readonly buf: number[] = [];

  get pos(): number {
    return this.buf.length;
  }

  u8(v: number): void {
    this.buf.push(v & 0xff);
  }

  u16(v: number): void {
    this.u8(v);
    this.u8(v >>> 8);
  }

  u32(v: number): void {
    this.u8(v);
    this.u8(v >>> 8);
    this.u8(v >>> 16);
    this.u8(v >>> 24);
  }

  uleb(v: number): void {
    let value = v;
    do {
      let byte = value & 0x7f;
      value = Math.floor(value / 128);
      if (value !== 0) {
        byte |= 0x80;
      }
      this.buf.push(byte);
    } while (value !== 0);
  }

  cstr(s: string): void {
    for (const byte of Buffer.from(s, 'utf8')) {
      this.buf.push(byte);
    }
    this.buf.push(0);
  }

  /** Overwrite the 4 little-endian bytes at `at` (used to back-patch unit_length). */
  patchU32(at: number, v: number): void {
    this.buf[at] = v & 0xff;
    this.buf[at + 1] = (v >>> 8) & 0xff;
    this.buf[at + 2] = (v >>> 16) & 0xff;
    this.buf[at + 3] = (v >>> 24) & 0xff;
  }

  toU8(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}

/** Writes one abbreviation declaration (code, tag, children flag, attr specs). */
function writeAbbrevDecl(
  w: ByteWriter,
  code: number,
  tag: number,
  hasChildren: boolean,
  attrs: Array<[number, number]>,
): void {
  w.uleb(code);
  w.uleb(tag);
  w.u8(hasChildren ? 1 : 0);
  for (const [at, form] of attrs) {
    w.uleb(at);
    w.uleb(form);
  }
  w.uleb(0);
  w.uleb(0);
}

/** Collects a DIE and its whole subtree into `out` (pre-order). */
function collectDies(die: Die, out: Die[]): void {
  out.push(die);
  for (const child of die.children) {
    collectDies(child, out);
  }
}

/**
 * A minimal single-CU (DWARF v4) module:
 *   compile_unit "cu"
 *     base_type "u32" (byte_size 4, encoding unsigned)
 *     subprogram "add"
 *       formal_parameter "arg_0"  (DW_AT_type ref4 -> base_type)
 *       formal_parameter "arg_1"  (DW_AT_type ref4 -> base_type)
 * The CU header starts at offset 0, so each recorded byte offset is both the
 * DIE's absolute `secOffset` and (for ref4) the CU-relative target value.
 */
function buildSyntheticV4(): {
  sections: { info: Uint8Array; abbrev: Uint8Array };
  offsets: { cuOff: number; baseOff: number; subOff: number; p0Off: number; p1Off: number };
} {
  const abbrev = new ByteWriter();
  writeAbbrevDecl(abbrev, 1, DW_TAG_compile_unit, true, [[AT_name, FORM_string]]);
  writeAbbrevDecl(abbrev, 2, DW_TAG_base_type, false, [
    [AT_name, FORM_string],
    [AT_byte_size_b, FORM_data1],
    [AT_encoding, FORM_data1],
  ]);
  writeAbbrevDecl(abbrev, 3, DW_TAG_subprogram, true, [[AT_name, FORM_string]]);
  writeAbbrevDecl(abbrev, 4, DW_TAG_formal_parameter, false, [
    [AT_name, FORM_string],
    [AT_type_b, FORM_ref4],
  ]);
  abbrev.uleb(0); // table terminator

  const info = new ByteWriter();
  const lenPos = info.pos;
  info.u32(0); // unit_length placeholder
  info.u16(4); // version
  info.u32(0); // abbrev_offset
  info.u8(4); // address_size

  const cuOff = info.pos;
  info.uleb(1);
  info.cstr('cu');

  const baseOff = info.pos;
  info.uleb(2);
  info.cstr('u32');
  info.u8(4);
  info.u8(ATE_unsigned);

  const subOff = info.pos;
  info.uleb(3);
  info.cstr('add');

  const p0Off = info.pos;
  info.uleb(4);
  info.cstr('arg_0');
  info.u32(baseOff); // ref4: CU-relative == absolute since headerStart is 0

  const p1Off = info.pos;
  info.uleb(4);
  info.cstr('arg_1');
  info.u32(baseOff);

  info.uleb(0); // end subprogram children
  info.uleb(0); // end compile_unit children
  info.patchU32(lenPos, info.pos - (lenPos + 4));

  return {
    sections: { info: info.toU8(), abbrev: abbrev.toU8() },
    offsets: { cuOff, baseOff, subOff, p0Off, p1Off },
  };
}

/**
 * Two DWARF v4 CUs in one `.debug_info`. CU #1 holds a base_type; CU #2 holds a
 * variable whose DW_AT_type is a `ref_addr` (section-absolute) pointing back at
 * the CU #1 base_type.
 */
function buildSyntheticTwoCU(): {
  sections: { info: Uint8Array; abbrev: Uint8Array };
  offsets: { baseOff: number; varOff: number; cu2HeaderStart: number };
} {
  const abbrev = new ByteWriter();
  writeAbbrevDecl(abbrev, 1, DW_TAG_compile_unit, true, [[AT_name, FORM_string]]);
  writeAbbrevDecl(abbrev, 2, DW_TAG_base_type, false, [[AT_name, FORM_string]]);
  writeAbbrevDecl(abbrev, 3, DW_TAG_variable, false, [[AT_type_b, FORM_ref_addr]]);
  abbrev.uleb(0);

  const info = new ByteWriter();

  // CU #1
  const len1 = info.pos;
  info.u32(0);
  info.u16(4);
  info.u32(0);
  info.u8(4);
  info.uleb(1);
  info.cstr('cu1');
  const baseOff = info.pos;
  info.uleb(2);
  info.cstr('target');
  info.uleb(0); // end cu1 children
  info.patchU32(len1, info.pos - (len1 + 4));

  // CU #2
  const cu2HeaderStart = info.pos;
  const len2 = info.pos;
  info.u32(0);
  info.u16(4);
  info.u32(0);
  info.u8(4);
  info.uleb(1);
  info.cstr('cu2');
  const varOff = info.pos;
  info.uleb(3);
  info.u32(baseOff); // ref_addr: absolute offset into .debug_info
  info.uleb(0); // end cu2 children
  info.patchU32(len2, info.pos - (len2 + 4));

  return { sections: { info: info.toU8(), abbrev: abbrev.toU8() }, offsets: { baseOff, varOff, cu2HeaderStart } };
}

describe('dwarf/die', () => {
  describe('parseDebugInfo on the adder fixture (real anchor)', () => {
    let debug: ReturnType<typeof parseDebugInfo>;
    let allDies: Die[];

    before(async () => {
      const bytes = await fs.readFile(ADDER_WASM);
      const parsed = parseWasmSections(bytes);
      const info = parsed.customSection('.debug_info');
      const abbrev = parsed.customSection('.debug_abbrev');
      assert.ok(info, 'fixture must have .debug_info');
      assert.ok(abbrev, 'fixture must have .debug_abbrev');
      debug = parseDebugInfo({
        info,
        abbrev,
        str: parsed.customSection('.debug_str'),
        lineStr: parsed.customSection('.debug_line_str'),
      });
      allDies = [];
      for (const cu of debug.units) {
        collectDies(cu.die, allDies);
      }
    });

    it('produces at least one CU and a large global dieByOffset map', () => {
      assert.ok(debug.units.length >= 1, 'expected at least one compilation unit');
      assert.ok(
        debug.dieByOffset.size > 100,
        `expected hundreds of DIEs, got ${debug.dieByOffset.size}`,
      );
    });

    it('has at least one subprogram DIE reachable in the tree', () => {
      assert.ok(
        allDies.some((d) => d.tag === DW_TAG_subprogram),
        'expected a DW_TAG_subprogram in the DIE tree',
      );
    });

    it('has a named formal_parameter (the adder args)', () => {
      const named = allDies.filter(
        (d) => d.tag === DW_TAG_formal_parameter && typeof dieName(d) === 'string' && dieName(d) !== '',
      );
      assert.ok(named.length > 0, 'expected at least one named DW_TAG_formal_parameter');
    });

    it('resolves a DW_AT_type ref to a real DIE via dieByOffset', () => {
      const withType = allDies.find((d) => dieRef(d, DW_AT_type) !== undefined);
      assert.ok(withType, 'expected a DIE carrying a DW_AT_type reference');
      const ref = dieRef(withType, DW_AT_type)!;
      assert.ok(
        debug.dieByOffset.get(ref) !== undefined,
        `DW_AT_type ref ${ref} must resolve to a DIE in dieByOffset`,
      );
    });
  });

  describe('parseDebugInfo on a synthetic v4 tree', () => {
    const built = buildSyntheticV4();
    const debug = parseDebugInfo(built.sections);
    const { cuOff, baseOff, subOff, p0Off, p1Off } = built.offsets;

    it('builds the expected tree shape with correct nesting', () => {
      assert.strictEqual(debug.units.length, 1);
      const root = debug.units[0].die;
      assert.strictEqual(root.tag, DW_TAG_compile_unit);
      assert.strictEqual(root.secOffset, cuOff);
      assert.strictEqual(root.children.length, 2);

      const [base, sub] = root.children;
      assert.strictEqual(base.tag, DW_TAG_base_type);
      assert.strictEqual(sub.tag, DW_TAG_subprogram);
      assert.strictEqual(sub.children.length, 2);
      assert.strictEqual(sub.children[0].tag, DW_TAG_formal_parameter);
      assert.strictEqual(sub.children[1].tag, DW_TAG_formal_parameter);
    });

    it('records the CU header metadata', () => {
      assert.strictEqual(debug.units[0].version, 4);
      assert.strictEqual(debug.units[0].addressSize, 4);
      assert.strictEqual(debug.units[0].headerStart, 0);
    });

    it('keys dieByOffset by absolute secOffset for every DIE', () => {
      for (const off of [cuOff, baseOff, subOff, p0Off, p1Off]) {
        assert.ok(debug.dieByOffset.get(off) !== undefined, `no DIE at offset ${off}`);
        assert.strictEqual(debug.dieByOffset.get(off)!.secOffset, off);
      }
      assert.strictEqual(debug.dieByOffset.get(baseOff)!.tag, DW_TAG_base_type);
      assert.strictEqual(debug.dieByOffset.get(subOff)!.tag, DW_TAG_subprogram);
    });

    it('resolves the formal_parameter DW_AT_type ref4 to the base_type absolute offset', () => {
      const param = debug.dieByOffset.get(p0Off)!;
      const ref = dieRef(param, DW_AT_type);
      assert.strictEqual(ref, baseOff);
      assert.strictEqual(debug.dieByOffset.get(ref!)!.tag, DW_TAG_base_type);
    });

    it('exposes the accessor helpers (dieName / dieUint)', () => {
      const base = debug.dieByOffset.get(baseOff)!;
      assert.strictEqual(dieName(base), 'u32');
      assert.strictEqual(dieUint(base, DW_AT_byte_size), 4);
      // A non-ref attribute is not a ref, and an absent attribute is undefined.
      assert.strictEqual(dieRef(base, DW_AT_type), undefined);
      assert.strictEqual(dieName(debug.dieByOffset.get(p0Off)!), 'arg_0');
    });
  });

  describe('null-terminator handling', () => {
    const debug = parseDebugInfo(buildSyntheticV4().sections);
    const root = debug.units[0].die;

    it('stops a sibling list exactly at the null entry (no over-read)', () => {
      // compile_unit had two real children before its null terminator.
      assert.strictEqual(root.children.length, 2);
      // subprogram had exactly two formal_parameters before its null terminator.
      const sub = root.children[1];
      assert.strictEqual(sub.children.length, 2);
    });

    it('gives a hasChildren=false DIE an empty children array', () => {
      const base = root.children[0];
      assert.strictEqual(base.tag, DW_TAG_base_type);
      assert.strictEqual(base.children.length, 0);
      for (const param of root.children[1].children) {
        assert.strictEqual(param.children.length, 0);
      }
    });
  });

  describe('two CUs with a cross-CU ref_addr', () => {
    const built = buildSyntheticTwoCU();
    const debug = parseDebugInfo(built.sections);
    const { baseOff, varOff, cu2HeaderStart } = built.offsets;

    it('parses both CUs into units', () => {
      assert.strictEqual(debug.units.length, 2);
      assert.strictEqual(debug.units[0].headerStart, 0);
      assert.strictEqual(debug.units[1].headerStart, cu2HeaderStart);
    });

    it('spans both CUs in the global dieByOffset map', () => {
      assert.ok(debug.dieByOffset.get(baseOff) !== undefined, 'CU #1 base_type must be mapped');
      assert.ok(debug.dieByOffset.get(varOff) !== undefined, 'CU #2 variable must be mapped');
      assert.strictEqual(debug.dieByOffset.get(baseOff)!.tag, DW_TAG_base_type);
      assert.strictEqual(debug.dieByOffset.get(varOff)!.tag, DW_TAG_variable);
    });

    it('resolves the CU #2 ref_addr to the CU #1 DIE', () => {
      const variable = debug.dieByOffset.get(varOff)!;
      const ref = dieRef(variable, DW_AT_type);
      assert.strictEqual(ref, baseOff, 'ref_addr must be the section-absolute CU #1 offset');
      assert.strictEqual(debug.dieByOffset.get(ref!)!.tag, DW_TAG_base_type);
    });
  });

  describe('DWARF v5 header', () => {
    it('parses the v5 field order (unit_type before address_size) and root DIE', () => {
      const abbrev = new ByteWriter();
      writeAbbrevDecl(abbrev, 1, DW_TAG_compile_unit, true, [[AT_name, FORM_string]]);
      abbrev.uleb(0);

      const info = new ByteWriter();
      const lenPos = info.pos;
      info.u32(0);
      info.u16(5); // version
      info.u8(0x01); // unit_type (DW_UT_compile)
      info.u8(4); // address_size
      info.u32(0); // abbrev_offset
      const cuOff = info.pos;
      info.uleb(1);
      info.cstr('v5cu');
      info.uleb(0); // end children
      info.patchU32(lenPos, info.pos - (lenPos + 4));

      const debug = parseDebugInfo({ info: info.toU8(), abbrev: abbrev.toU8() });
      assert.strictEqual(debug.units.length, 1);
      assert.strictEqual(debug.units[0].version, 5);
      assert.strictEqual(debug.units[0].addressSize, 4);
      const root = debug.units[0].die;
      assert.strictEqual(root.tag, DW_TAG_compile_unit);
      assert.strictEqual(root.secOffset, cuOff);
      assert.strictEqual(dieName(root), 'v5cu');
    });
  });

  describe('errors', () => {
    it('throws DwarfParseError on an unknown abbreviation code', () => {
      const abbrev = new ByteWriter();
      writeAbbrevDecl(abbrev, 1, DW_TAG_compile_unit, true, [[AT_name, FORM_string]]);
      abbrev.uleb(0);

      const info = new ByteWriter();
      const lenPos = info.pos;
      info.u32(0);
      info.u16(4);
      info.u32(0);
      info.u8(4);
      info.uleb(9); // no abbrev with code 9 exists
      info.patchU32(lenPos, info.pos - (lenPos + 4));

      assert.throws(
        () => parseDebugInfo({ info: info.toU8(), abbrev: abbrev.toU8() }),
        DwarfParseError,
      );
    });

    it('throws DwarfParseError on an unsupported .debug_info version', () => {
      const abbrev = new ByteWriter();
      writeAbbrevDecl(abbrev, 1, DW_TAG_compile_unit, true, [[AT_name, FORM_string]]);
      abbrev.uleb(0);

      const info = new ByteWriter();
      const lenPos = info.pos;
      info.u32(0);
      info.u16(3); // unsupported
      info.u32(0);
      info.u8(4);
      info.uleb(0);
      info.patchU32(lenPos, info.pos - (lenPos + 4));

      assert.throws(
        () => parseDebugInfo({ info: info.toU8(), abbrev: abbrev.toU8() }),
        DwarfParseError,
      );
    });
  });
});
