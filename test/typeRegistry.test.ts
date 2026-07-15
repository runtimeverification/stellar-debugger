import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import { TypeRegistry, DwarfType } from '../src/dwarf/TypeRegistry';
import { parseDebugInfo, Die, dieRef } from '../src/dwarf/die';
import { AttrValue } from '../src/dwarf/forms';
import { parseWasmSections } from '../src/wasm/sections';
import {
  DW_TAG_base_type,
  DW_TAG_pointer_type,
  DW_TAG_structure_type,
  DW_TAG_union_type,
  DW_TAG_array_type,
  DW_TAG_enumeration_type,
  DW_TAG_typedef,
  DW_TAG_const_type,
  DW_TAG_volatile_type,
  DW_TAG_member,
  DW_TAG_subrange_type,
  DW_TAG_enumerator,
  DW_TAG_variant_part,
  DW_TAG_variant,
  DW_TAG_subprogram,
  DW_TAG_formal_parameter,
  DW_AT_name,
  DW_AT_encoding,
  DW_AT_byte_size,
  DW_AT_type,
  DW_AT_data_member_location,
  DW_AT_count,
  DW_AT_upper_bound,
  DW_AT_const_value,
  DW_AT_discr,
  DW_AT_discr_value,
  DW_ATE_unsigned,
  DW_ATE_signed,
  DW_OP_plus_uconst,
  DW_OP_fbreg,
} from '../src/dwarf/constants';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const ADDER_WASM = path.join(FIXTURES, 'adder-debug.wasm');

// --- Tiny constructors for hand-built in-memory DIEs and their attributes. ---
// M3 tests need no byte encoding: we build `Die` literals directly (the shape
// M2's parseDebugInfo produces) and a `dieByOffset` map keyed by secOffset, then
// assert TypeRegistry.resolve output.

const uint = (value: number): AttrValue => ({ kind: 'uint', value });
const int = (value: number): AttrValue => ({ kind: 'int', value });
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

/** Build a dieByOffset map spanning every DIE (and descendant) passed in. */
function mapOf(...roots: Die[]): Map<number, Die> {
  const m = new Map<number, Die>();
  for (const r of roots) {
    collect(r, m);
  }
  return m;
}

/**
 * Narrows a DwarfType to a specific kind, failing the test otherwise, and
 * returns it at the narrowed type so field accesses type-check.
 */
function expectKind<K extends DwarfType['kind']>(t: DwarfType, kind: K): Extract<DwarfType, { kind: K }> {
  assert.strictEqual(t.kind, kind);
  return t as Extract<DwarfType, { kind: K }>;
}

describe('dwarf/TypeRegistry', () => {
  // 1. base_type -----------------------------------------------------------
  describe('base type', () => {
    it('decodes name, encoding, and byteSize (a u32)', () => {
      const u32 = die(100, DW_TAG_base_type, [
        [DW_AT_name, str('u32')],
        [DW_AT_encoding, uint(DW_ATE_unsigned)],
        [DW_AT_byte_size, uint(4)],
      ]);
      const reg = new TypeRegistry(mapOf(u32));
      const t = expectKind(reg.resolve(100), 'base');
      assert.strictEqual(t.name, 'u32');
      assert.strictEqual(t.encoding, DW_ATE_unsigned);
      assert.strictEqual(t.byteSize, 4);
    });

    it('memoizes: resolving the same offset twice returns the identical object', () => {
      const u32 = die(100, DW_TAG_base_type, [
        [DW_AT_name, str('u32')],
        [DW_AT_byte_size, uint(4)],
      ]);
      const reg = new TypeRegistry(mapOf(u32));
      assert.strictEqual(reg.resolve(100), reg.resolve(100));
    });
  });

  // 2. pointer_type --------------------------------------------------------
  describe('pointer type', () => {
    it('carries the target ref and byteSize', () => {
      const target = die(200, DW_TAG_base_type, [[DW_AT_name, str('u8')], [DW_AT_byte_size, uint(1)]]);
      const ptr = die(210, DW_TAG_pointer_type, [
        [DW_AT_type, ref(200)],
        [DW_AT_byte_size, uint(4)],
      ]);
      const reg = new TypeRegistry(mapOf(target, ptr));
      const t = expectKind(reg.resolve(210), 'pointer');
      assert.strictEqual(t.targetRef, 200);
      assert.strictEqual(t.byteSize, 4);
    });

    it('a void pointer (no DW_AT_type) has undefined targetRef and defaults byteSize to 4', () => {
      const voidPtr = die(220, DW_TAG_pointer_type, []);
      const reg = new TypeRegistry(mapOf(voidPtr));
      const t = expectKind(reg.resolve(220), 'pointer');
      assert.strictEqual(t.targetRef, undefined);
      assert.strictEqual(t.byteSize, 4);
    });
  });

  // 3. structure_type + memberOffset forms ---------------------------------
  describe('struct type', () => {
    it('decodes members with offsets from both a constant and a DW_OP_plus_uconst exprloc', () => {
      const u32 = die(300, DW_TAG_base_type, [[DW_AT_name, str('u32')], [DW_AT_byte_size, uint(4)]]);
      // member "x": offset via a plain constant DW_AT_data_member_location.
      const mx = die(320, DW_TAG_member, [
        [DW_AT_name, str('x')],
        [DW_AT_type, ref(300)],
        [DW_AT_data_member_location, uint(0)],
      ]);
      // member "y": offset via an exprloc { DW_OP_plus_uconst, ULEB 8 }.
      const my = die(330, DW_TAG_member, [
        [DW_AT_name, str('y')],
        [DW_AT_type, ref(300)],
        [DW_AT_data_member_location, block(DW_OP_plus_uconst, 8)],
      ]);
      const s = die(
        310,
        DW_TAG_structure_type,
        [[DW_AT_name, str('Point')], [DW_AT_byte_size, uint(12)]],
        [mx, my],
      );
      const reg = new TypeRegistry(mapOf(u32, s));
      const t = expectKind(reg.resolve(310), 'struct');
      assert.strictEqual(t.name, 'Point');
      assert.strictEqual(t.byteSize, 12);
      assert.strictEqual(t.members.length, 2);
      assert.deepStrictEqual(t.members[0], { name: 'x', typeRef: 300, offset: 0 });
      assert.deepStrictEqual(t.members[1], { name: 'y', typeRef: 300, offset: 8 });
    });

    it('member offset is 0 for a non-plus_uconst exprloc and for an absent location', () => {
      const mExpr = die(420, DW_TAG_member, [
        [DW_AT_name, str('a')],
        // DW_OP_fbreg 0 is not a single DW_OP_plus_uconst -> offset falls back to 0.
        [DW_AT_data_member_location, block(DW_OP_fbreg, 0)],
      ]);
      const mNone = die(430, DW_TAG_member, [[DW_AT_name, str('b')]]);
      const s = die(410, DW_TAG_structure_type, [[DW_AT_byte_size, uint(8)]], [mExpr, mNone]);
      const reg = new TypeRegistry(mapOf(s));
      const t = expectKind(reg.resolve(410), 'struct');
      assert.strictEqual(t.members[0].offset, 0);
      assert.strictEqual(t.members[1].offset, 0);
    });

    it('decodes a union_type with the same member shape', () => {
      const m = die(520, DW_TAG_member, [[DW_AT_name, str('u')], [DW_AT_data_member_location, uint(0)]]);
      const u = die(510, DW_TAG_union_type, [[DW_AT_name, str('U')], [DW_AT_byte_size, uint(4)]], [m]);
      const reg = new TypeRegistry(mapOf(u));
      const t = expectKind(reg.resolve(510), 'union');
      assert.strictEqual(t.name, 'U');
      assert.strictEqual(t.byteSize, 4);
      assert.strictEqual(t.members.length, 1);
      assert.strictEqual(t.members[0].name, 'u');
      assert.strictEqual(t.members[0].offset, 0);
    });
  });

  // 4. array_type ----------------------------------------------------------
  describe('array type', () => {
    it('takes count directly from DW_AT_count on the subrange child', () => {
      const elem = die(600, DW_TAG_base_type, [[DW_AT_name, str('u8')], [DW_AT_byte_size, uint(1)]]);
      const sub = die(620, DW_TAG_subrange_type, [[DW_AT_count, uint(3)]]);
      const arr = die(610, DW_TAG_array_type, [[DW_AT_type, ref(600)]], [sub]);
      const reg = new TypeRegistry(mapOf(elem, arr));
      const t = expectKind(reg.resolve(610), 'array');
      assert.strictEqual(t.elementRef, 600);
      assert.strictEqual(t.count, 3);
    });

    it('derives count from DW_AT_upper_bound + 1 when DW_AT_count is absent', () => {
      const sub = die(720, DW_TAG_subrange_type, [[DW_AT_upper_bound, uint(4)]]);
      const arr = die(710, DW_TAG_array_type, [[DW_AT_type, ref(600)]], [sub]);
      const reg = new TypeRegistry(mapOf(arr));
      const t = expectKind(reg.resolve(710), 'array');
      assert.strictEqual(t.elementRef, 600);
      assert.strictEqual(t.count, 5);
    });

    it('count is undefined when the subrange bounds it neither way', () => {
      const sub = die(820, DW_TAG_subrange_type, []);
      const arr = die(810, DW_TAG_array_type, [[DW_AT_type, ref(600)]], [sub]);
      const reg = new TypeRegistry(mapOf(arr));
      const t = expectKind(reg.resolve(810), 'array');
      assert.strictEqual(t.count, undefined);
    });
  });

  // 5. enumeration_type ----------------------------------------------------
  describe('enum type', () => {
    it('decodes enumerators with their const values, name, byteSize, and underlying ref', () => {
      const underlying = die(900, DW_TAG_base_type, [[DW_AT_name, str('u8')], [DW_AT_byte_size, uint(1)]]);
      const e0 = die(920, DW_TAG_enumerator, [[DW_AT_name, str('Red')], [DW_AT_const_value, uint(0)]]);
      const e1 = die(930, DW_TAG_enumerator, [[DW_AT_name, str('Green')], [DW_AT_const_value, uint(7)]]);
      const en = die(
        910,
        DW_TAG_enumeration_type,
        [[DW_AT_name, str('Color')], [DW_AT_byte_size, uint(1)], [DW_AT_type, ref(900)]],
        [e0, e1],
      );
      const reg = new TypeRegistry(mapOf(underlying, en));
      const t = expectKind(reg.resolve(910), 'enum');
      assert.strictEqual(t.name, 'Color');
      assert.strictEqual(t.byteSize, 1);
      assert.strictEqual(t.underlyingRef, 900);
      assert.deepStrictEqual(t.enumerators, [
        { name: 'Red', value: 0 },
        { name: 'Green', value: 7 },
      ]);
    });
  });

  // 6. typedef + const qualifier, and stripTypedefs ------------------------
  describe('typedef and qualifier', () => {
    it('resolves a typedef and a const qualifier to their target refs', () => {
      const base = die(1000, DW_TAG_base_type, [[DW_AT_name, str('int')], [DW_AT_byte_size, uint(4)]]);
      const constT = die(1010, DW_TAG_const_type, [[DW_AT_type, ref(1000)]]);
      const td = die(1020, DW_TAG_typedef, [[DW_AT_name, str('MyInt')], [DW_AT_type, ref(1010)]]);
      const reg = new TypeRegistry(mapOf(base, constT, td));

      const tdT = expectKind(reg.resolve(1020), 'typedef');
      assert.strictEqual(tdT.name, 'MyInt');
      assert.strictEqual(tdT.targetRef, 1010);

      const q = expectKind(reg.resolve(1010), 'qualifier');
      assert.strictEqual(q.targetRef, 1000);
    });

    it('stripTypedefs peels a typedef -> const -> base chain down to the base', () => {
      const base = die(1000, DW_TAG_base_type, [[DW_AT_name, str('int')], [DW_AT_byte_size, uint(4)]]);
      const constT = die(1010, DW_TAG_const_type, [[DW_AT_type, ref(1000)]]);
      const td = die(1020, DW_TAG_typedef, [[DW_AT_name, str('MyInt')], [DW_AT_type, ref(1010)]]);
      const reg = new TypeRegistry(mapOf(base, constT, td));

      const stripped = expectKind(reg.stripTypedefs(reg.resolve(1020)), 'base');
      assert.strictEqual(stripped.name, 'int');
      assert.strictEqual(stripped.byteSize, 4);
    });

    it('stripTypedefs peels a volatile qualifier too, and leaves a non-wrapper type untouched', () => {
      const base = die(1100, DW_TAG_base_type, [[DW_AT_name, str('long')], [DW_AT_byte_size, uint(8)]]);
      const vol = die(1110, DW_TAG_volatile_type, [[DW_AT_type, ref(1100)]]);
      const reg = new TypeRegistry(mapOf(base, vol));

      assert.strictEqual(expectKind(reg.stripTypedefs(reg.resolve(1110)), 'base').name, 'long');
      // Already a base type -> returned as-is.
      const b = reg.resolve(1100);
      assert.strictEqual(reg.stripTypedefs(b), b);
    });

    it('stripTypedefs stops when a wrapper has no target ref', () => {
      // A typedef with no DW_AT_type: targetRef undefined -> left as typedef.
      const td = die(1200, DW_TAG_typedef, [[DW_AT_name, str('Opaque')]]);
      const reg = new TypeRegistry(mapOf(td));
      const stripped = reg.stripTypedefs(reg.resolve(1200));
      assert.strictEqual(stripped.kind, 'typedef');
    });
  });

  // 7. rustEnum (structure_type with a variant_part) -----------------------
  describe('rustEnum type', () => {
    // structure_type "MyEnum" (byte_size 8)
    //   variant_part  (DW_AT_discr -> member D)
    //     member D "discr" (offset 0, type -> 1300)          <- the discriminant
    //     variant V0 (discr_value 0)
    //       member "A" (offset 4, type -> 1300)
    //     variant V1 (default: no discr_value)
    //       member "B" (offset 4, type -> 1310)
    function build(): TypeRegistry {
      const u32 = die(1300, DW_TAG_base_type, [[DW_AT_name, str('u32')], [DW_AT_byte_size, uint(4)]]);
      const u64 = die(1310, DW_TAG_base_type, [[DW_AT_name, str('u64')], [DW_AT_byte_size, uint(8)]]);

      const discrMember = die(1420, DW_TAG_member, [
        [DW_AT_name, str('discr')],
        [DW_AT_type, ref(1300)],
        [DW_AT_data_member_location, uint(0)],
      ]);
      const payloadA = die(1440, DW_TAG_member, [
        [DW_AT_name, str('A')],
        [DW_AT_type, ref(1300)],
        [DW_AT_data_member_location, uint(4)],
      ]);
      const variant0 = die(1430, DW_TAG_variant, [[DW_AT_discr_value, uint(0)]], [payloadA]);
      const payloadB = die(1460, DW_TAG_member, [
        [DW_AT_name, str('B')],
        [DW_AT_type, ref(1310)],
        [DW_AT_data_member_location, uint(4)],
      ]);
      const variant1 = die(1450, DW_TAG_variant, [], [payloadB]); // default: no discr_value
      const vp = die(1410, DW_TAG_variant_part, [[DW_AT_discr, ref(1420)]], [
        discrMember,
        variant0,
        variant1,
      ]);
      const enumStruct = die(
        1400,
        DW_TAG_structure_type,
        [[DW_AT_name, str('MyEnum')], [DW_AT_byte_size, uint(8)]],
        [vp],
      );
      return new TypeRegistry(mapOf(u32, u64, enumStruct));
    }

    it('is decoded as a rustEnum with name and byteSize from the enclosing struct', () => {
      const t = expectKind(build().resolve(1400), 'rustEnum');
      assert.strictEqual(t.name, 'MyEnum');
      assert.strictEqual(t.byteSize, 8);
    });

    it('resolves the discriminant member offset and type ref via DW_AT_discr', () => {
      const t = expectKind(build().resolve(1400), 'rustEnum');
      assert.ok(t.discr, 'expected a discr descriptor');
      assert.strictEqual(t.discr!.offset, 0);
      assert.strictEqual(t.discr!.typeRef, 1300);
    });

    it('decodes both variants: an explicit discr_value and a default (undefined)', () => {
      const t = expectKind(build().resolve(1400), 'rustEnum');
      assert.strictEqual(t.variants.length, 2);

      assert.strictEqual(t.variants[0].discrValue, 0);
      assert.deepStrictEqual(t.variants[0].member, { name: 'A', typeRef: 1300, offset: 4 });

      assert.strictEqual(t.variants[1].discrValue, undefined);
      assert.deepStrictEqual(t.variants[1].member, { name: 'B', typeRef: 1310, offset: 4 });
    });
  });

  // 8. cycles / missing ----------------------------------------------------
  describe('cycles and missing references', () => {
    it('resolves a struct whose member points back at the struct without looping', () => {
      // member "self" typeRef points at the struct's own offset (1500).
      const selfMember = die(1520, DW_TAG_member, [
        [DW_AT_name, str('self')],
        [DW_AT_type, ref(1500)],
        [DW_AT_data_member_location, uint(0)],
      ]);
      const s = die(1500, DW_TAG_structure_type, [[DW_AT_name, str('Node')], [DW_AT_byte_size, uint(4)]], [
        selfMember,
      ]);
      const reg = new TypeRegistry(mapOf(s));
      const t = expectKind(reg.resolve(1500), 'struct');
      // resolve stores only the ref (one level), so no infinite recursion.
      assert.strictEqual(t.members.length, 1);
      assert.strictEqual(t.members[0].typeRef, 1500);
      // And re-resolving the same offset is still safe/consistent.
      assert.strictEqual(expectKind(reg.resolve(t.members[0].typeRef!), 'struct').name, 'Node');
    });

    it('resolve(undefined) yields an unresolved type', () => {
      const reg = new TypeRegistry(mapOf());
      assert.strictEqual(reg.resolve(undefined).kind, 'unresolved');
    });

    it('resolve of a missing offset yields an unresolved type', () => {
      const reg = new TypeRegistry(mapOf(die(1600, DW_TAG_base_type, [[DW_AT_name, str('int')]])));
      assert.strictEqual(reg.resolve(999999).kind, 'unresolved');
    });

    it('an unhandled tag resolves to unresolved carrying that tag', () => {
      const sp = die(1700, DW_TAG_subprogram, [[DW_AT_name, str('main')]]);
      const reg = new TypeRegistry(mapOf(sp));
      const t = expectKind(reg.resolve(1700), 'unresolved');
      assert.strictEqual(t.tag, DW_TAG_subprogram);
    });
  });

  // 9. Real fixture anchor -------------------------------------------------
  describe('adder-debug.wasm fixture', () => {
    it('resolves a formal_parameter DW_AT_type to a named base type (via stripTypedefs)', async () => {
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
      const reg = new TypeRegistry(debug.dieByOffset);

      // Collect every DIE in the tree, then the typed formal parameters.
      const all: Die[] = [];
      const walk = (d: Die): void => {
        all.push(d);
        d.children.forEach(walk);
      };
      debug.units.forEach((cu) => walk(cu.die));

      const typedParams = all.filter(
        (d) => d.tag === DW_TAG_formal_parameter && dieRef(d, DW_AT_type) !== undefined,
      );
      assert.ok(typedParams.length > 0, 'fixture must have a formal_parameter with a DW_AT_type');

      // At least one parameter's type must land (after peeling typedefs/qualifiers)
      // on a base type with a non-empty name (the adder args are integer types).
      const baseHit = typedParams.some((p) => {
        const resolved = reg.stripTypedefs(reg.resolve(dieRef(p, DW_AT_type)));
        return resolved.kind === 'base' && typeof resolved.name === 'string' && resolved.name.length > 0;
      });
      assert.ok(baseHit, 'expected a formal_parameter typed as a named base type');
    });

    it('every resolvable base type in the fixture reports a positive byteSize', async () => {
      const bytes = await fs.readFile(ADDER_WASM);
      const parsed = parseWasmSections(bytes);
      const debug = parseDebugInfo({
        info: parsed.customSection('.debug_info')!,
        abbrev: parsed.customSection('.debug_abbrev')!,
        str: parsed.customSection('.debug_str'),
        lineStr: parsed.customSection('.debug_line_str'),
      });
      const reg = new TypeRegistry(debug.dieByOffset);

      let sawBase = false;
      for (const off of debug.dieByOffset.keys()) {
        const t = reg.resolve(off);
        if (t.kind === 'base') {
          sawBase = true;
          if (t.byteSize !== undefined) {
            assert.ok(t.byteSize > 0, `base type at ${off} had non-positive byteSize ${t.byteSize}`);
          }
        }
      }
      assert.ok(sawBase, 'fixture must contain at least one base type');
    });
  });

  // Reference the signed encoding + int constructor so their imports stay used
  // and to document that signed base types decode identically to unsigned ones.
  describe('signed base type', () => {
    it('decodes a signed base type (i32) with encoding DW_ATE_signed', () => {
      const i32 = die(1800, DW_TAG_base_type, [
        [DW_AT_name, str('i32')],
        [DW_AT_encoding, int(DW_ATE_signed)],
        [DW_AT_byte_size, uint(4)],
      ]);
      const reg = new TypeRegistry(mapOf(i32));
      const t = expectKind(reg.resolve(1800), 'base');
      assert.strictEqual(t.name, 'i32');
      assert.strictEqual(t.encoding, DW_ATE_signed);
      assert.strictEqual(t.byteSize, 4);
    });
  });
});
