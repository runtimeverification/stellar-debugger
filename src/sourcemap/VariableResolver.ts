/**
 * Capability interface for resolving in-scope variables at a PC and decoding
 * their runtime values, mirroring the `SourceMapper`/`NullSourceMapper` split.
 * `NullVariableResolver` is the degraded no-DWARF path (every query is empty);
 * `DwarfVariableResolver` drives the real pipeline: `ScopeIndex` locates the
 * enclosing function and its variables, `selectLocation`/`evalLocation` resolve
 * where each value lives, and `decodeValue` renders it against the `TypeRegistry`.
 *
 * Pure module (no `vscode` imports, no external deps).
 */

import { ScopeVar } from '../dwarf/ScopeIndex';
import { RuntimeState, evalLocation } from '../dwarf/locexpr';
import { DecodedValue, decodeValue } from '../dwarf/ValueDecoder';
import { selectLocation } from '../dwarf/debugLoc';
import { DwarfDebugInfo } from '../dwarf/DebugInfo';

export interface VariableResolver {
  hasVariables(): boolean;
  functionNameAt(pc: number): string | null;
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
  variablesInScope(): ScopeVar[] {
    return [];
  }
  decodeVariable(): DecodedValue {
    return { display: '<unavailable>' };
  }
}

/** Resolves and decodes variables from a wasm module's DWARF debug info. */
export class DwarfVariableResolver implements VariableResolver {
  constructor(private readonly dwarf: DwarfDebugInfo) {}

  hasVariables(): boolean {
    return this.dwarf.scopes.hasFunctions();
  }

  functionNameAt(pc: number): string | null {
    return this.dwarf.scopes.functionNameAt(pc);
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
}
