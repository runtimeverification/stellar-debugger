/**
 * Type-aware value decoder: given a resolved `ValueLocation` (M4), a `DwarfType`
 * (M3), and a snapshot of the WASM runtime, produces a human-readable value plus
 * — lazily — its children for the DAP Variables tree.
 *
 * This is also where **Rust surface types** (`&str`, slices) are recognized by a
 * struct's name and shape; the `TypeRegistry` stays a faithful DWARF model and
 * says nothing about Rust conventions. `Option`/`Result` are ordinary Rust enums
 * (a `variant_part`) and are handled by the `rustEnum` branch.
 *
 * The decoder NEVER throws: any failure — an out-of-range read, a `readMemory`
 * that itself throws, an unmodelled type — degrades to a placeholder string
 * (`<unreadable>`, `<optimized out>`, `<unknown>`, `…`). Recursion is bounded by a
 * depth/child/string budget and a visited-set that breaks pointer cycles.
 *
 * All scalars are little-endian; pointers/`usize` are 4 bytes; 8-byte integers are
 * decoded through `BigInt` (they can exceed `2^53`).
 *
 * Pure module (no `vscode` imports, no external deps).
 */

import {
  TypeRegistry,
  DwarfType,
  BaseType,
  PointerType,
  StructType,
  UnionType,
  ArrayType,
  EnumType,
  RustEnumType,
  Member,
} from './TypeRegistry';
import { ValueLocation, RuntimeState, registerValue } from './locexpr';
import {
  DW_ATE_boolean,
  DW_ATE_float,
  DW_ATE_signed,
  DW_ATE_signed_char,
  DW_ATE_unsigned,
  DW_ATE_unsigned_char,
  DW_ATE_address,
  DW_ATE_UTF,
} from './constants';

/** A decoded value: a display string plus, for aggregates, lazy children. */
export interface DecodedValue {
  /** The value string shown in the UI. */
  display: string;
  /** The type's display name, e.g. `u32`, `&str`, `MyStruct`. */
  typeName?: string;
  /** Present only for expandable values; evaluated lazily on expansion. */
  children?: () => ChildVar[];
}

/** One named child of an expandable `DecodedValue`. */
export interface ChildVar {
  name: string;
  value: DecodedValue;
}

/** Recursion/size limits; a partial override is merged over the defaults. */
export interface DecodeBudget {
  /** Maximum nesting depth before a value collapses to `…`. */
  maxDepth: number;
  /** Maximum children materialized per aggregate (rest becomes a `…` marker). */
  maxChildren: number;
  /** Maximum bytes read for a string value before truncation. */
  maxStringBytes: number;
}

const DEFAULT_BUDGET: DecodeBudget = {
  maxDepth: 5,
  maxChildren: 200,
  maxStringBytes: 4096,
};

/** Address size (bytes) of a pointer / `usize` on this target. */
const ADDRESS_SIZE = 4;

/** The mutable context threaded through a decode. */
interface DecodeContext {
  state: RuntimeState;
  registry: TypeRegistry;
  budget: DecodeBudget;
  depth: number;
  /** `${address}:${typeRef}` keys of pointees already entered — cycle guard. */
  visited: Set<string>;
}

/**
 * Decodes the value at `loc` of type `type` into a `DecodedValue`. `budget`
 * overrides the default recursion/size limits. Never throws.
 */
export function decodeValue(
  loc: ValueLocation,
  type: DwarfType,
  state: RuntimeState,
  registry: TypeRegistry,
  budget?: Partial<DecodeBudget>,
): DecodedValue {
  const ctx: DecodeContext = {
    state,
    registry,
    budget: { ...DEFAULT_BUDGET, ...budget },
    depth: 0,
    visited: new Set<string>(),
  };
  return decode(loc, type, ctx);
}

/** Resolves `typeRef` and decodes `loc` against it. */
function decodeRef(loc: ValueLocation, typeRef: number | undefined, ctx: DecodeContext): DecodedValue {
  return decode(loc, ctx.registry.resolve(typeRef), ctx);
}

/** Decode wrapper: strips typedefs, applies guards, and catches every throw. */
function decode(loc: ValueLocation, type: DwarfType, ctx: DecodeContext): DecodedValue {
  try {
    const t = ctx.registry.stripTypedefs(type);
    if (loc.kind === 'unavailable') {
      return { display: '<optimized out>' };
    }
    if (ctx.depth > ctx.budget.maxDepth) {
      return { display: '…', typeName: typeNameOf(t, ctx) };
    }
    switch (t.kind) {
      case 'base':
        return decodeBase(t, loc, ctx);
      case 'pointer':
        return decodePointer(t, loc, ctx);
      case 'struct':
        return decodeStruct(t, loc, ctx);
      case 'union':
        return decodeUnion(t, loc, ctx);
      case 'array':
        return decodeArray(t, loc, ctx);
      case 'enum':
        return decodeEnum(t, loc, ctx);
      case 'rustEnum':
        return decodeRustEnum(t, loc, ctx);
      default:
        return { display: '<unknown>' };
    }
  } catch {
    return { display: '<unreadable>' };
  }
}

// --- Base types ------------------------------------------------------------

function decodeBase(type: BaseType, loc: ValueLocation, ctx: DecodeContext): DecodedValue {
  const size = type.byteSize;
  if (!size) {
    return { display: '<unknown>', typeName: type.name };
  }
  const bytes = rawBytes(loc, size, ctx);
  if (!bytes || bytes.length < size) {
    return { display: '<unreadable>', typeName: type.name };
  }
  const enc = type.encoding;

  if (enc === DW_ATE_boolean) {
    return { display: bytes.some((b) => b !== 0) ? 'true' : 'false', typeName: type.name };
  }
  if (enc === DW_ATE_float) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const value = size === 4 ? dv.getFloat32(0, true) : dv.getFloat64(0, true);
    return { display: String(value), typeName: type.name };
  }
  if (
    (enc === DW_ATE_unsigned_char || enc === DW_ATE_signed_char || enc === DW_ATE_UTF) &&
    (size === 1 || size === 4)
  ) {
    const cp = readUnsignedLE(bytes, size);
    // Printable codepoint -> a quoted char; otherwise its numeric value.
    if (cp >= 0x20 && cp !== 0x7f) {
      return { display: `'${String.fromCodePoint(cp)}'`, typeName: type.name };
    }
    return { display: String(cp), typeName: type.name };
  }

  const signed = enc === DW_ATE_signed || enc === DW_ATE_signed_char;
  if (size > 4) {
    // 8-byte integers exceed 2^53; decode exactly through BigInt.
    let value = readUnsignedBig(bytes, size);
    if (signed) {
      const bits = BigInt(size * 8);
      if (value >= 1n << (bits - 1n)) {
        value -= 1n << bits;
      }
    }
    return { display: value.toString(), typeName: type.name };
  }
  let value = readUnsignedLE(bytes, size);
  if (signed) {
    const bits = size * 8;
    if (value >= 2 ** (bits - 1)) {
      value -= 2 ** bits;
    }
  }
  return { display: String(value), typeName: type.name };
}

// --- Pointers --------------------------------------------------------------

function decodePointer(type: PointerType, loc: ValueLocation, ctx: DecodeContext): DecodedValue {
  const size = type.byteSize || ADDRESS_SIZE;
  const bytes = rawBytes(loc, size, ctx);
  if (!bytes || bytes.length < size) {
    return { display: '<unreadable>', typeName: typeNameOf(type, ctx) };
  }
  const p = readUnsignedLE(bytes, size);
  const display = '0x' + p.toString(16);
  const typeName = typeNameOf(type, ctx);

  const targetRef = type.targetRef;
  if (p !== 0 && targetRef !== undefined) {
    const key = `${p}:${targetRef}`;
    const children = (): ChildVar[] => {
      // Re-entering the same pointee terminates the walk with a placeholder.
      if (ctx.visited.has(key)) {
        return [{ name: '*', value: { display: '…' } }];
      }
      const derefCtx: DecodeContext = {
        ...ctx,
        depth: ctx.depth + 1,
        visited: new Set(ctx.visited).add(key),
      };
      return [{ name: '*', value: decodeRef({ kind: 'memory', address: p }, targetRef, derefCtx) }];
    };
    return { display, typeName, children };
  }
  return { display, typeName };
}

// --- Structs / unions ------------------------------------------------------

function decodeStruct(type: StructType, loc: ValueLocation, ctx: DecodeContext): DecodedValue {
  // Rust surface types (`&str`, slices) are recognized here, by name and shape.
  const surface = tryRustSurface(type, loc, ctx);
  if (surface) {
    return surface;
  }
  if (loc.kind !== 'memory') {
    // A `#[repr(transparent)]`-style newtype — a single member at offset 0 that
    // spans the whole struct — carries no layout of its own: its value IS the
    // member's value, so it can live entirely in a register or as an immediate
    // (e.g. a Soroban `Val`, a lone `u64`, passed in a wasm local). Decode it as
    // that member, reading the scalar straight from the register/value, and keep
    // the wrapper's type name. Multi-member aggregates still need a memory base.
    const inner = transparentMember(type);
    if (inner && (loc.kind === 'local' || loc.kind === 'global' || loc.kind === 'stack' || loc.kind === 'value')) {
      const decoded = decodeRef(loc, inner.typeRef, ctx);
      return { ...decoded, typeName: type.name ?? decoded.typeName };
    }
    return { display: '<unreadable>', typeName: type.name };
  }
  return aggregate(type.name ?? '{…}', type.name, type.members, loc.address, ctx);
}

/**
 * The sole member of a transparent newtype (exactly one member, located at
 * offset 0), or `undefined`. Such a struct's value equals its member's value, so
 * it can be decoded from a non-memory location.
 */
function transparentMember(type: StructType): Member | undefined {
  if (type.members.length !== 1) {
    return undefined;
  }
  const m = type.members[0];
  return m.offset === 0 ? m : undefined;
}

function decodeUnion(type: UnionType, loc: ValueLocation, ctx: DecodeContext): DecodedValue {
  if (loc.kind !== 'memory') {
    return { display: '<unreadable>', typeName: type.name };
  }
  return aggregate(type.name ?? '{…}', type.name, type.members, loc.address, ctx);
}

/** Builds an aggregate `DecodedValue` whose members are decoded lazily. */
function aggregate(
  display: string,
  typeName: string | undefined,
  members: Member[],
  base: number,
  ctx: DecodeContext,
): DecodedValue {
  const children = (): ChildVar[] => {
    const cap = ctx.budget.maxChildren;
    const limit = Math.min(members.length, cap);
    const childCtx: DecodeContext = { ...ctx, depth: ctx.depth + 1 };
    const out: ChildVar[] = [];
    for (let i = 0; i < limit; i++) {
      const m = members[i];
      out.push({
        name: m.name ?? '<field>',
        value: decodeRef({ kind: 'memory', address: base + m.offset }, m.typeRef, childCtx),
      });
    }
    if (members.length > cap) {
      out.push({ name: '…', value: { display: '…' } });
    }
    return out;
  };
  return { display, typeName, children };
}

// --- Arrays ----------------------------------------------------------------

function decodeArray(type: ArrayType, loc: ValueLocation, ctx: DecodeContext): DecodedValue {
  if (loc.kind !== 'memory') {
    return { display: '<unreadable>', typeName: typeNameOf(type, ctx) };
  }
  const base = loc.address;
  const elemSize = byteSizeOf(type.elementRef, ctx);
  const count = type.count ?? 0;
  const typeName = typeNameOf(type, ctx);
  const children = (): ChildVar[] => {
    const cap = ctx.budget.maxChildren;
    const n = Math.min(count, cap);
    const childCtx: DecodeContext = { ...ctx, depth: ctx.depth + 1 };
    const out: ChildVar[] = [];
    for (let i = 0; i < n; i++) {
      out.push({
        name: `[${i}]`,
        value: decodeRef({ kind: 'memory', address: base + i * elemSize }, type.elementRef, childCtx),
      });
    }
    if (count > cap) {
      out.push({ name: '…', value: { display: '…' } });
    }
    return out;
  };
  return { display: `[…; ${count}]`, typeName, children };
}

// --- Enums -----------------------------------------------------------------

function decodeEnum(type: EnumType, loc: ValueLocation, ctx: DecodeContext): DecodedValue {
  const size = type.byteSize || ADDRESS_SIZE;
  const bytes = rawBytes(loc, size, ctx);
  if (!bytes || bytes.length < size) {
    return { display: '<unreadable>', typeName: type.name };
  }
  const value = readUnsignedLE(bytes, size);
  const match = type.enumerators.find((e) => e.value === value);
  return { display: match?.name ?? String(value), typeName: type.name };
}

function decodeRustEnum(type: RustEnumType, loc: ValueLocation, ctx: DecodeContext): DecodedValue {
  if (loc.kind !== 'memory') {
    return { display: '<unreadable>', typeName: type.name };
  }
  const base = loc.address;
  let disc: number | undefined;
  if (type.discr) {
    disc = intAt(base + type.discr.offset, byteSizeOf(type.discr.typeRef, ctx), ctx);
  }
  // The arm whose discriminant matches, else the default (undefined) arm.
  const variant =
    type.variants.find((v) => v.discrValue === disc) ??
    type.variants.find((v) => v.discrValue === undefined);
  if (!variant) {
    return { display: '<unknown>', typeName: type.name };
  }
  const member = variant.member;
  const display = member.name ?? '<variant>';

  let children: (() => ChildVar[]) | undefined;
  // A None-like arm carries no payload type -> no meaningful children.
  if (member.typeRef !== undefined) {
    const childCtx: DecodeContext = { ...ctx, depth: ctx.depth + 1 };
    children = (): ChildVar[] => [
      {
        name: member.name ?? '0',
        value: decodeRef({ kind: 'memory', address: base + member.offset }, member.typeRef, childCtx),
      },
    ];
  }
  return { display, typeName: type.name, children };
}

// --- Rust surface recognition (`&str`, slices) -----------------------------

function tryRustSurface(type: StructType, loc: ValueLocation, ctx: DecodeContext): DecodedValue | undefined {
  if (loc.kind !== 'memory') {
    return undefined;
  }
  const name = type.name ?? '';
  const isStrName = name === '&str' || name === '&mut str';
  const isSliceName = name.startsWith('&[') || name.startsWith('&mut [');

  // The (data_ptr, length) fat-pointer shape. The explicitly-named members are
  // the only ones that qualify an unnamed struct; the positional pointer/integer
  // fallback is used ONLY once the type name already marks it as a `&str`/slice,
  // so an ordinary struct that merely happens to hold a pointer and an integer
  // (e.g. `Foo { handle: *mut c_void, count: u32 }`) is never misread as a string.
  const namedPtr = findMember(type.members, 'data_ptr');
  const namedLen = findMember(type.members, 'length');
  const hasNamedShape = !!(namedPtr && namedLen && namedPtr !== namedLen);

  const resolveShape = (): { ptr: Member; len: Member } | undefined => {
    const ptr = namedPtr ?? type.members.find((m) => isPointerRef(m.typeRef, ctx));
    const len = namedLen ?? type.members.find((m) => isIntegerRef(m.typeRef, ctx));
    return ptr && len && ptr !== len ? { ptr, len } : undefined;
  };

  if (isSliceName) {
    const shape = resolveShape();
    return shape ? decodeSlice(type, loc.address, shape.ptr, shape.len, ctx) : undefined;
  }
  if (isStrName) {
    const shape = resolveShape();
    return shape ? decodeStr(loc.address, shape.ptr, shape.len, ctx) : undefined;
  }
  if (hasNamedShape) {
    return decodeStr(loc.address, namedPtr!, namedLen!, ctx);
  }
  return undefined;
}

/** Reads a `(data_ptr, length)` pair as a quoted UTF-8 Rust string literal. */
function decodeStr(base: number, ptrMember: Member, lenMember: Member, ctx: DecodeContext): DecodedValue {
  const ptr = intAt(base + ptrMember.offset, ADDRESS_SIZE, ctx);
  const len = intAt(base + lenMember.offset, byteSizeOf(lenMember.typeRef, ctx), ctx);
  if (ptr === undefined || len === undefined) {
    return { display: '<unreadable>', typeName: '&str' };
  }
  const cap = Math.min(len, ctx.budget.maxStringBytes);
  const bytes = ctx.state.readMemory(ptr, cap);
  if (!bytes) {
    return { display: '<unreadable>', typeName: '&str' };
  }
  const text = new TextDecoder('utf-8').decode(bytes);
  const truncated = len > ctx.budget.maxStringBytes;
  return { display: `"${text}${truncated ? '…' : ''}"`, typeName: '&str' };
}

/** Decodes a `&[T]` slice `(data_ptr, length)` into indexed element children. */
function decodeSlice(
  type: StructType,
  base: number,
  ptrMember: Member,
  lenMember: Member,
  ctx: DecodeContext,
): DecodedValue {
  const ptr = intAt(base + ptrMember.offset, ADDRESS_SIZE, ctx);
  const len = intAt(base + lenMember.offset, byteSizeOf(lenMember.typeRef, ctx), ctx) ?? 0;
  const ptrType = ctx.registry.stripTypedefs(ctx.registry.resolve(ptrMember.typeRef));
  const elemRef = ptrType.kind === 'pointer' ? ptrType.targetRef : undefined;
  const elemSize = byteSizeOf(elemRef, ctx);
  const display = `&[…; ${len}]`;
  if (ptr === undefined) {
    return { display, typeName: type.name };
  }
  const children = (): ChildVar[] => {
    const cap = ctx.budget.maxChildren;
    const n = Math.min(len, cap);
    const childCtx: DecodeContext = { ...ctx, depth: ctx.depth + 1 };
    const out: ChildVar[] = [];
    for (let i = 0; i < n; i++) {
      out.push({
        name: `[${i}]`,
        value: decodeRef({ kind: 'memory', address: ptr + i * elemSize }, elemRef, childCtx),
      });
    }
    if (len > cap) {
      out.push({ name: '…', value: { display: '…' } });
    }
    return out;
  };
  return { display, typeName: type.name, children };
}

// --- Byte access -----------------------------------------------------------

/** Gathers `size` bytes behind `loc`, or `undefined` if it cannot be read. */
function rawBytes(loc: ValueLocation, size: number, ctx: DecodeContext): Uint8Array | undefined {
  switch (loc.kind) {
    case 'memory':
      return ctx.state.readMemory(loc.address, size);
    case 'local':
    case 'global':
    case 'stack': {
      const value = registerValue(loc, ctx.state);
      // Registers hold scalars; an aggregate landing here is simply unreadable.
      return value === undefined ? undefined : encodeLE(value, size);
    }
    case 'value':
      return encodeLE(loc.value, size);
    default:
      return undefined;
  }
}

/** Reads an unsigned little-endian integer (size <= 4) as a `number`. */
function readUnsignedLE(bytes: Uint8Array, size: number): number {
  let value = 0;
  for (let i = 0; i < size; i++) {
    value += bytes[i] * 2 ** (8 * i);
  }
  return value;
}

/** Reads an unsigned little-endian integer of any width as a `BigInt`. */
function readUnsignedBig(bytes: Uint8Array, size: number): bigint {
  let value = 0n;
  for (let i = 0; i < size; i++) {
    value += BigInt(bytes[i]) << BigInt(8 * i);
  }
  return value;
}

/** Reads an unsigned LE int from memory at `addr`, or `undefined`. */
function intAt(addr: number, size: number, ctx: DecodeContext): number | undefined {
  const bytes = ctx.state.readMemory(addr, size);
  if (!bytes || bytes.length < size) {
    return undefined;
  }
  return readUnsignedLE(bytes, size);
}

/** Encodes a scalar as `size` little-endian bytes (two's-complement if negative). */
function encodeLE(value: number | bigint, size: number): Uint8Array {
  const buf = new Uint8Array(size);
  let v = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
  if (v < 0n) {
    v += 1n << BigInt(size * 8);
  }
  for (let i = 0; i < size; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

// --- Type helpers ----------------------------------------------------------

/** The byte width of the type at `typeRef`; a sane default when unknown. */
function byteSizeOf(typeRef: number | undefined, ctx: DecodeContext): number {
  const t = ctx.registry.stripTypedefs(ctx.registry.resolve(typeRef));
  switch (t.kind) {
    case 'base':
      return t.byteSize || ADDRESS_SIZE;
    case 'pointer':
      return t.byteSize || ADDRESS_SIZE;
    case 'enum':
    case 'struct':
    case 'union':
    case 'rustEnum':
      return t.byteSize || ADDRESS_SIZE;
    default:
      return ADDRESS_SIZE;
  }
}

/** Whether the type at `typeRef` is a pointer. */
function isPointerRef(typeRef: number | undefined, ctx: DecodeContext): boolean {
  return ctx.registry.stripTypedefs(ctx.registry.resolve(typeRef)).kind === 'pointer';
}

/** Whether the type at `typeRef` is an integer base type. */
function isIntegerRef(typeRef: number | undefined, ctx: DecodeContext): boolean {
  const t = ctx.registry.stripTypedefs(ctx.registry.resolve(typeRef));
  if (t.kind !== 'base') {
    return false;
  }
  return (
    t.encoding === DW_ATE_signed ||
    t.encoding === DW_ATE_unsigned ||
    t.encoding === DW_ATE_address ||
    t.encoding === DW_ATE_signed_char ||
    t.encoding === DW_ATE_unsigned_char
  );
}

/** Finds a named member. */
function findMember(members: Member[], name: string): Member | undefined {
  return members.find((m) => m.name === name);
}

/** A best-effort display name for a type. */
function typeNameOf(type: DwarfType, ctx: DecodeContext): string | undefined {
  switch (type.kind) {
    case 'base':
    case 'struct':
    case 'union':
    case 'enum':
    case 'rustEnum':
      return type.name;
    case 'pointer': {
      if (type.targetRef === undefined) {
        return '*void';
      }
      const target = ctx.registry.stripTypedefs(ctx.registry.resolve(type.targetRef));
      return '*' + (typeNameOf(target, ctx) ?? 'T');
    }
    case 'array': {
      const el =
        type.elementRef === undefined
          ? 'T'
          : typeNameOf(ctx.registry.stripTypedefs(ctx.registry.resolve(type.elementRef)), ctx) ?? 'T';
      return `[${el}; ${type.count ?? '?'}]`;
    }
    default:
      return undefined;
  }
}
