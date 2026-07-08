/**
 * The no-source-info mapper: used when the wasm carries no (usable) DWARF or
 * none is available at all (wasm-less rawTrace replay). Every lookup answers
 * null, so frames carry no Source, source breakpoints never verify, and
 * stepping stays at instruction granularity.
 *
 * Pure module (no `vscode` imports).
 */

import { MappedLocation, ResolvedBreakpoint, SourceMapper } from './SourceMapper';

export class NullSourceMapper implements SourceMapper {
  hasLineInfo(): boolean {
    return false;
  }

  locationForIndex(_index: number): MappedLocation | null {
    return null;
  }

  locationForAddress(_codeOffset: number): MappedLocation | null {
    return null;
  }

  resolveBreakpoint(_path: string, _line: number): ResolvedBreakpoint | null {
    return null;
  }

  executedLines(_path: string, _fromLine: number, _toLine: number): number[] {
    return [];
  }

  lineKeyForIndex(_index: number): string | null {
    return null;
  }

  sourceTextForIndex(_index: number): string | null {
    return null;
  }
}
