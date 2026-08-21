/**
 * Capability interface for the source-level view of a PC: which function it is
 * in, which Rust frames were inlined into it, which variables are in scope, and
 * what their runtime values are. It mirrors the `SourceMapper`/`NullSourceMapper`
 * split — `NullVariableResolver` is the degraded no-DWARF path (every query is
 * empty), `DwarfVariableResolver` drives the real pipeline: `ScopeIndex` locates
 * the enclosing function, its inlined instances and their variables,
 * `selectLocation`/`evalLocation` resolve where each value lives, and
 * `decodeValue` renders it against the `TypeRegistry`.
 *
 * Frames live here rather than in a separate resolver because they are the same
 * DWARF lookup: an inlined frame IS a scope, carrying its own name, call site and
 * declarations (docs/callstack.md, C2). What this layer adds over the raw
 * `ScopeIndex` is resolution of a call site's line-program FILE INDEX into a
 * path, which needs the line table alongside `.debug_info`.
 *
 * Pure module (no `vscode` imports, no external deps).
 */

import { InlineScope, ScopeVar } from '../dwarf/ScopeIndex';
import { RuntimeState, evalLocation } from '../dwarf/locexpr';
import { DecodedValue, decodeValue } from '../dwarf/ValueDecoder';
import { selectLocation } from '../dwarf/debugLoc';
import { DwarfDebugInfo } from '../dwarf/DebugInfo';
import { DwarfLineTable } from '../dwarf/LineTable';

/** One Rust frame that was inlined into the function containing the PC. */
export interface InlineFrame {
  /** The inlined function's name, or undefined when DWARF names it nowhere. */
  name?: string;
  /**
   * Where the inlined call was written — the position of the frame directly
   * BELOW this one. Absent when DWARF states no call site or names a file this
   * table cannot resolve.
   */
  callSite?: { path: string; line: number; column?: number };
  /** The parameters and variables this frame declares, in scope at the PC. */
  variables: ScopeVar[];
}

export interface VariableResolver {
  hasVariables(): boolean;
  functionNameAt(pc: number): string | null;
  /**
   * The enclosing function's name qualified by its DWARF namespaces and types
   * (`control::__while_call::invoke_raw`), or null. This is the frame label;
   * `functionNameAt` is the bare DIE name.
   */
  qualifiedFunctionNameAt(pc: number): string | null;
  /** Rust frames inlined into the function at `pc`, OUTERMOST first. */
  inlineFramesAt(pc: number): InlineFrame[];
  variablesInScope(pc: number): ScopeVar[];
  decodeVariable(v: ScopeVar, state: RuntimeState, pc: number): DecodedValue;
}

/** The degraded path: no DWARF, so nothing to resolve. */
export class NullVariableResolver implements VariableResolver {
  hasVariables(): boolean {
    return false;
  }
  functionNameAt(): string | null {
    return null;
  }
  qualifiedFunctionNameAt(): string | null {
    return null;
  }
  inlineFramesAt(): InlineFrame[] {
    return [];
  }
  variablesInScope(): ScopeVar[] {
    return [];
  }
  decodeVariable(): DecodedValue {
    return { display: '<unavailable>' };
  }
}

/** Resolves and decodes variables from a wasm module's DWARF debug info. */
export class DwarfVariableResolver implements VariableResolver {
  /**
   * `lineTable` is optional: without it inlined frames still resolve, they just
   * report no call-site path (their file index cannot be looked up).
   */
  constructor(
    private readonly dwarf: DwarfDebugInfo,
    private readonly lineTable?: DwarfLineTable,
  ) {}

  hasVariables(): boolean {
    return this.dwarf.scopes.hasFunctions();
  }

  functionNameAt(pc: number): string | null {
    return this.dwarf.scopes.functionNameAt(pc);
  }

  qualifiedFunctionNameAt(pc: number): string | null {
    return this.dwarf.scopes.functionAt(pc)?.qualifiedName ?? null;
  }

  inlineFramesAt(pc: number): InlineFrame[] {
    return this.dwarf.scopes.inlineScopesAt(pc).map((scope) => this.toInlineFrame(scope));
  }

  variablesInScope(pc: number): ScopeVar[] {
    return this.dwarf.scopes.variablesInScope(pc);
  }

  /**
   * Resolves `v`'s location expression (inline exprloc or `.debug_loc` list),
   * evaluates it against `state`, and decodes the value at that location.
   * Degrades to a placeholder rather than throwing.
   */
  decodeVariable(v: ScopeVar, state: RuntimeState, pc: number): DecodedValue {
    try {
      let expr: Uint8Array | null;
      if (v.locationExpr) {
        expr = v.locationExpr;
      } else if (v.locListOffset !== undefined && this.dwarf.debugLoc) {
        expr = selectLocation(this.dwarf.debugLoc, v.locListOffset, pc, v.cuLowPc ?? 0);
      } else {
        return { display: '<optimized out>' };
      }
      if (!expr) {
        return { display: '<optimized out>' };
      }
      const loc = evalLocation(expr, v.frameBaseExpr, state);
      const type = this.dwarf.types.resolve(v.typeRef);
      return decodeValue(loc, type, state, this.dwarf.types);
    } catch {
      return { display: '<optimized out>' };
    }
  }

  /** One inline scope with its call-site file index resolved to a path. */
  private toInlineFrame(scope: InlineScope): InlineFrame {
    const frame: InlineFrame = { variables: scope.variables };
    if (scope.name !== undefined) {
      frame.name = scope.name;
    }
    const path =
      scope.stmtListOffset !== undefined && scope.callFileIndex !== undefined
        ? this.lineTable?.filePath(scope.stmtListOffset, scope.callFileIndex)
        : undefined;
    if (path !== undefined && scope.callLine !== undefined) {
      frame.callSite = { path, line: scope.callLine };
      if (scope.callColumn !== undefined) {
        frame.callSite.column = scope.callColumn;
      }
    }
    return frame;
  }
}
