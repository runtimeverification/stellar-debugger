/**
 * Maps a current PC (a validated `.debug_info` code offset) to its enclosing
 * function and the Rust variables/parameters in scope there.
 *
 * Built over the DIE trees produced by `parseDebugInfo`, it records every
 * `DW_TAG_subprogram` that carries a code range — either a contiguous
 * `[low_pc, low_pc + high_pc)` (on this target `DW_AT_high_pc` is a SIZE, read as
 * a uint) or a `DW_AT_ranges` rangelist into `.debug_ranges`. Contiguous
 * functions are kept sorted by `low_pc` for binary search; the rare rangelist
 * functions are checked linearly.
 *
 * `variablesInScope` yields the raw material the value layer needs: each
 * variable's type ref, its location (an inline exprloc OR a `.debug_loc`
 * offset), and the enclosing subprogram's frame-base expression. Nested
 * `DW_TAG_lexical_block` scopes are entered only when their own range covers the
 * PC, and inner declarations are appended after outer ones so callers may treat
 * later entries as shadowing.
 *
 * `inlineScopesAt` answers the other half of a call stack (docs/callstack.md,
 * C2): the chain of `DW_TAG_inlined_subroutine` instances covering the PC, which
 * is how the Rust call chain survives inlining. Optimization inlines whole
 * functions into one wasm body — `sum_triples` disappears into the
 * `#[contractimpl]` wrapper's — so without this chain a frame would be labelled
 * with the *host* function while the cursor sits on the *inlined* function's
 * source line. Each instance carries its own declarations and the call site it
 * was expanded at, which is what the frame BELOW it reports as its position.
 *
 * Pure module (no `vscode` and no `src/wasm` imports). The optional
 * `nameFallback` lets the wiring layer supply a disassembly-derived name for an
 * anonymous subprogram without coupling this module to it.
 */

import { Cursor } from './cursor';
import { DebugInfo, Die, dieName, dieUint, dieRef, dieString } from './die';
import {
  DW_TAG_subprogram,
  DW_TAG_formal_parameter,
  DW_TAG_variable,
  DW_TAG_lexical_block,
  DW_TAG_inlined_subroutine,
  DW_TAG_namespace,
  DW_TAG_structure_type,
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
  /**
   * `name` prefixed with the DIE's enclosing namespaces and types, e.g.
   * `control::__while_call::invoke_raw` — what a stack frame is labelled with.
   * Absent exactly when `name` is (rustc leaves some method DIEs anonymous).
   */
  qualifiedName?: string;
  /** From DW_AT_frame_base, when it is an exprloc. */
  frameBaseExpr?: Uint8Array;
}

/**
 * One `DW_TAG_inlined_subroutine` instance covering a PC: a Rust-level frame
 * that has no wasm activation record of its own.
 */
export interface InlineScope {
  /** Name of the inlined function, resolved through abstract origin / specification. */
  name?: string;
  /**
   * Where this inlined call was WRITTEN — a file index into the owning CU's
   * line program, plus line/column. It is the position of the frame directly
   * BELOW this one (its caller), not of this frame itself.
   */
  callFileIndex?: number;
  callLine?: number;
  callColumn?: number;
  /** The owning CU's DW_AT_stmt_list — which line program `callFileIndex` indexes. */
  stmtListOffset?: number;
  /** The parameters and variables this instance declares, in scope at the PC. */
  variables: ScopeVar[];
}

/** A recorded subprogram: its public scope plus the internal range material. */
interface RecordedFn extends FunctionScope {
  /** Contiguous `[low, low + high)` range, when the subprogram has one. */
  lowHigh?: [number, number];
  /** Offset into `.debug_ranges`, when the subprogram uses a rangelist. */
  rangesOffset?: number;
  /** The CU's DW_AT_low_pc — the rangelist base default. */
  cuLowPc: number;
  /** The CU's DW_AT_stmt_list, for resolving inlined call-site file indices. */
  stmtListOffset?: number;
}

/** LLVM writes this address for code the linker dropped; it is never a real PC. */
const TOMBSTONE = 0xffffffff;
/** Reference hops `resolvedName` follows before giving up. */
const MAX_NAME_HOPS = 4;

/** What the indexing walk carries down one compilation unit's DIE tree. */
interface UnitContext {
  cuLowPc: number;
  stmtListOffset?: number;
  /** Enclosing namespace and type names, outermost first. */
  scope: string[];
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
    private readonly info: DebugInfo,
    private readonly debugRanges?: Uint8Array,
    private readonly nameFallback?: (pc: number) => string | undefined,
  ) {
    for (const unit of info.units) {
      const cuLowPc = dieUint(unit.die, DW_AT_low_pc) ?? 0;
      this.indexTree(unit.die, { cuLowPc, stmtListOffset: dieUint(unit.die, DW_AT_stmt_list), scope: [] });
    }
    this.contiguous.sort((a, b) => a.lowHigh![0] - b.lowHigh![0]);
  }

  /**
   * Walks a DIE subtree, recording every subprogram that carries a code range.
   * `unit.scope` accumulates the enclosing namespace and type names so a
   * recorded function can report a qualified name.
   */
  private indexTree(die: Die, unit: UnitContext): void {
    if (die.tag === DW_TAG_subprogram) {
      this.record(die, unit);
    }
    const nests = die.tag === DW_TAG_namespace || die.tag === DW_TAG_structure_type;
    const inner: UnitContext =
      nests && dieName(die) !== undefined ? { ...unit, scope: [...unit.scope, dieName(die)!] } : unit;
    for (const child of die.children) {
      this.indexTree(child, inner);
    }
  }

  private record(die: Die, unit: UnitContext): void {
    const name = dieName(die);
    const rec: RecordedFn = {
      die,
      name,
      frameBaseExpr: exprBytes(die, DW_AT_frame_base),
      cuLowPc: unit.cuLowPc,
      stmtListOffset: unit.stmtListOffset,
    };
    if (name !== undefined) {
      rec.qualifiedName = [...unit.scope, name].join('::');
    }
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

  /**
   * The inlined subroutines covering `pc`, OUTERMOST first — the Rust frames
   * between the enclosing wasm function and the PC (docs/callstack.md, C2).
   * Empty when the PC is in no recorded function, or when nothing was inlined
   * there. An instance whose range this parser cannot read (a DWARF v5
   * `.debug_rnglists` list, or a `.debug_ranges` section that is absent) is
   * skipped rather than guessed at: a missing frame degrades the view, an
   * invented one misreports the program.
   */
  inlineScopesAt(pc: number): InlineScope[] {
    const fn = this.recordAt(pc);
    if (!fn) {
      return [];
    }
    const out: InlineScope[] = [];
    this.collectInlines(fn.die, pc, fn, out);
    return out;
  }

  /**
   * Collects the inlined-subroutine instances under `scope` that cover `pc`,
   * outermost first. A nested instance is a DEEPER frame, so it is appended
   * after its parent; lexical blocks are transparent (they are not frames).
   */
  private collectInlines(scope: Die, pc: number, fn: RecordedFn, out: InlineScope[]): void {
    for (const child of scope.children) {
      if (child.tag === DW_TAG_inlined_subroutine) {
        if (!this.rangeCovers(child, pc, fn.cuLowPc)) {
          continue;
        }
        out.push(this.toInlineScope(child, pc, fn));
        this.collectInlines(child, pc, fn, out);
      } else if (child.tag === DW_TAG_lexical_block && this.blockCovers(child, pc, fn.cuLowPc)) {
        this.collectInlines(child, pc, fn, out);
      }
    }
  }

  /** One inlined instance as a frame: its name, its call site, its own declarations. */
  private toInlineScope(die: Die, pc: number, fn: RecordedFn): InlineScope {
    const variables: ScopeVar[] = [];
    this.collect(die, pc, fn.frameBaseExpr, fn.cuLowPc, variables);
    const scope: InlineScope = { variables };
    const name = this.resolvedName(die);
    if (name !== undefined) {
      scope.name = name;
    }
    const callFileIndex = dieUint(die, DW_AT_call_file);
    if (callFileIndex !== undefined) {
      scope.callFileIndex = callFileIndex;
    }
    const callLine = dieUint(die, DW_AT_call_line);
    if (callLine !== undefined) {
      scope.callLine = callLine;
    }
    const callColumn = dieUint(die, DW_AT_call_column);
    if (callColumn !== undefined && callColumn > 0) {
      scope.callColumn = callColumn;
    }
    if (fn.stmtListOffset !== undefined) {
      scope.stmtListOffset = fn.stmtListOffset;
    }
    return scope;
  }

  /**
   * A DIE's own name, or the name of what it is an instance/declaration of:
   * `DW_AT_abstract_origin` (the out-of-line abstract subprogram an inlined
   * instance copies) and `DW_AT_specification` (the declaration a definition
   * completes) are followed in turn, since rustc puts the name on either. The
   * mangled `DW_AT_linkage_name` is the last resort. Bounded so a cyclic or
   * pathological reference chain cannot spin.
   */
  private resolvedName(die: Die, hops = 0): string | undefined {
    const name = dieName(die);
    if (name !== undefined) {
      return name;
    }
    if (hops < MAX_NAME_HOPS) {
      for (const at of [DW_AT_abstract_origin, DW_AT_specification]) {
        const ref = dieRef(die, at);
        const target = ref === undefined ? undefined : this.info.dieByOffset.get(ref);
        const resolved = target && this.resolvedName(target, hops + 1);
        if (resolved !== undefined) {
          return resolved;
        }
      }
    }
    return dieString(die, DW_AT_linkage_name);
  }

  /**
   * Whether the DIE's OWN code range covers `pc`. Unlike `blockCovers`, a DIE
   * with no readable range covers nothing: an inlined instance must be placed
   * by its range or not at all. A `low_pc` of 0xffffffff is LLVM's tombstone for
   * code the linker dropped, never a real address.
   */
  private rangeCovers(die: Die, pc: number, cuLowPc: number): boolean {
    const low = dieUint(die, DW_AT_low_pc);
    const high = dieUint(die, DW_AT_high_pc);
    if (low !== undefined && high !== undefined) {
      return low !== TOMBSTONE && pc >= low && pc < low + high;
    }
    const rangesOffset = dieUint(die, DW_AT_ranges);
    if (rangesOffset !== undefined && this.debugRanges) {
      return rangesCover(this.debugRanges, rangesOffset, pc, cuLowPc);
    }
    return false;
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
