/**
 * Resolves DWARF type DIEs into a small, debugger-friendly `DwarfType` model.
 *
 * A `TypeRegistry` is built over the global `dieByOffset` map produced by
 * `parseDebugInfo` (M2) and turns a section offset into a structured type on
 * demand. Resolution is **one level deep**: composite types (structs, arrays,
 * pointers, …) carry the *offsets* of their referenced types rather than the
 * resolved types themselves. This keeps `resolve` non-recursive — so a type that
 * references itself (a linked-list `Node` whose member points back at the
 * struct) resolves without looping — and lets callers walk references lazily via
 * `resolve` again. Results are memoized, so resolving the same offset twice
 * returns the identical object.
 *
 * `stripTypedefs` peels typedef and cv-qualifier (`const`/`volatile`) wrappers to
 * reach the underlying type, stopping at any wrapper that lacks a target.
 *
 * Pure module (no `vscode` imports, no external deps).
 */

import { Cursor } from './cursor';
import { Die, dieName, dieUint, dieRef } from './die';
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
  DW_AT_type,
  DW_AT_byte_size,
  DW_AT_encoding,
  DW_AT_count,
  DW_AT_upper_bound,
  DW_AT_const_value,
  DW_AT_data_member_location,
  DW_AT_discr,
  DW_AT_discr_value,
  DW_OP_plus_uconst,
} from './constants';

/** One member of a struct, union, or Rust-enum variant. */
export interface Member {
  name?: string;
  /** Offset of the member's type DIE (`resolve` it to get the type). */
  typeRef?: number;
  /** Byte offset of the member within its container. */
  offset: number;
}

/** One arm of a Rust `enum`, keyed by its discriminant value. */
export interface Variant {
  /** The discriminant that selects this arm; `undefined` for the default arm. */
  discrValue?: number;
  /** The payload carried by this arm. */
  member: Member;
}

/** The discriminant descriptor of a Rust `enum`. */
export interface Discr {
  /** Byte offset of the discriminant field within the enum. */
  offset: number;
  /** Offset of the discriminant's type DIE. */
  typeRef?: number;
}

/** A DWARF base type (`u32`, `i32`, `bool`, …). */
export interface BaseType {
  kind: 'base';
  name?: string;
  encoding?: number;
  byteSize?: number;
}

/** A pointer type; `targetRef` is absent for a void pointer. */
export interface PointerType {
  kind: 'pointer';
  targetRef?: number;
  byteSize: number;
}

/** A C-style aggregate. */
export interface StructType {
  kind: 'struct';
  name?: string;
  byteSize?: number;
  members: Member[];
}

/** A C-style union. */
export interface UnionType {
  kind: 'union';
  name?: string;
  byteSize?: number;
  members: Member[];
}

/** An array; `count` is the element count when it can be determined. */
export interface ArrayType {
  kind: 'array';
  elementRef?: number;
  count?: number;
}

/** A C-style enumeration. */
export interface EnumType {
  kind: 'enum';
  name?: string;
  byteSize?: number;
  underlyingRef?: number;
  enumerators: Array<{ name?: string; value?: number }>;
}

/** A `typedef` alias. */
export interface TypedefType {
  kind: 'typedef';
  name?: string;
  targetRef?: number;
}

/** A `const`/`volatile` qualifier wrapping another type. */
export interface QualifierType {
  kind: 'qualifier';
  targetRef?: number;
}

/** A Rust `enum`: a `structure_type` carrying a `variant_part`. */
export interface RustEnumType {
  kind: 'rustEnum';
  name?: string;
  byteSize?: number;
  discr?: Discr;
  variants: Variant[];
}

/** A DIE we do not model as a type; carries its tag for diagnostics. */
export interface UnresolvedType {
  kind: 'unresolved';
  tag?: number;
}

/** The tagged union of every type shape this registry produces. */
export type DwarfType =
  | BaseType
  | PointerType
  | StructType
  | UnionType
  | ArrayType
  | EnumType
  | TypedefType
  | QualifierType
  | RustEnumType
  | UnresolvedType;

export class TypeRegistry {
  private readonly cache = new Map<number, DwarfType>();

  constructor(private readonly dieByOffset: Map<number, Die>) {}

  /**
   * Resolves the type DIE at `offset` into a `DwarfType`. An `undefined` offset,
   * a missing offset, or an unmodelled tag all yield an `unresolved` type. Results
   * for present DIEs are memoized: resolving the same present offset again returns
   * the same object. The `unresolved` value handed back for an `undefined` or
   * missing offset is a fresh object each call (nothing is cached in those cases).
   */
  resolve(offset: number | undefined): DwarfType {
    if (offset === undefined) {
      return { kind: 'unresolved' };
    }
    const cached = this.cache.get(offset);
    if (cached) {
      return cached;
    }
    const die = this.dieByOffset.get(offset);
    if (!die) {
      return { kind: 'unresolved' };
    }
    const type = this.decode(die);
    this.cache.set(offset, type);
    return type;
  }

  /**
   * Peels typedef and cv-qualifier wrappers off `type` until an underlying type
   * is reached, stopping at any wrapper whose target ref is absent. A type that
   * is neither a typedef nor a qualifier is returned unchanged.
   */
  stripTypedefs(type: DwarfType): DwarfType {
    let current = type;
    // Guard against cyclic typedef/qualifier chains in malformed DWARF (e.g.
    // typedef A -> typedef B -> A): without this the loop would spin forever.
    const seen = new Set<number>();
    while (
      (current.kind === 'typedef' || current.kind === 'qualifier') &&
      current.targetRef !== undefined
    ) {
      if (seen.has(current.targetRef)) {
        break;
      }
      seen.add(current.targetRef);
      current = this.resolve(current.targetRef);
    }
    return current;
  }

  private decode(die: Die): DwarfType {
    switch (die.tag) {
      case DW_TAG_base_type:
        return {
          kind: 'base',
          name: dieName(die),
          encoding: dieUint(die, DW_AT_encoding),
          // A base type's size is either meaningful (positive) or absent; Rust's
          // zero-sized `()` unit type reports byte_size 0, which we normalize to
          // undefined so callers never see a zero-width base type.
          byteSize: dieUint(die, DW_AT_byte_size) || undefined,
        };
      case DW_TAG_pointer_type:
        return {
          kind: 'pointer',
          targetRef: dieRef(die, DW_AT_type),
          byteSize: dieUint(die, DW_AT_byte_size) ?? 4,
        };
      case DW_TAG_structure_type: {
        const variantPart = die.children.find((c) => c.tag === DW_TAG_variant_part);
        if (variantPart) {
          return this.decodeRustEnum(die, variantPart);
        }
        return {
          kind: 'struct',
          name: dieName(die),
          byteSize: dieUint(die, DW_AT_byte_size),
          members: members(die),
        };
      }
      case DW_TAG_union_type:
        return {
          kind: 'union',
          name: dieName(die),
          byteSize: dieUint(die, DW_AT_byte_size),
          members: members(die),
        };
      case DW_TAG_array_type:
        return {
          kind: 'array',
          elementRef: dieRef(die, DW_AT_type),
          count: arrayCount(die),
        };
      case DW_TAG_enumeration_type:
        return {
          kind: 'enum',
          name: dieName(die),
          byteSize: dieUint(die, DW_AT_byte_size),
          underlyingRef: dieRef(die, DW_AT_type),
          enumerators: die.children
            .filter((c) => c.tag === DW_TAG_enumerator)
            .map((c) => ({ name: dieName(c), value: dieUint(c, DW_AT_const_value) })),
        };
      case DW_TAG_typedef:
        return { kind: 'typedef', name: dieName(die), targetRef: dieRef(die, DW_AT_type) };
      case DW_TAG_const_type:
      case DW_TAG_volatile_type:
        return { kind: 'qualifier', targetRef: dieRef(die, DW_AT_type) };
      default:
        return { kind: 'unresolved', tag: die.tag };
    }
  }

  private decodeRustEnum(die: Die, variantPart: Die): RustEnumType {
    let discr: Discr | undefined;
    const discrRef = dieRef(variantPart, DW_AT_discr);
    if (discrRef !== undefined) {
      const discrDie = this.dieByOffset.get(discrRef);
      if (discrDie) {
        discr = { offset: memberOffset(discrDie), typeRef: dieRef(discrDie, DW_AT_type) };
      }
    }
    const variants: Variant[] = variantPart.children
      .filter((c) => c.tag === DW_TAG_variant)
      .map((v) => {
        const payload = v.children.find((c) => c.tag === DW_TAG_member);
        return {
          discrValue: dieUint(v, DW_AT_discr_value),
          member: payload ? buildMember(payload) : { offset: 0 },
        };
      });
    return {
      kind: 'rustEnum',
      name: dieName(die),
      byteSize: dieUint(die, DW_AT_byte_size),
      discr,
      variants,
    };
  }
}

/** Builds the `Member` descriptors for every `DW_TAG_member` child of `die`. */
function members(die: Die): Member[] {
  return die.children.filter((c) => c.tag === DW_TAG_member).map(buildMember);
}

/** One member DIE -> `{ name, typeRef, offset }`. */
function buildMember(die: Die): Member {
  return { name: dieName(die), typeRef: dieRef(die, DW_AT_type), offset: memberOffset(die) };
}

/**
 * The byte offset of a member from its `DW_AT_data_member_location`, which is
 * either a plain constant or an exprloc. Only the common single
 * `DW_OP_plus_uconst <n>` exprloc is decoded; any other expression (or an absent
 * location) yields 0.
 */
function memberOffset(die: Die): number {
  const loc = die.attrs.get(DW_AT_data_member_location);
  if (!loc) {
    return 0;
  }
  if (loc.kind === 'uint' || loc.kind === 'int') {
    return loc.value;
  }
  if (loc.kind === 'block' && loc.value.length >= 1 && loc.value[0] === DW_OP_plus_uconst) {
    return new Cursor(loc.value.subarray(1)).uleb();
  }
  return 0;
}

/**
 * The element count of an array from its `subrange_type` child: `DW_AT_count`
 * directly, else `DW_AT_upper_bound + 1`, else `undefined`.
 */
function arrayCount(die: Die): number | undefined {
  const sub = die.children.find((c) => c.tag === DW_TAG_subrange_type);
  if (!sub) {
    return undefined;
  }
  const count = dieUint(sub, DW_AT_count);
  if (count !== undefined) {
    return count;
  }
  const upper = dieUint(sub, DW_AT_upper_bound);
  return upper === undefined ? undefined : upper + 1;
}
