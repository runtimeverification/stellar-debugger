import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import { ScopeIndex } from '../src/dwarf/ScopeIndex';
import { parseDebugInfo, Die, CompUnit, DebugInfo } from '../src/dwarf/die';
import { AttrValue } from '../src/dwarf/forms';
import { parseWasmSections } from '../src/wasm/sections';
import {
  DW_TAG_compile_unit,
  DW_TAG_subprogram,
  DW_TAG_formal_parameter,
  DW_TAG_variable,
  DW_TAG_lexical_block,
  DW_AT_name,
  DW_AT_low_pc,
  DW_AT_high_pc,
  DW_AT_ranges,
  DW_AT_location,
  DW_AT_type,
  DW_AT_frame_base,
} from '../src/dwarf/constants';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const ADDER_WASM = path.join(FIXTURES, 'adder-debug.wasm');
const ADDER_TRACE = path.join(FIXTURES, 'adder-debug.trace.jsonl');

// --- Tiny constructors for hand-built in-memory DIEs and their attributes. ---
// As in the TypeRegistry tests, the synthetic cases build `Die` literals directly
// (the shape M2's parseDebugInfo produces). ScopeIndex walks `info.units[i].die`,
// so we also wrap the roots into a `DebugInfo` with a global dieByOffset map.

const uint = (value: number): AttrValue => ({ kind: 'uint', value });
const str = (value: string): AttrValue => ({ kind: 'str', value });
const ref = (value: number): AttrValue => ({ kind: 'ref', value });
/** A block/exprloc attribute from raw opcode bytes. */
const block = (...bytes: number[]): AttrValue => ({ kind: 'block', value: Uint8Array.from(bytes) });

function die(
  secOffset: number,
  tag: number,
  attrs: Array<[number, AttrValue]>,
  children: Die[] = [],
): Die {
  return { secOffset, tag, attrs: new Map(attrs), children };
}

/** Recursively index a DIE and its whole subtree by absolute secOffset. */
function collect(node: Die, into: Map<number, Die>): void {
  into.set(node.secOffset, node);
  for (const child of node.children) {
    collect(child, into);
  }
}

/**
 * Wrap one or more CU-root DIEs into a DebugInfo: one CompUnit per root plus a
 * dieByOffset map spanning every DIE in every tree.
 */
function debugInfoOf(...roots: Die[]): DebugInfo {
  const dieByOffset = new Map<number, Die>();
  const units: CompUnit[] = roots.map((root) => {
    collect(root, dieByOffset);
    return { version: 4, addressSize: 4, headerStart: 0, die: root };
  });
  return { units, dieByOffset };
}

describe('dwarf/ScopeIndex', () => {
  // 1. Real fixture anchor -------------------------------------------------
  describe('adder-debug.wasm fixture', () => {
    it('functionAt / variablesInScope at the traced i32.add instruction', async () => {
      const bytes = await fs.readFile(ADDER_WASM);
      const parsed = parseWasmSections(bytes);
      const info = parsed.customSection('.debug_info');
      const abbrev = parsed.customSection('.debug_abbrev');
      assert.ok(info, 'fixture must have .debug_info');
      assert.ok(abbrev, 'fixture must have .debug_abbrev');

      const debug = parseDebugInfo({
        info,
        abbrev,
        str: parsed.customSection('.debug_str'),
        lineStr: parsed.customSection('.debug_line_str'),
      });
      const debugRanges = parsed.customSection('.debug_ranges');
      const scope = new ScopeIndex(debug, debugRanges);

      // The traced ["add","i32"] record gives a real code offset inside `add`.
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
      const pos = add.pos;

      const fn = scope.functionAt(pos);
      assert.ok(fn, `expected an enclosing function at code offset ${pos}`);
      assert.ok(typeof fn.name === 'string' && fn.name.length > 0, 'function must have a non-empty name');
      assert.ok(typeof scope.functionNameAt(pos) === 'string' && scope.functionNameAt(pos)!.length > 0);

      const vars = scope.variablesInScope(pos);
      const params = vars.filter((v) => v.isParam);
      assert.ok(params.length >= 2, `expected at least two parameters in scope, got ${params.length}`);
      // The adder params live in WASM_location exprlocs.
      for (const p of params) {
        assert.ok(p.locationExpr instanceof Uint8Array, 'each param must carry a locationExpr');
        assert.strictEqual(p.isParam, true);
      }
    });
  });

  // 2. Contiguous range math -----------------------------------------------
  describe('contiguous low_pc/high_pc range', () => {
    it('covers [low_pc, low_pc + high_pc) with high_pc read as a SIZE', () => {
      // subprogram "f": low_pc = 0x100, high_pc(size) = 0x40 -> covers 0x100..0x13f.
      const fn = die(20, DW_TAG_subprogram, [
        [DW_AT_name, str('f')],
        [DW_AT_low_pc, uint(0x100)],
        [DW_AT_high_pc, uint(0x40)],
      ]);
      const cu = die(10, DW_TAG_compile_unit, [], [fn]);
      const scope = new ScopeIndex(debugInfoOf(cu));

      assert.ok(scope.functionAt(0x100), 'start address is inside the range');
      assert.ok(scope.functionAt(0x13f), 'last covered address is inside the range');
      assert.strictEqual(scope.functionAt(0x140), null, 'end address is exclusive');
      assert.strictEqual(scope.functionAt(0xff), null, 'below the range');
      assert.strictEqual(scope.functionAt(0x140), null);

      const hit = scope.functionAt(0x120);
      assert.ok(hit);
      assert.strictEqual(hit.die.secOffset, 20);
      assert.strictEqual(hit.name, 'f');
    });
  });

  // 3. Params + variable + nested lexical_block ----------------------------
  describe('params, locals, and a nested lexical_block', () => {
    // subprogram "g": low_pc=0x100, high_pc=0x100 -> covers 0x100..0x1ff.
    //   formal_parameter "p"           (always in scope)
    //   variable          "local"      (always in scope)
    //   lexical_block: low_pc=0x180, high_pc=0x40 -> covers 0x180..0x1bf
    //     variable        "inner"      (in scope only inside the block)
    function build(): ScopeIndex {
      const p = die(210, DW_TAG_formal_parameter, [
        [DW_AT_name, str('p')],
        [DW_AT_location, block(0x50)],
      ]);
      const local = die(220, DW_TAG_variable, [
        [DW_AT_name, str('local')],
        [DW_AT_location, block(0x51)],
      ]);
      const inner = die(240, DW_TAG_variable, [
        [DW_AT_name, str('inner')],
        [DW_AT_location, block(0x52)],
      ]);
      const lex = die(230, DW_TAG_lexical_block, [
        [DW_AT_low_pc, uint(0x180)],
        [DW_AT_high_pc, uint(0x40)],
      ], [inner]);
      const fn = die(200, DW_TAG_subprogram, [
        [DW_AT_name, str('g')],
        [DW_AT_low_pc, uint(0x100)],
        [DW_AT_high_pc, uint(0x100)],
      ], [p, local, lex]);
      const cu = die(190, DW_TAG_compile_unit, [], [fn]);
      return new ScopeIndex(debugInfoOf(cu));
    }

    it('includes the block variable only at a pc inside the block', () => {
      const scope = build();
      const inside = scope.variablesInScope(0x190).map((v) => v.name);
      const outside = scope.variablesInScope(0x110).map((v) => v.name);
      assert.ok(inside.includes('inner'), 'block var is in scope inside the block');
      assert.ok(!outside.includes('inner'), 'block var is NOT in scope outside the block');
    });

    it('function params and direct locals are always in scope', () => {
      const scope = build();
      for (const pc of [0x110, 0x190]) {
        const names = scope.variablesInScope(pc).map((v) => v.name);
        assert.ok(names.includes('p'), `param in scope at 0x${pc.toString(16)}`);
        assert.ok(names.includes('local'), `local in scope at 0x${pc.toString(16)}`);
      }
      // Params carry isParam=true, ordinary locals false.
      const vars = scope.variablesInScope(0x190);
      assert.strictEqual(vars.find((v) => v.name === 'p')!.isParam, true);
      assert.strictEqual(vars.find((v) => v.name === 'local')!.isParam, false);
      assert.strictEqual(vars.find((v) => v.name === 'inner')!.isParam, false);
    });

    it('returns [] when no function encloses the pc', () => {
      const scope = build();
      assert.deepStrictEqual(scope.variablesInScope(0x9999), []);
    });
  });

  // 4. frameBaseExpr threading ---------------------------------------------
  describe('frameBaseExpr threading', () => {
    it('every returned ScopeVar carries the subprogram DW_AT_frame_base bytes', () => {
      const fbBytes = [0x9c]; // e.g. DW_OP_call_frame_cfa — arbitrary exprloc bytes.
      const p = die(310, DW_TAG_formal_parameter, [
        [DW_AT_name, str('a')],
        [DW_AT_location, block(0x50)],
      ]);
      const v = die(320, DW_TAG_variable, [
        [DW_AT_name, str('b')],
        [DW_AT_location, block(0x51)],
      ]);
      const fn = die(300, DW_TAG_subprogram, [
        [DW_AT_name, str('h')],
        [DW_AT_low_pc, uint(0x200)],
        [DW_AT_high_pc, uint(0x80)],
        [DW_AT_frame_base, block(...fbBytes)],
      ], [p, v]);
      const cu = die(290, DW_TAG_compile_unit, [], [fn]);
      const scope = new ScopeIndex(debugInfoOf(cu));

      const fnScope = scope.functionAt(0x210);
      assert.ok(fnScope);
      assert.deepStrictEqual(fnScope.frameBaseExpr, Uint8Array.from(fbBytes));

      const vars = scope.variablesInScope(0x210);
      assert.ok(vars.length >= 2);
      for (const sv of vars) {
        assert.deepStrictEqual(sv.frameBaseExpr, Uint8Array.from(fbBytes));
      }
    });
  });

  // 5. Location kinds ------------------------------------------------------
  describe('DW_AT_location kinds', () => {
    // subprogram "loc" with three locals:
    //   "expr" : exprloc  (block)     -> locationExpr set
    //   "list" : sec_offset (uint)    -> locListOffset set
    //   "gone" : no DW_AT_location    -> optimizedOut, still returned (has a name)
    function build(): ScopeIndex {
      const exprVar = die(410, DW_TAG_variable, [
        [DW_AT_name, str('expr')],
        [DW_AT_type, ref(900)],
        [DW_AT_location, block(0x91, 0x00)], // DW_OP_fbreg 0
      ]);
      const listVar = die(420, DW_TAG_variable, [
        [DW_AT_name, str('list')],
        [DW_AT_location, uint(0x40)], // sec_offset into .debug_loc
      ]);
      const goneVar = die(430, DW_TAG_variable, [[DW_AT_name, str('gone')]]);
      const fn = die(400, DW_TAG_subprogram, [
        [DW_AT_name, str('loc')],
        [DW_AT_low_pc, uint(0x300)],
        [DW_AT_high_pc, uint(0x40)],
      ], [exprVar, listVar, goneVar]);
      const cu = die(390, DW_TAG_compile_unit, [], [fn]);
      return new ScopeIndex(debugInfoOf(cu));
    }

    it('an exprloc location yields locationExpr (not optimized out, no locList)', () => {
      const v = build().variablesInScope(0x310).find((x) => x.name === 'expr')!;
      assert.ok(v.locationExpr instanceof Uint8Array);
      assert.deepStrictEqual(v.locationExpr, Uint8Array.from([0x91, 0x00]));
      assert.strictEqual(v.locListOffset, undefined);
      assert.strictEqual(v.optimizedOut, false);
      assert.strictEqual(v.typeRef, 900);
    });

    it('a sec_offset location yields locListOffset', () => {
      const v = build().variablesInScope(0x310).find((x) => x.name === 'list')!;
      assert.strictEqual(v.locListOffset, 0x40);
      assert.strictEqual(v.locationExpr, undefined);
      assert.strictEqual(v.optimizedOut, false);
    });

    it('a named var with no location is optimizedOut but still returned', () => {
      const v = build().variablesInScope(0x310).find((x) => x.name === 'gone')!;
      assert.ok(v, 'the location-less named var must still be present');
      assert.strictEqual(v.optimizedOut, true);
      assert.strictEqual(v.locationExpr, undefined);
      assert.strictEqual(v.locListOffset, undefined);
    });
  });

  // 6. .debug_ranges cover -------------------------------------------------
  describe('.debug_ranges (v4) with a base-selection entry', () => {
    it('resolves a subprogram whose range is described by DW_AT_ranges', () => {
      // .debug_ranges @0: base-selection sets base=0x2000, then range
      // [base+0x10, base+0x20) = [0x2010, 0x2020), then the (0,0) terminator.
      const ranges = Uint8Array.from([
        // base-selection: begin marker 0xffffffff, end = new base 0x2000
        0xff, 0xff, 0xff, 0xff, 0x00, 0x20, 0x00, 0x00,
        // range: begin=0x10, end=0x20 relative to base
        0x10, 0x00, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00,
        // terminator (0, 0)
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]);

      const p = die(520, DW_TAG_formal_parameter, [
        [DW_AT_name, str('x')],
        [DW_AT_location, block(0x50)],
      ]);
      const fn = die(510, DW_TAG_subprogram, [
        [DW_AT_name, str('ranged')],
        [DW_AT_ranges, uint(0)], // sec_offset into .debug_ranges
      ], [p]);
      // CU low_pc is the rangelist base default (overridden by the base-selection).
      const cu = die(500, DW_TAG_compile_unit, [[DW_AT_low_pc, uint(0x1000)]], [fn]);
      const scope = new ScopeIndex(debugInfoOf(cu), ranges);

      const hit = scope.functionAt(0x2015);
      assert.ok(hit, 'pc inside the resolved range must find the function');
      assert.strictEqual(hit.name, 'ranged');
      assert.strictEqual(scope.functionNameAt(0x2015), 'ranged');

      assert.strictEqual(scope.functionAt(0x2020), null, 'range end is exclusive');
      assert.strictEqual(scope.functionAt(0x2005), null, 'below the range (base+begin)');
      assert.strictEqual(scope.functionAt(0x1000), null, 'the raw CU base is not covered');

      const names = scope.variablesInScope(0x2015).map((v) => v.name);
      assert.ok(names.includes('x'), 'params resolve for range-described functions too');
    });
  });

  // 7. nameFallback --------------------------------------------------------
  describe('nameFallback', () => {
    it('functionNameAt uses the fallback when the subprogram has no DW_AT_name', () => {
      // Anonymous subprogram (no DW_AT_name) covering 0x400..0x43f.
      const fn = die(610, DW_TAG_subprogram, [
        [DW_AT_low_pc, uint(0x400)],
        [DW_AT_high_pc, uint(0x40)],
      ]);
      const cu = die(600, DW_TAG_compile_unit, [], [fn]);
      const fallback = (pc: number): string | undefined =>
        pc >= 0x400 && pc < 0x440 ? `wasm_func_${pc}` : undefined;
      const scope = new ScopeIndex(debugInfoOf(cu), undefined, fallback);

      const hit = scope.functionAt(0x410);
      assert.ok(hit, 'the anonymous subprogram is still located by range');
      assert.strictEqual(hit.name, undefined, 'it genuinely has no DIE name');
      assert.strictEqual(scope.functionNameAt(0x410), 'wasm_func_1040');
    });
  });
});
