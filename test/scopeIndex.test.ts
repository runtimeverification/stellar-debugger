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
  DW_TAG_inlined_subroutine,
  DW_TAG_namespace,
  DW_TAG_structure_type,
  DW_AT_name,
  DW_AT_low_pc,
  DW_AT_high_pc,
  DW_AT_ranges,
  DW_AT_location,
  DW_AT_type,
  DW_AT_frame_base,
  DW_AT_stmt_list,
  DW_AT_call_file,
  DW_AT_call_line,
  DW_AT_call_column,
  DW_AT_abstract_origin,
  DW_AT_specification,
  DW_AT_linkage_name,
} from '../src/dwarf/constants';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const ADDER_WASM = path.join(FIXTURES, 'adder-debug.wasm');
const ADDER_TRACE = path.join(FIXTURES, 'adder-debug.trace.jsonl');

// --- Tiny constructors for hand-built in-memory DIEs and their attributes. ---
// As in the TypeRegistry tests, the synthetic cases build `Die` literals directly
// (the shape parseDebugInfo produces). ScopeIndex walks `info.units[i].die`,
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
      assert.strictEqual(hit.qualifiedName, undefined, 'no name, nothing to qualify');
      assert.strictEqual(scope.functionNameAt(0x410), 'wasm_func_1040');
    });
  });

  // --- Frames: qualified names and inlined instances (docs/callstack.md) ----

  describe('qualifiedName (docs/callstack.md C4)', () => {
    it('prefixes the DIE name with its enclosing namespaces and types', () => {
      const fn = die(730, DW_TAG_subprogram, [
        [DW_AT_name, str('bump')],
        [DW_AT_low_pc, uint(0x10)],
        [DW_AT_high_pc, uint(0x10)],
      ]);
      const impl = die(720, DW_TAG_structure_type, [[DW_AT_name, str('Control')]], [fn]);
      const ns = die(710, DW_TAG_namespace, [[DW_AT_name, str('control')]], [impl]);
      const cu = die(700, DW_TAG_compile_unit, [], [ns]);
      const scope = new ScopeIndex(debugInfoOf(cu));

      assert.strictEqual(scope.functionAt(0x14)?.qualifiedName, 'control::Control::bump');
      // The bare name is unchanged — it is what `functionNameAt` reports.
      assert.strictEqual(scope.functionNameAt(0x14), 'bump');
    });

    it('ignores an unnamed enclosing scope rather than emitting an empty segment', () => {
      const fn = die(830, DW_TAG_subprogram, [
        [DW_AT_name, str('f')],
        [DW_AT_low_pc, uint(0x10)],
        [DW_AT_high_pc, uint(0x10)],
      ]);
      const anonymous = die(820, DW_TAG_namespace, [], [fn]);
      const cu = die(800, DW_TAG_compile_unit, [], [anonymous]);
      assert.strictEqual(new ScopeIndex(debugInfoOf(cu)).functionAt(0x10)?.qualifiedName, 'f');
    });
  });

  describe('inlineScopesAt (docs/callstack.md C2)', () => {
    /**
     * `outer` (0x100..0x1ff) contains an inlined `middle` (0x110..0x11f) which
     * itself contains an inlined `inner` (0x118..0x11b). `middle` declares `m`.
     */
    function nested(): ScopeIndex {
      const inner = die(940, DW_TAG_inlined_subroutine, [
        [DW_AT_name, str('inner')],
        [DW_AT_low_pc, uint(0x118)],
        [DW_AT_high_pc, uint(0x4)],
        [DW_AT_call_file, uint(2)],
        [DW_AT_call_line, uint(77)],
        [DW_AT_call_column, uint(9)],
      ]);
      const m = die(935, DW_TAG_variable, [[DW_AT_name, str('m')], [DW_AT_location, block(0x91, 0x10)]]);
      const middle = die(
        930,
        DW_TAG_inlined_subroutine,
        [
          [DW_AT_name, str('middle')],
          [DW_AT_low_pc, uint(0x110)],
          [DW_AT_high_pc, uint(0x10)],
          [DW_AT_call_file, uint(1)],
          [DW_AT_call_line, uint(42)],
        ],
        [m, inner],
      );
      const outer = die(
        920,
        DW_TAG_subprogram,
        [
          [DW_AT_name, str('outer')],
          [DW_AT_low_pc, uint(0x100)],
          [DW_AT_high_pc, uint(0x100)],
          [DW_AT_frame_base, block(0xed, 0x00, 0x00)],
        ],
        [middle],
      );
      const cu = die(900, DW_TAG_compile_unit, [[DW_AT_stmt_list, uint(64)]], [outer]);
      return new ScopeIndex(debugInfoOf(cu));
    }

    it('reports the covering instances outermost first, with their call sites', () => {
      const scopes = nested().inlineScopesAt(0x119);
      assert.deepStrictEqual(
        scopes.map((s) => [s.name, s.callFileIndex, s.callLine, s.callColumn]),
        [
          ['middle', 1, 42, undefined],
          ['inner', 2, 77, 9],
        ],
      );
      // Every instance names the line program its call file index belongs to.
      assert.deepStrictEqual(scopes.map((s) => s.stmtListOffset), [64, 64]);
    });

    it('reports only the instances whose own range covers the pc', () => {
      const index = nested();
      assert.deepStrictEqual(
        index.inlineScopesAt(0x112).map((s) => s.name),
        ['middle'],
      );
      assert.deepStrictEqual(index.inlineScopesAt(0x150), []);
      // Outside every function there is nothing to expand.
      assert.deepStrictEqual(index.inlineScopesAt(0x900), []);
    });

    it('gives each instance its OWN declarations, with the frame base threaded in', () => {
      const scopes = nested().inlineScopesAt(0x119);
      const middle = scopes[0];
      assert.deepStrictEqual(middle.variables.map((v) => v.name), ['m']);
      assert.ok(middle.variables[0].frameBaseExpr, 'the enclosing frame base must be threaded in');
      // `m` belongs to `middle`, not to the deeper instance…
      assert.deepStrictEqual(scopes[1].variables, []);
      // …and not to the enclosing function either, which never descends into an
      // inlined instance.
      assert.deepStrictEqual(nested().variablesInScope(0x119), []);
    });

    it('skips an instance with no readable range instead of placing it anywhere', () => {
      // No low_pc/high_pc and no ranges: the instance cannot be placed, and a
      // guessed frame would misreport the program (C2).
      const rangeless = die(1030, DW_TAG_inlined_subroutine, [[DW_AT_name, str('nowhere')]]);
      // A tombstoned instance is dropped for the same reason.
      const tombstoned = die(1035, DW_TAG_inlined_subroutine, [
        [DW_AT_name, str('dropped')],
        [DW_AT_low_pc, uint(0xffffffff)],
        [DW_AT_high_pc, uint(0x10)],
      ]);
      const fn = die(
        1020,
        DW_TAG_subprogram,
        [
          [DW_AT_name, str('host')],
          [DW_AT_low_pc, uint(0x10)],
          [DW_AT_high_pc, uint(0x10)],
        ],
        [rangeless, tombstoned],
      );
      const cu = die(1000, DW_TAG_compile_unit, [], [fn]);
      assert.deepStrictEqual(new ScopeIndex(debugInfoOf(cu)).inlineScopesAt(0x14), []);
    });

    it('resolves the name through abstract_origin, specification, and linkage_name', () => {
      // rustc points an instance at an abstract subprogram that carries only a
      // DW_AT_specification, whose declaration holds the name. Nothing else does.
      const declaration = die(1140, DW_TAG_subprogram, [[DW_AT_name, str('wrapping_add')]]);
      const abstract = die(1130, DW_TAG_subprogram, [[DW_AT_specification, ref(1140)]]);
      const mangledOnly = die(1150, DW_TAG_subprogram, [
        [DW_AT_linkage_name, str('_ZN4core3fmt5writeE')],
      ]);
      const instance = die(1160, DW_TAG_inlined_subroutine, [
        [DW_AT_abstract_origin, ref(1130)],
        [DW_AT_low_pc, uint(0x10)],
        [DW_AT_high_pc, uint(0x8)],
      ]);
      const mangledInstance = die(1170, DW_TAG_inlined_subroutine, [
        [DW_AT_abstract_origin, ref(1150)],
        [DW_AT_low_pc, uint(0x18)],
        [DW_AT_high_pc, uint(0x8)],
      ]);
      const nameless = die(1180, DW_TAG_inlined_subroutine, [
        [DW_AT_low_pc, uint(0x20)],
        [DW_AT_high_pc, uint(0x8)],
      ]);
      const fn = die(
        1120,
        DW_TAG_subprogram,
        [
          [DW_AT_name, str('host')],
          [DW_AT_low_pc, uint(0x10)],
          [DW_AT_high_pc, uint(0x20)],
        ],
        [instance, mangledInstance, nameless],
      );
      const cu = die(1100, DW_TAG_compile_unit, [], [fn, declaration, abstract, mangledOnly]);
      const index = new ScopeIndex(debugInfoOf(cu));

      assert.strictEqual(index.inlineScopesAt(0x12)[0].name, 'wrapping_add');
      assert.strictEqual(index.inlineScopesAt(0x1a)[0].name, '_ZN4core3fmt5writeE');
      assert.strictEqual(index.inlineScopesAt(0x22)[0].name, undefined);
    });
  });
});
