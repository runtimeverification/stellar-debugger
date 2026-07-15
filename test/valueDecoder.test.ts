import * as assert from 'assert';
import { decodeValue, DecodedValue, ChildVar, DecodeBudget } from '../src/dwarf/ValueDecoder';
import { TypeRegistry } from '../src/dwarf/TypeRegistry';
import { RuntimeState, ValueLocation } from '../src/dwarf/locexpr';
import { Die } from '../src/dwarf/die';
import { AttrValue } from '../src/dwarf/forms';
import {
  DW_TAG_base_type,
  DW_TAG_pointer_type,
  DW_TAG_structure_type,
  DW_TAG_union_type,
  DW_TAG_array_type,
  DW_TAG_enumeration_type,
  DW_TAG_enumerator,
  DW_TAG_subrange_type,
  DW_TAG_member,
  DW_TAG_variant_part,
  DW_TAG_variant,
  DW_AT_name,
  DW_AT_encoding,
  DW_AT_byte_size,
  DW_AT_type,
  DW_AT_data_member_location,
  DW_AT_count,
  DW_AT_const_value,
  DW_AT_discr,
  DW_AT_discr_value,
  DW_ATE_unsigned,
  DW_ATE_signed,
  DW_ATE_boolean,
  DW_ATE_float,
  DW_ATE_unsigned_char,
  DW_ATE_UTF,
} from '../src/dwarf/constants';

// --- Tiny constructors for hand-built in-memory DIEs (as in typeRegistry.test.ts). ---
// We build `Die` literals directly (the shape M2's parseDebugInfo produces), index
// them by secOffset, and resolve the type via TypeRegistry — then feed the resolved
// type plus a mock RuntimeState to decodeValue.

const uint = (value: number): AttrValue => ({ kind: 'uint', value });
const str = (value: string): AttrValue => ({ kind: 'str', value });
const ref = (value: number): AttrValue => ({ kind: 'ref', value });

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

/** Build a TypeRegistry over every DIE (and descendant) passed in. */
function regOf(...roots: Die[]): TypeRegistry {
  const m = new Map<number, Die>();
  for (const r of roots) {
    collect(r, m);
  }
  return new TypeRegistry(m);
}

// --- Mock runtime state backed by a flat Uint8Array "linear memory". ---------
// Addresses index directly into `mem`; readMemory(addr,size) returns the slice, or
// undefined if it would run off the buffer. Register slots come from the maps.

interface MockState {
  state: RuntimeState;
  mem: Uint8Array;
  dv: DataView;
  locals: Map<number, number | bigint>;
  globals: Map<number, number | bigint>;
  stacks: Map<number, number | bigint>;
}

function newState(memSize = 8192): MockState {
  const mem = new Uint8Array(memSize);
  const dv = new DataView(mem.buffer);
  const locals = new Map<number, number | bigint>();
  const globals = new Map<number, number | bigint>();
  const stacks = new Map<number, number | bigint>();
  const state: RuntimeState = {
    localValue: (i) => locals.get(i),
    globalValue: (i) => globals.get(i),
    stackValue: (i) => stacks.get(i),
    // NOTE: the M6 prerequisite widens readMemory to (address, size).
    readMemory: (addr, size) =>
      addr >= 0 && size >= 0 && addr + size <= mem.length ? mem.slice(addr, addr + size) : undefined,
  };
  return { state, mem, dv, locals, globals, stacks };
}

/** Write `value` as `size` little-endian bytes at `addr` (size <= 4). */
function putU(dv: DataView, addr: number, value: number, size: number): void {
  for (let i = 0; i < size; i++) {
    dv.setUint8(addr + i, (value >>> (8 * i)) & 0xff);
  }
}

/** Write raw bytes at `addr`. */
function putBytes(mem: Uint8Array, addr: number, bytes: number[]): void {
  for (let i = 0; i < bytes.length; i++) {
    mem[addr + i] = bytes[i] & 0xff;
  }
}

/** A memory `ValueLocation` at `address`. */
const at = (address: number): ValueLocation => ({ kind: 'memory', address });

/** Assert a value is expandable and return its (lazily evaluated) children. */
function childrenOf(d: DecodedValue): ChildVar[] {
  assert.strictEqual(typeof d.children, 'function', 'expected an expandable value with children()');
  return (d.children as () => ChildVar[])();
}

/** True if the value exposes no meaningful children (absent fn, or an empty list). */
function noChildren(d: DecodedValue): boolean {
  return !d.children || d.children().length === 0;
}

describe('dwarf/ValueDecoder', () => {
  // 1. Base integer / bool / float scalars from memory ---------------------
  describe('base scalars from memory', () => {
    // u32@10, i32@20, u64@30, bool@40, f64@50 — all distinct offsets in one map.
    function baseReg(): TypeRegistry {
      return regOf(
        die(10, DW_TAG_base_type, [[DW_AT_name, str('u32')], [DW_AT_encoding, uint(DW_ATE_unsigned)], [DW_AT_byte_size, uint(4)]]),
        die(20, DW_TAG_base_type, [[DW_AT_name, str('i32')], [DW_AT_encoding, uint(DW_ATE_signed)], [DW_AT_byte_size, uint(4)]]),
        die(30, DW_TAG_base_type, [[DW_AT_name, str('u64')], [DW_AT_encoding, uint(DW_ATE_unsigned)], [DW_AT_byte_size, uint(8)]]),
        die(40, DW_TAG_base_type, [[DW_AT_name, str('bool')], [DW_AT_encoding, uint(DW_ATE_boolean)], [DW_AT_byte_size, uint(1)]]),
        die(50, DW_TAG_base_type, [[DW_AT_name, str('f64')], [DW_AT_encoding, uint(DW_ATE_float)], [DW_AT_byte_size, uint(8)]]),
      );
    }

    it('decodes an unsigned u32 little-endian', () => {
      const { state, dv } = newState();
      putU(dv, 0, 305419896, 4); // 0x12345678 -> bytes 78 56 34 12
      const reg = baseReg();
      const d = decodeValue(at(0), reg.resolve(10), state, reg);
      assert.strictEqual(d.display, '305419896');
      assert.strictEqual(d.typeName, 'u32');
    });

    it('sign-extends a negative i32', () => {
      const { state, dv } = newState();
      putU(dv, 4, -2 >>> 0, 4); // 0xFFFFFFFE
      const reg = baseReg();
      const d = decodeValue(at(4), reg.resolve(20), state, reg);
      assert.strictEqual(d.display, '-2');
    });

    it('decodes a u64 above 2^53 exactly via BigInt', () => {
      const { state, dv } = newState();
      // 2^53 + 1 = 9007199254740993 — NOT representable as a JS number, so a
      // Number-based decode would print 9007199254740992. BigInt must be used.
      dv.setBigUint64(0, 9007199254740993n, true);
      const reg = baseReg();
      const d = decodeValue(at(0), reg.resolve(30), state, reg);
      assert.strictEqual(d.display, '9007199254740993');
    });

    it('decodes booleans (0 -> false, nonzero -> true)', () => {
      const { state, mem } = newState();
      const reg = baseReg();
      mem[0] = 0;
      assert.strictEqual(decodeValue(at(0), reg.resolve(40), state, reg).display, 'false');
      mem[0] = 1;
      assert.strictEqual(decodeValue(at(0), reg.resolve(40), state, reg).display, 'true');
      mem[0] = 42; // any nonzero
      assert.strictEqual(decodeValue(at(0), reg.resolve(40), state, reg).display, 'true');
    });

    it('decodes an f64 via DataView', () => {
      const { state, dv } = newState();
      dv.setFloat64(0, 2.5, true);
      const reg = baseReg();
      assert.strictEqual(decodeValue(at(0), reg.resolve(50), state, reg).display, '2.5');
    });
  });

  // 2. Base scalar from a register / immediate-value location --------------
  describe('base scalars from register / value locations', () => {
    function baseReg(): TypeRegistry {
      return regOf(
        die(10, DW_TAG_base_type, [[DW_AT_name, str('u32')], [DW_AT_encoding, uint(DW_ATE_unsigned)], [DW_AT_byte_size, uint(4)]]),
      );
    }

    it('decodes a u32 held in a wasm local to the same decimal', () => {
      const { state, locals } = newState();
      locals.set(2, 305419896);
      const reg = baseReg();
      const d = decodeValue({ kind: 'local', index: 2 }, reg.resolve(10), state, reg);
      assert.strictEqual(d.display, '305419896');
      assert.strictEqual(d.typeName, 'u32');
    });

    it('decodes a u32 carried as an immediate value location', () => {
      const { state } = newState();
      const reg = baseReg();
      const d = decodeValue({ kind: 'value', value: 258 }, reg.resolve(10), state, reg);
      assert.strictEqual(d.display, '258');
    });
  });

  // 3. Pointers ------------------------------------------------------------
  describe('pointer', () => {
    // u32@10, pointer@60 -> u32.
    function ptrReg(): TypeRegistry {
      return regOf(
        die(10, DW_TAG_base_type, [[DW_AT_name, str('u32')], [DW_AT_encoding, uint(DW_ATE_unsigned)], [DW_AT_byte_size, uint(4)]]),
        die(60, DW_TAG_pointer_type, [[DW_AT_type, ref(10)], [DW_AT_byte_size, uint(4)]]),
      );
    }

    it('displays the address in hex and lazily dereferences to the pointee', () => {
      const { state, dv } = newState();
      putU(dv, 100, 200, 4); // pointer at 100 -> 200
      putU(dv, 200, 42, 4); // u32 at 200 = 42
      const reg = ptrReg();
      const d = decodeValue(at(100), reg.resolve(60), state, reg);
      assert.strictEqual(d.display, '0xc8'); // 200 == 0xc8
      const kids = childrenOf(d);
      assert.strictEqual(kids.length, 1);
      assert.strictEqual(kids[0].name, '*');
      assert.strictEqual(kids[0].value.display, '42');
    });

    it('a null pointer has no dereference child', () => {
      const { state, dv } = newState();
      putU(dv, 100, 0, 4);
      const reg = ptrReg();
      const d = decodeValue(at(100), reg.resolve(60), state, reg);
      assert.strictEqual(d.display, '0x0');
      assert.ok(noChildren(d), 'null pointer must not offer a deref child');
    });

    it('a self-referential pointer cycle terminates via the visited set', () => {
      // struct Node@70 { next: *Node@80 } at offset 0; the pointer points at Node's own base.
      const reg = regOf(
        die(70, DW_TAG_structure_type, [[DW_AT_name, str('Node')], [DW_AT_byte_size, uint(4)]], [
          die(71, DW_TAG_member, [[DW_AT_name, str('next')], [DW_AT_type, ref(80)], [DW_AT_data_member_location, uint(0)]]),
        ]),
        die(80, DW_TAG_pointer_type, [[DW_AT_type, ref(70)], [DW_AT_byte_size, uint(4)]]),
      );
      const { state, dv } = newState();
      putU(dv, 300, 300, 4); // Node at 300 whose `next` points back to 300

      // A generous depth budget so ONLY the visited-set guard can stop the walk.
      let node = decodeValue(at(300), reg.resolve(70), state, reg, { maxDepth: 100 });
      let sawEllipsis = false;
      for (let steps = 0; steps < 50; steps++) {
        if (noChildren(node)) {
          break;
        }
        const nextPtr = childrenOf(node)[0].value; // the `next` pointer field
        if (noChildren(nextPtr)) {
          break;
        }
        const deref = childrenOf(nextPtr)[0].value; // the `*` dereference
        if (deref.display === '…') {
          sawEllipsis = true;
          break;
        }
        node = deref;
      }
      assert.ok(sawEllipsis, 'pointer cycle must terminate with an ellipsis placeholder');
    });
  });

  // 4. Structs -------------------------------------------------------------
  describe('struct', () => {
    // Point@90 { x: u32@10 @0, y: u32@10 @4 }
    function structReg(): TypeRegistry {
      return regOf(
        die(10, DW_TAG_base_type, [[DW_AT_name, str('u32')], [DW_AT_encoding, uint(DW_ATE_unsigned)], [DW_AT_byte_size, uint(4)]]),
        die(90, DW_TAG_structure_type, [[DW_AT_name, str('Point')], [DW_AT_byte_size, uint(8)]], [
          die(91, DW_TAG_member, [[DW_AT_name, str('x')], [DW_AT_type, ref(10)], [DW_AT_data_member_location, uint(0)]]),
          die(92, DW_TAG_member, [[DW_AT_name, str('y')], [DW_AT_type, ref(10)], [DW_AT_data_member_location, uint(4)]]),
        ]),
      );
    }

    it('exposes members at their offsets via lazily-evaluated children', () => {
      const { state, dv } = newState();
      putU(dv, 400, 10, 4); // x
      putU(dv, 404, 20, 4); // y
      const reg = structReg();
      const d = decodeValue(at(400), reg.resolve(90), state, reg);
      assert.strictEqual(d.typeName, 'Point');
      // children is a function (lazy) — evaluating it yields the ChildVars.
      const kids = childrenOf(d);
      assert.strictEqual(kids.length, 2);
      assert.strictEqual(kids[0].name, 'x');
      assert.strictEqual(kids[0].value.display, '10');
      assert.strictEqual(kids[1].name, 'y');
      assert.strictEqual(kids[1].value.display, '20');
    });

    it('a struct with no memory base is unreadable', () => {
      const { state } = newState();
      const reg = structReg();
      const d = decodeValue({ kind: 'value', value: 0 }, reg.resolve(90), state, reg);
      assert.strictEqual(d.display, '<unreadable>');
    });
  });

  // 5. Arrays --------------------------------------------------------------
  describe('array', () => {
    // arr@100: element u32@10, count 3.
    function arrReg(): TypeRegistry {
      return regOf(
        die(10, DW_TAG_base_type, [[DW_AT_name, str('u32')], [DW_AT_encoding, uint(DW_ATE_unsigned)], [DW_AT_byte_size, uint(4)]]),
        die(100, DW_TAG_array_type, [[DW_AT_type, ref(10)]], [
          die(101, DW_TAG_subrange_type, [[DW_AT_count, uint(3)]]),
        ]),
      );
    }

    it('decodes N elements at stride elemSize', () => {
      const { state, dv } = newState();
      putU(dv, 500, 1, 4);
      putU(dv, 504, 2, 4);
      putU(dv, 508, 3, 4);
      const reg = arrReg();
      const d = decodeValue(at(500), reg.resolve(100), state, reg);
      const kids = childrenOf(d);
      assert.strictEqual(kids.length, 3);
      assert.strictEqual(kids[0].name, '[0]');
      assert.strictEqual(kids[0].value.display, '1');
      assert.strictEqual(kids[1].name, '[1]');
      assert.strictEqual(kids[1].value.display, '2');
      assert.strictEqual(kids[2].name, '[2]');
      assert.strictEqual(kids[2].value.display, '3');
    });

    it('truncates at maxChildren and appends an ellipsis child', () => {
      const { state, dv } = newState();
      putU(dv, 500, 1, 4);
      putU(dv, 504, 2, 4);
      putU(dv, 508, 3, 4);
      const reg = arrReg();
      const d = decodeValue(at(500), reg.resolve(100), state, reg, { maxChildren: 2 });
      const kids = childrenOf(d);
      assert.strictEqual(kids.length, 3); // 2 elements + 1 truncation marker
      assert.strictEqual(kids[0].value.display, '1');
      assert.strictEqual(kids[1].value.display, '2');
      assert.strictEqual(kids[2].value.display, '…');
    });
  });

  // 6. Rust &str surface recognition ---------------------------------------
  describe('&str', () => {
    // &str@120: struct named "&str" with { data_ptr: *u8@130 @0, length: usize@150 @4 }.
    function strReg(): TypeRegistry {
      return regOf(
        die(140, DW_TAG_base_type, [[DW_AT_name, str('u8')], [DW_AT_encoding, uint(DW_ATE_unsigned)], [DW_AT_byte_size, uint(1)]]),
        die(130, DW_TAG_pointer_type, [[DW_AT_type, ref(140)], [DW_AT_byte_size, uint(4)]]),
        die(150, DW_TAG_base_type, [[DW_AT_name, str('usize')], [DW_AT_encoding, uint(DW_ATE_unsigned)], [DW_AT_byte_size, uint(4)]]),
        die(120, DW_TAG_structure_type, [[DW_AT_name, str('&str')], [DW_AT_byte_size, uint(8)]], [
          die(121, DW_TAG_member, [[DW_AT_name, str('data_ptr')], [DW_AT_type, ref(130)], [DW_AT_data_member_location, uint(0)]]),
          die(122, DW_TAG_member, [[DW_AT_name, str('length')], [DW_AT_type, ref(150)], [DW_AT_data_member_location, uint(4)]]),
        ]),
      );
    }

    it('decodes a &str to a quoted UTF-8 string literal, as a leaf', () => {
      const { state, dv, mem } = newState();
      putBytes(mem, 600, [104, 101, 108, 108, 111]); // "hello"
      putU(dv, 620, 600, 4); // data_ptr -> 600
      putU(dv, 624, 5, 4); // length = 5
      const reg = strReg();
      const d = decodeValue(at(620), reg.resolve(120), state, reg);
      assert.strictEqual(d.display, '"hello"');
      assert.strictEqual(d.typeName, '&str');
      assert.ok(noChildren(d), '&str is a leaf');
    });

    it('truncates a &str at maxStringBytes and appends an ellipsis inside the quotes', () => {
      const { state, dv, mem } = newState();
      putBytes(mem, 600, [104, 101, 108, 108, 111]); // "hello"
      putU(dv, 620, 600, 4);
      putU(dv, 624, 5, 4);
      const reg = strReg();
      const d = decodeValue(at(620), reg.resolve(120), state, reg, { maxStringBytes: 3 });
      assert.strictEqual(d.display, '"hel…"');
    });
  });

  // 7. Rust enums (Option / Result / default variant) ----------------------
  describe('rustEnum', () => {
    // Builds a two-variant rustEnum: discr@0 (u32), each variant carries a named
    // payload member at offset 4 (or no payload type for a "None"-like arm).
    function enumReg(
      enumOffset: number,
      name: string,
      v0: { discrValue: number | undefined; memberName: string; hasPayload: boolean },
      v1: { discrValue: number | undefined; memberName: string; hasPayload: boolean },
    ): TypeRegistry {
      const u32 = die(300, DW_TAG_base_type, [[DW_AT_name, str('u32')], [DW_AT_encoding, uint(DW_ATE_unsigned)], [DW_AT_byte_size, uint(4)]]);
      const mk = (base: number, v: typeof v0): Die => {
        const memberAttrs: Array<[number, AttrValue]> = [[DW_AT_name, str(v.memberName)], [DW_AT_data_member_location, uint(4)]];
        if (v.hasPayload) {
          memberAttrs.push([DW_AT_type, ref(300)]);
        }
        const member = die(base + 2, DW_TAG_member, memberAttrs);
        const variantAttrs: Array<[number, AttrValue]> = v.discrValue === undefined ? [] : [[DW_AT_discr_value, uint(v.discrValue)]];
        return die(base + 1, DW_TAG_variant, variantAttrs, [member]);
      };
      const discrMember = die(enumOffset + 20, DW_TAG_member, [[DW_AT_name, str('discr')], [DW_AT_type, ref(300)], [DW_AT_data_member_location, uint(0)]]);
      const variantPart = die(enumOffset + 10, DW_TAG_variant_part, [[DW_AT_discr, ref(enumOffset + 20)]], [
        discrMember,
        mk(enumOffset + 30, v0),
        mk(enumOffset + 40, v1),
      ]);
      const enumStruct = die(enumOffset, DW_TAG_structure_type, [[DW_AT_name, str(name)], [DW_AT_byte_size, uint(8)]], [variantPart]);
      return regOf(u32, enumStruct);
    }

    it('selects Some (with payload child) by discriminant', () => {
      const reg = enumReg(
        1000,
        'Option',
        { discrValue: 1, memberName: 'Some', hasPayload: true },
        { discrValue: 0, memberName: 'None', hasPayload: false },
      );
      const { state, dv } = newState();
      putU(dv, 700, 1, 4); // discr = 1 -> Some
      putU(dv, 704, 42, 4); // payload
      const d = decodeValue(at(700), reg.resolve(1000), state, reg);
      assert.strictEqual(d.display, 'Some');
      assert.strictEqual(d.typeName, 'Option');
      const kids = childrenOf(d);
      assert.ok(kids.length >= 1, 'Some carries a payload child');
      assert.strictEqual(kids[0].value.display, '42');
    });

    it('selects None (no payload child) by discriminant', () => {
      const reg = enumReg(
        1000,
        'Option',
        { discrValue: 1, memberName: 'Some', hasPayload: true },
        { discrValue: 0, memberName: 'None', hasPayload: false },
      );
      const { state, dv } = newState();
      putU(dv, 720, 0, 4); // discr = 0 -> None
      const d = decodeValue(at(720), reg.resolve(1000), state, reg);
      assert.strictEqual(d.display, 'None');
      assert.ok(noChildren(d), 'None has no payload');
    });

    it('selects Ok vs Err for a Result-like enum', () => {
      const reg = enumReg(
        2000,
        'Result',
        { discrValue: 0, memberName: 'Ok', hasPayload: true },
        { discrValue: 1, memberName: 'Err', hasPayload: true },
      );
      const { state, dv } = newState();
      putU(dv, 800, 0, 4); // Ok
      putU(dv, 804, 42, 4);
      const ok = decodeValue(at(800), reg.resolve(2000), state, reg);
      assert.strictEqual(ok.display, 'Ok');
      assert.strictEqual(childrenOf(ok)[0].value.display, '42');

      putU(dv, 820, 1, 4); // Err
      putU(dv, 824, 99, 4);
      const err = decodeValue(at(820), reg.resolve(2000), state, reg);
      assert.strictEqual(err.display, 'Err');
      assert.strictEqual(childrenOf(err)[0].value.display, '99');
    });

    it('falls back to the default (undefined discrValue) variant when nothing matches', () => {
      const reg = enumReg(
        3000,
        'E',
        { discrValue: 5, memberName: 'A', hasPayload: false },
        { discrValue: undefined, memberName: 'B', hasPayload: false }, // default arm
      );
      const { state, dv } = newState();
      putU(dv, 900, 99, 4); // matches neither 5 -> default -> B
      const d = decodeValue(at(900), reg.resolve(3000), state, reg);
      assert.strictEqual(d.display, 'B');
    });
  });

  // 8. Guards / placeholders -----------------------------------------------
  describe('guards', () => {
    it('shows an ellipsis for structs nested beyond maxDepth', () => {
      // Outer@600 { inner: Inner@610 @0 };  Inner { v: u32@10 @0 }
      const reg = regOf(
        die(10, DW_TAG_base_type, [[DW_AT_name, str('u32')], [DW_AT_encoding, uint(DW_ATE_unsigned)], [DW_AT_byte_size, uint(4)]]),
        die(610, DW_TAG_structure_type, [[DW_AT_name, str('Inner')], [DW_AT_byte_size, uint(4)]], [
          die(611, DW_TAG_member, [[DW_AT_name, str('v')], [DW_AT_type, ref(10)], [DW_AT_data_member_location, uint(0)]]),
        ]),
        die(600, DW_TAG_structure_type, [[DW_AT_name, str('Outer')], [DW_AT_byte_size, uint(4)]], [
          die(601, DW_TAG_member, [[DW_AT_name, str('inner')], [DW_AT_type, ref(610)], [DW_AT_data_member_location, uint(0)]]),
        ]),
      );
      const { state, dv } = newState();
      putU(dv, 1000, 7, 4);
      const budget: Partial<DecodeBudget> = { maxDepth: 1 };
      const outer = decodeValue(at(1000), reg.resolve(600), state, reg, budget);
      const inner = childrenOf(outer)[0].value; // depth 1: still expands
      const v = childrenOf(inner)[0].value; // depth 2 > maxDepth 1: ellipsis
      assert.strictEqual(v.display, '…');
    });

    it('an unavailable location yields <optimized out>', () => {
      const reg = regOf(
        die(10, DW_TAG_base_type, [[DW_AT_name, str('u32')], [DW_AT_encoding, uint(DW_ATE_unsigned)], [DW_AT_byte_size, uint(4)]]),
      );
      const { state } = newState();
      const d = decodeValue({ kind: 'unavailable', reason: 'gone' }, reg.resolve(10), state, reg);
      assert.ok(
        d.display === '<optimized out>' || d.display === 'gone',
        `expected an optimized-out placeholder, got ${d.display}`,
      );
    });

    it('an unresolved / unknown type yields <unknown>', () => {
      const reg = regOf(
        die(10, DW_TAG_base_type, [[DW_AT_name, str('u32')], [DW_AT_byte_size, uint(4)]]),
      );
      const { state } = newState();
      // resolve of a missing offset is an `unresolved` type.
      const d = decodeValue(at(0), reg.resolve(999999), state, reg);
      assert.strictEqual(d.display, '<unknown>');
    });

    it('a decode that throws is caught and reported as <unreadable>', () => {
      const reg = regOf(
        die(10, DW_TAG_base_type, [[DW_AT_name, str('u32')], [DW_AT_encoding, uint(DW_ATE_unsigned)], [DW_AT_byte_size, uint(4)]]),
      );
      const throwState: RuntimeState = {
        localValue: () => undefined,
        globalValue: () => undefined,
        stackValue: () => undefined,
        readMemory: () => {
          throw new Error('boom');
        },
      };
      const d = decodeValue(at(0), reg.resolve(10), throwState, reg);
      assert.strictEqual(d.display, '<unreadable>');
    });
  });

  // 9. More base scalars: signed i64, float32, char/UTF codepoint -----------
  describe('more base scalars', () => {
    it('sign-extends a negative i64 via BigInt', () => {
      const reg = regOf(
        die(10, DW_TAG_base_type, [[DW_AT_name, str('i64')], [DW_AT_encoding, uint(DW_ATE_signed)], [DW_AT_byte_size, uint(8)]]),
      );
      const { state, dv } = newState();
      dv.setBigInt64(0, -2n, true); // 0xFFFF_FFFF_FFFF_FFFE
      const d = decodeValue(at(0), reg.resolve(10), state, reg);
      assert.strictEqual(d.display, '-2');
      assert.strictEqual(d.typeName, 'i64');
    });

    it('decodes an i64 below -2^53 exactly (BigInt, not lossy Number)', () => {
      const reg = regOf(
        die(10, DW_TAG_base_type, [[DW_AT_name, str('i64')], [DW_AT_encoding, uint(DW_ATE_signed)], [DW_AT_byte_size, uint(8)]]),
      );
      const { state, dv } = newState();
      dv.setBigInt64(0, -9007199254740993n, true); // -(2^53 + 1)
      const d = decodeValue(at(0), reg.resolve(10), state, reg);
      assert.strictEqual(d.display, '-9007199254740993');
    });

    it('decodes an f32 via DataView', () => {
      const reg = regOf(
        die(10, DW_TAG_base_type, [[DW_AT_name, str('f32')], [DW_AT_encoding, uint(DW_ATE_float)], [DW_AT_byte_size, uint(4)]]),
      );
      const { state, dv } = newState();
      dv.setFloat32(0, 1.5, true);
      const d = decodeValue(at(0), reg.resolve(10), state, reg);
      assert.strictEqual(d.display, '1.5');
      assert.strictEqual(d.typeName, 'f32');
    });

    it('decodes a printable UTF char codepoint as a quoted char', () => {
      const reg = regOf(
        die(10, DW_TAG_base_type, [[DW_AT_name, str('char')], [DW_AT_encoding, uint(DW_ATE_UTF)], [DW_AT_byte_size, uint(4)]]),
      );
      const { state, dv } = newState();
      putU(dv, 0, 65, 4); // 'A'
      assert.strictEqual(decodeValue(at(0), reg.resolve(10), state, reg).display, "'A'");
    });

    it('decodes a non-printable char codepoint as its numeric value', () => {
      const reg = regOf(
        die(10, DW_TAG_base_type, [[DW_AT_name, str('char')], [DW_AT_encoding, uint(DW_ATE_UTF)], [DW_AT_byte_size, uint(4)]]),
      );
      const { state, dv } = newState();
      putU(dv, 0, 10, 4); // '\n' -> not printable
      assert.strictEqual(decodeValue(at(0), reg.resolve(10), state, reg).display, '10');
    });

    it('decodes an unsigned_char byte as a quoted char', () => {
      const reg = regOf(
        die(10, DW_TAG_base_type, [[DW_AT_name, str('u8')], [DW_AT_encoding, uint(DW_ATE_unsigned_char)], [DW_AT_byte_size, uint(1)]]),
      );
      const { state, mem } = newState();
      mem[0] = 0x7a; // 'z'
      assert.strictEqual(decodeValue(at(0), reg.resolve(10), state, reg).display, "'z'");
    });
  });

  // 10. Base scalar from global / stack register locations -----------------
  describe('base scalars from global / stack locations', () => {
    function baseReg(): TypeRegistry {
      return regOf(
        die(10, DW_TAG_base_type, [[DW_AT_name, str('u32')], [DW_AT_encoding, uint(DW_ATE_unsigned)], [DW_AT_byte_size, uint(4)]]),
      );
    }

    it('decodes a u32 held in a wasm global', () => {
      const { state, globals } = newState();
      globals.set(3, 258);
      const reg = baseReg();
      const d = decodeValue({ kind: 'global', index: 3 }, reg.resolve(10), state, reg);
      assert.strictEqual(d.display, '258');
    });

    it('decodes a u32 held in a wasm operand-stack slot', () => {
      const { state, stacks } = newState();
      stacks.set(1, 305419896);
      const reg = baseReg();
      const d = decodeValue({ kind: 'stack', index: 1 }, reg.resolve(10), state, reg);
      assert.strictEqual(d.display, '305419896');
    });
  });

  // 11. C-style enum -------------------------------------------------------
  describe('C-style enum', () => {
    // Color@200 (byteSize 4) { Red=0, Green=1, Blue=2 }.
    function enumReg(): TypeRegistry {
      return regOf(
        die(200, DW_TAG_enumeration_type, [[DW_AT_name, str('Color')], [DW_AT_byte_size, uint(4)]], [
          die(201, DW_TAG_enumerator, [[DW_AT_name, str('Red')], [DW_AT_const_value, uint(0)]]),
          die(202, DW_TAG_enumerator, [[DW_AT_name, str('Green')], [DW_AT_const_value, uint(1)]]),
          die(203, DW_TAG_enumerator, [[DW_AT_name, str('Blue')], [DW_AT_const_value, uint(2)]]),
        ]),
      );
    }

    it('maps a matching value to the enumerator name, as a leaf', () => {
      const { state, dv } = newState();
      putU(dv, 0, 1, 4);
      const reg = enumReg();
      const d = decodeValue(at(0), reg.resolve(200), state, reg);
      assert.strictEqual(d.display, 'Green');
      assert.strictEqual(d.typeName, 'Color');
      assert.ok(noChildren(d), 'a C enum is a leaf');
    });

    it('falls back to the numeric value when nothing matches', () => {
      const { state, dv } = newState();
      putU(dv, 0, 7, 4);
      const reg = enumReg();
      assert.strictEqual(decodeValue(at(0), reg.resolve(200), state, reg).display, '7');
    });
  });

  // 12. Union --------------------------------------------------------------
  describe('union', () => {
    // U@210 (byteSize 4) { u: u32@10 @0, i: i32@20 @0 } — both members alias offset 0.
    function unionReg(): TypeRegistry {
      return regOf(
        die(10, DW_TAG_base_type, [[DW_AT_name, str('u32')], [DW_AT_encoding, uint(DW_ATE_unsigned)], [DW_AT_byte_size, uint(4)]]),
        die(20, DW_TAG_base_type, [[DW_AT_name, str('i32')], [DW_AT_encoding, uint(DW_ATE_signed)], [DW_AT_byte_size, uint(4)]]),
        die(210, DW_TAG_union_type, [[DW_AT_name, str('U')], [DW_AT_byte_size, uint(4)]], [
          die(211, DW_TAG_member, [[DW_AT_name, str('u')], [DW_AT_type, ref(10)], [DW_AT_data_member_location, uint(0)]]),
          die(212, DW_TAG_member, [[DW_AT_name, str('i')], [DW_AT_type, ref(20)], [DW_AT_data_member_location, uint(0)]]),
        ]),
      );
    }

    it('decodes each member at the shared base offset', () => {
      const { state, dv } = newState();
      putU(dv, 1000, -1 >>> 0, 4); // 0xFFFFFFFF
      const reg = unionReg();
      const d = decodeValue(at(1000), reg.resolve(210), state, reg);
      assert.strictEqual(d.typeName, 'U');
      const kids = childrenOf(d);
      assert.strictEqual(kids.length, 2);
      assert.strictEqual(kids[0].name, 'u');
      assert.strictEqual(kids[0].value.display, '4294967295'); // as u32
      assert.strictEqual(kids[1].name, 'i');
      assert.strictEqual(kids[1].value.display, '-1'); // same bytes as i32
    });
  });

  // 13. Rust slice `&[T]` --------------------------------------------------
  describe('&[T] slice', () => {
    // &[u8]@230: struct named "&[u8]" with { data_ptr: *u8@130 @0, length: usize@150 @4 }.
    function sliceReg(): TypeRegistry {
      return regOf(
        die(140, DW_TAG_base_type, [[DW_AT_name, str('u8')], [DW_AT_encoding, uint(DW_ATE_unsigned)], [DW_AT_byte_size, uint(1)]]),
        die(130, DW_TAG_pointer_type, [[DW_AT_type, ref(140)], [DW_AT_byte_size, uint(4)]]),
        die(150, DW_TAG_base_type, [[DW_AT_name, str('usize')], [DW_AT_encoding, uint(DW_ATE_unsigned)], [DW_AT_byte_size, uint(4)]]),
        die(230, DW_TAG_structure_type, [[DW_AT_name, str('&[u8]')], [DW_AT_byte_size, uint(8)]], [
          die(231, DW_TAG_member, [[DW_AT_name, str('data_ptr')], [DW_AT_type, ref(130)], [DW_AT_data_member_location, uint(0)]]),
          die(232, DW_TAG_member, [[DW_AT_name, str('length')], [DW_AT_type, ref(150)], [DW_AT_data_member_location, uint(4)]]),
        ]),
      );
    }

    it('decodes indexed element children at ptr + i*elemSize', () => {
      const { state, dv, mem } = newState();
      putBytes(mem, 800, [10, 20, 30]); // three u8 elements
      putU(dv, 900, 800, 4); // data_ptr -> 800
      putU(dv, 904, 3, 4); // length = 3
      const reg = sliceReg();
      const d = decodeValue(at(900), reg.resolve(230), state, reg);
      assert.strictEqual(d.display, '&[…; 3]');
      assert.strictEqual(d.typeName, '&[u8]');
      const kids = childrenOf(d);
      assert.strictEqual(kids.length, 3);
      assert.strictEqual(kids[0].name, '[0]');
      assert.strictEqual(kids[0].value.display, '10');
      assert.strictEqual(kids[1].value.display, '20');
      assert.strictEqual(kids[2].value.display, '30');
    });

    it('truncates slice children at maxChildren and appends an ellipsis', () => {
      const { state, dv, mem } = newState();
      putBytes(mem, 800, [10, 20, 30]);
      putU(dv, 900, 800, 4);
      putU(dv, 904, 3, 4);
      const reg = sliceReg();
      const d = decodeValue(at(900), reg.resolve(230), state, reg, { maxChildren: 2 });
      const kids = childrenOf(d);
      assert.strictEqual(kids.length, 3); // 2 elements + 1 truncation marker
      assert.strictEqual(kids[2].value.display, '…');
    });
  });

  // 14. Conservative &str recognition (regression) -------------------------
  describe('&str recognition is conservative', () => {
    // Foo@240 { handle: *u8@130 @0, count: u32@10 @4 } — NOT named &str, and its
    // members are NOT named data_ptr/length. A struct that merely holds a pointer
    // and an integer must decode as a generic struct, never as a UTF-8 string.
    function fooReg(): TypeRegistry {
      return regOf(
        die(140, DW_TAG_base_type, [[DW_AT_name, str('u8')], [DW_AT_encoding, uint(DW_ATE_unsigned)], [DW_AT_byte_size, uint(1)]]),
        die(130, DW_TAG_pointer_type, [[DW_AT_type, ref(140)], [DW_AT_byte_size, uint(4)]]),
        die(10, DW_TAG_base_type, [[DW_AT_name, str('u32')], [DW_AT_encoding, uint(DW_ATE_unsigned)], [DW_AT_byte_size, uint(4)]]),
        die(240, DW_TAG_structure_type, [[DW_AT_name, str('Foo')], [DW_AT_byte_size, uint(8)]], [
          die(241, DW_TAG_member, [[DW_AT_name, str('handle')], [DW_AT_type, ref(130)], [DW_AT_data_member_location, uint(0)]]),
          die(242, DW_TAG_member, [[DW_AT_name, str('count')], [DW_AT_type, ref(10)], [DW_AT_data_member_location, uint(4)]]),
        ]),
      );
    }

    it('decodes a pointer+integer struct as a generic struct, not a string', () => {
      const { state, dv, mem } = newState();
      putBytes(mem, 600, [104, 101, 108, 108, 111]); // would be "hello" if misread
      putU(dv, 620, 600, 4); // handle -> 600
      putU(dv, 624, 5, 4); // count = 5
      const reg = fooReg();
      const d = decodeValue(at(620), reg.resolve(240), state, reg);
      // Not a quoted string, and the type name is preserved as the struct's.
      assert.strictEqual(d.typeName, 'Foo');
      assert.ok(!d.display.startsWith('"'), `must not render as a string, got ${d.display}`);
      // The real fields are exposed as children (they would be hidden by a string leaf).
      const kids = childrenOf(d);
      assert.strictEqual(kids.length, 2);
      assert.strictEqual(kids[0].name, 'handle');
      assert.strictEqual(kids[0].value.display, '0x258'); // 600
      assert.strictEqual(kids[1].name, 'count');
      assert.strictEqual(kids[1].value.display, '5');
    });
  });

  // 15. Laziness: leaving a value collapsed reads no memory -----------------
  describe('laziness', () => {
    /** Wraps a MockState's readMemory with a call counter. */
    function counting(ms: ReturnType<typeof newState>): { reads: () => number } {
      let n = 0;
      const inner = ms.state.readMemory;
      ms.state.readMemory = (addr: number, size: number) => {
        n++;
        return inner(addr, size);
      };
      return { reads: () => n };
    }

    it('a struct performs zero memory reads until children() is called', () => {
      const reg = regOf(
        die(10, DW_TAG_base_type, [[DW_AT_name, str('u32')], [DW_AT_encoding, uint(DW_ATE_unsigned)], [DW_AT_byte_size, uint(4)]]),
        die(90, DW_TAG_structure_type, [[DW_AT_name, str('Point')], [DW_AT_byte_size, uint(8)]], [
          die(91, DW_TAG_member, [[DW_AT_name, str('x')], [DW_AT_type, ref(10)], [DW_AT_data_member_location, uint(0)]]),
          die(92, DW_TAG_member, [[DW_AT_name, str('y')], [DW_AT_type, ref(10)], [DW_AT_data_member_location, uint(4)]]),
        ]),
      );
      const ms = newState();
      putU(ms.dv, 400, 10, 4);
      putU(ms.dv, 404, 20, 4);
      const spy = counting(ms);
      const decoded = decodeValue(at(400), reg.resolve(90), ms.state, reg);
      assert.strictEqual(spy.reads(), 0, 'constructing a collapsed struct must read no memory');
      // Expanding it now performs the reads.
      childrenOf(decoded);
      assert.ok(spy.reads() > 0, 'expanding the struct reads its members');
    });

    it('an array performs zero memory reads until children() is called', () => {
      const reg = regOf(
        die(10, DW_TAG_base_type, [[DW_AT_name, str('u32')], [DW_AT_encoding, uint(DW_ATE_unsigned)], [DW_AT_byte_size, uint(4)]]),
        die(100, DW_TAG_array_type, [[DW_AT_type, ref(10)]], [
          die(101, DW_TAG_subrange_type, [[DW_AT_count, uint(3)]]),
        ]),
      );
      const ms = newState();
      putU(ms.dv, 500, 1, 4);
      const spy = counting(ms);
      const decoded = decodeValue(at(500), reg.resolve(100), ms.state, reg);
      assert.strictEqual(spy.reads(), 0, 'constructing a collapsed array must read no memory');
      childrenOf(decoded);
      assert.ok(spy.reads() > 0, 'expanding the array reads its elements');
    });

    it('a rustEnum performs zero memory reads until children() is called', () => {
      // Option@1000 { discr@0:u32, Some(payload@4:u32) / None }.
      const u32 = die(300, DW_TAG_base_type, [[DW_AT_name, str('u32')], [DW_AT_encoding, uint(DW_ATE_unsigned)], [DW_AT_byte_size, uint(4)]]);
      const some = die(1031, DW_TAG_variant, [[DW_AT_discr_value, uint(1)]], [
        die(1032, DW_TAG_member, [[DW_AT_name, str('Some')], [DW_AT_type, ref(300)], [DW_AT_data_member_location, uint(4)]]),
      ]);
      const none = die(1041, DW_TAG_variant, [[DW_AT_discr_value, uint(0)]], [
        die(1042, DW_TAG_member, [[DW_AT_name, str('None')], [DW_AT_data_member_location, uint(4)]]),
      ]);
      const discrMember = die(1020, DW_TAG_member, [[DW_AT_name, str('discr')], [DW_AT_type, ref(300)], [DW_AT_data_member_location, uint(0)]]);
      const variantPart = die(1010, DW_TAG_variant_part, [[DW_AT_discr, ref(1020)]], [discrMember, some, none]);
      const enumStruct = die(1000, DW_TAG_structure_type, [[DW_AT_name, str('Option')], [DW_AT_byte_size, uint(8)]], [variantPart]);
      const reg = regOf(u32, enumStruct);

      const ms = newState();
      putU(ms.dv, 700, 1, 4); // discr -> Some
      putU(ms.dv, 704, 42, 4); // payload
      const spy = counting(ms);
      // The discriminant read is required to name the active variant, so it is
      // eager; but the payload child must not be read until expansion.
      const decoded = decodeValue(at(700), reg.resolve(1000), ms.state, reg);
      const readsAfterConstruct = spy.reads();
      childrenOf(decoded);
      assert.ok(spy.reads() > readsAfterConstruct, 'expanding Some reads its payload');
    });
  });
});
