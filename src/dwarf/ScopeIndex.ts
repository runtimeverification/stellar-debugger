/**
 * Maps a current PC (a validated `.debug_info` code offset) to its enclosing
 * function and the Rust variables/parameters in scope there.
 *
 * Built over the DIE trees produced by `parseDebugInfo` (M2), it records every
 * `DW_TAG_subprogram` that carries a code range — either a contiguous
 * `[low_pc, low_pc + high_pc)` (on this target `DW_AT_high_pc` is a SIZE, read as
 * a uint) or a `DW_AT_ranges` rangelist into `.debug_ranges`. Contiguous
 * functions are kept sorted by `low_pc` for binary search; the rare rangelist
 * functions are checked linearly.
 *
 * `variablesInScope` yields the raw material the value layer (M6+) needs: each
 * variable's type ref, its location (an inline exprloc OR a `.debug_loc`
 * offset), and the enclosing subprogram's frame-base expression. Nested
 * `DW_TAG_lexical_block` scopes are entered only when their own range covers the
 * PC, and inner declarations are appended after outer ones so callers may treat
 * later entries as shadowing.
 *
 * Pure module (no `vscode` and no `src/wasm` imports). The optional
 * `nameFallback` lets the wiring layer supply a disassembly-derived name for an
 * anonymous subprogram without coupling this module to it.
 */

import { Cursor } from './cursor';
import { DebugInfo, Die, dieName, dieUint, dieRef } from './die';
import {
  DW_TAG_subprogram,
  DW_TAG_formal_parameter,
  DW_TAG_variable,
  DW_TAG_lexical_block,
  DW_AT_low_pc,
  DW_AT_high_pc,
  DW_AT_ranges,
  DW_AT_location,
  DW_AT_type,
  DW_AT_frame_base,
} from './constants';

/** One in-scope variable or parameter, with the raw material for value decoding. */
export interface ScopeVar {
  name?: string;
  /** DW_AT_type absolute offset (feed to a TypeRegistry). */
  typeRef?: number;
  /** DW_AT_location when it is an exprloc (`AttrValue` 'block'). */
  locationExpr?: Uint8Array;
  /** DW_AT_location when it is a `.debug_loc` offset (`AttrValue` 'uint', from sec_offset). */
  locListOffset?: number;
  /** The enclosing subprogram's DW_AT_frame_base exprloc bytes. */
  frameBaseExpr?: Uint8Array;
  /** The owning CU's DW_AT_low_pc — the `.debug_loc` base address default. */
  cuLowPc?: number;
  /** True when the DIE has NO DW_AT_location at all. */
  optimizedOut: boolean;
  /** formal_parameter (true) vs variable (false). */
  isParam: boolean;
}

/** An enclosing function located by PC. */
export interface FunctionScope {
  die: Die;
  name?: string;
  /** From DW_AT_frame_base, when it is an exprloc. */
  frameBaseExpr?: Uint8Array;
}

/** A recorded subprogram: its public scope plus the internal range material. */
interface RecordedFn extends FunctionScope {
  /** Contiguous `[low, low + high)` range, when the subprogram has one. */
  lowHigh?: [number, number];
  /** Offset into `.debug_ranges`, when the subprogram uses a rangelist. */
  rangesOffset?: number;
  /** The CU's DW_AT_low_pc — the rangelist base default. */
  cuLowPc: number;
}

/** The DIE's `at` attribute bytes when it is an exprloc/block, else undefined. */
function exprBytes(die: Die, at: number): Uint8Array | undefined {
  const value = die.attrs.get(at);
  return value && value.kind === 'block' ? value.value : undefined;
}

/**
 * `.debug_ranges` (v4) cover test: iterate `(begin, end)` 4-byte pairs from
 * `offset`. `(0, 0)` terminates; `begin === 0xffffffff` is a base-selection entry
 * that sets `base = end`; otherwise the covered range is `[base + begin, base + end)`.
 * `base` starts at `cuLowPc`. Returns true if any range covers `pc`.
 */
function rangesCover(debugRanges: Uint8Array, offset: number, pc: number, cuLowPc: number): boolean {
  const cursor = new Cursor(debugRanges);
  cursor.skip(offset);
  let base = cuLowPc;
  for (;;) {
    const begin = cursor.u32();
    const end = cursor.u32();
    if (begin === 0 && end === 0) {
      return false; // End-of-list terminator.
    }
    if (begin === 0xffffffff) {
      base = end; // Base-selection entry.
      continue;
    }
    if (pc >= base + begin && pc < base + end) {
      return true;
    }
  }
}

export class ScopeIndex {
  /** Contiguous-range subprograms, sorted ascending by `lowHigh[0]`. */
  private readonly contiguous: RecordedFn[] = [];
  /** Rangelist subprograms (rare at -O0), checked linearly. */
  private readonly ranged: RecordedFn[] = [];

  constructor(
    info: DebugInfo,
    private readonly debugRanges?: Uint8Array,
    private readonly nameFallback?: (pc: number) => string | undefined,
  ) {
    for (const unit of info.units) {
      const cuLowPc = dieUint(unit.die, DW_AT_low_pc) ?? 0;
      this.indexTree(unit.die, cuLowPc);
    }
    this.contiguous.sort((a, b) => a.lowHigh![0] - b.lowHigh![0]);
  }

  /** Walks a DIE subtree, recording every subprogram that carries a code range. */
  private indexTree(die: Die, cuLowPc: number): void {
    if (die.tag === DW_TAG_subprogram) {
      this.record(die, cuLowPc);
    }
    for (const child of die.children) {
      this.indexTree(child, cuLowPc);
    }
  }

  private record(die: Die, cuLowPc: number): void {
    const rec: RecordedFn = {
      die,
      name: dieName(die),
      frameBaseExpr: exprBytes(die, DW_AT_frame_base),
      cuLowPc,
    };
    const low = dieUint(die, DW_AT_low_pc);
    const high = dieUint(die, DW_AT_high_pc);
    if (low !== undefined && high !== undefined) {
      rec.lowHigh = [low, low + high];
      this.contiguous.push(rec);
      return;
    }
    const rangesOffset = dieUint(die, DW_AT_ranges);
    if (rangesOffset !== undefined) {
      rec.rangesOffset = rangesOffset;
      this.ranged.push(rec);
    }
    // Otherwise the subprogram has no code range (e.g. a declaration); skip it.
  }

  /** The recorded subprogram whose range covers `pc`, or null. */
  private recordAt(pc: number): RecordedFn | null {
    // Binary search the sorted, non-overlapping contiguous ranges.
    let lo = 0;
    let hi = this.contiguous.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const rec = this.contiguous[mid];
      const [low, high] = rec.lowHigh!;
      if (pc < low) {
        hi = mid - 1;
      } else if (pc >= high) {
        lo = mid + 1;
      } else {
        return rec;
      }
    }
    // Fall back to the rare rangelist subprograms.
    if (this.debugRanges) {
      for (const rec of this.ranged) {
        if (rec.rangesOffset !== undefined && rangesCover(this.debugRanges, rec.rangesOffset, pc, rec.cuLowPc)) {
          return rec;
        }
      }
    }
    return null;
  }

  /** Whether at least one subprogram carrying a code range was indexed. */
  hasFunctions(): boolean {
    return this.contiguous.length > 0 || this.ranged.length > 0;
  }

  /** The enclosing function at `pc`, or null. */
  functionAt(pc: number): FunctionScope | null {
    return this.recordAt(pc);
  }

  /** The function's DIE name, else the `nameFallback` value, else null. */
  functionNameAt(pc: number): string | null {
    const fn = this.recordAt(pc);
    if (fn && fn.name !== undefined) {
      return fn.name;
    }
    return this.nameFallback?.(pc) ?? null;
  }

  /** The parameters and variables in scope at `pc` (empty if no enclosing function). */
  variablesInScope(pc: number): ScopeVar[] {
    const fn = this.recordAt(pc);
    if (!fn) {
      return [];
    }
    const out: ScopeVar[] = [];
    this.collect(fn.die, pc, fn.frameBaseExpr, fn.cuLowPc, out);
    return out;
  }

  /**
   * Collects in-scope variable DIEs under `scope`: its direct params/variables
   * always apply; a `DW_TAG_lexical_block` child is entered only when its own
   * range covers `pc`, with inner declarations appended after outer ones.
   */
  private collect(scope: Die, pc: number, frameBaseExpr: Uint8Array | undefined, cuLowPc: number, out: ScopeVar[]): void {
    for (const child of scope.children) {
      if (child.tag === DW_TAG_formal_parameter || child.tag === DW_TAG_variable) {
        const sv = this.toScopeVar(child, frameBaseExpr, cuLowPc);
        if (sv) {
          out.push(sv);
        }
      } else if (child.tag === DW_TAG_lexical_block && this.blockCovers(child, pc, cuLowPc)) {
        this.collect(child, pc, frameBaseExpr, cuLowPc, out);
      }
    }
  }

  /** Whether a lexical block's range covers `pc` (a block with no range covers its parent). */
  private blockCovers(block: Die, pc: number, cuLowPc: number): boolean {
    const low = dieUint(block, DW_AT_low_pc);
    const high = dieUint(block, DW_AT_high_pc);
    if (low !== undefined && high !== undefined) {
      return pc >= low && pc < low + high;
    }
    const rangesOffset = dieUint(block, DW_AT_ranges);
    if (rangesOffset !== undefined) {
      return this.debugRanges ? rangesCover(this.debugRanges, rangesOffset, pc, cuLowPc) : false;
    }
    return true; // No range info: the block applies to the whole enclosing scope.
  }

  /** Maps a variable/parameter DIE to a `ScopeVar`, or null for a nameless, location-less artifact. */
  private toScopeVar(die: Die, frameBaseExpr: Uint8Array | undefined, cuLowPc: number): ScopeVar | null {
    const name = dieName(die);
    const location = die.attrs.get(DW_AT_location);
    if (name === undefined && location === undefined) {
      return null; // A pure artifact with nothing to show.
    }
    const sv: ScopeVar = {
      name,
      typeRef: dieRef(die, DW_AT_type),
      frameBaseExpr,
      cuLowPc,
      optimizedOut: location === undefined,
      isParam: die.tag === DW_TAG_formal_parameter,
    };
    if (location) {
      if (location.kind === 'block') {
        sv.locationExpr = location.value;
      } else if (location.kind === 'uint') {
        sv.locListOffset = location.value;
      }
    }
    return sv;
  }
}
