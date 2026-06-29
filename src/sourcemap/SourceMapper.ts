/**
 * The seam between an execution trace and what the user sees in the editor.
 *
 * komet-node traces carry only a wasm byte offset (`pos`) per instruction — no
 * source line. A SourceMapper decides what document to display while debugging
 * and how to translate between trace positions and lines in that document:
 *
 *   - v1 (TraceListingSource): render the trace itself, one line per executed
 *     instruction. Always correct, needs no wasm/DWARF tooling. Good enough to
 *     ship instruction-level stepping.
 *   - M4 (WatSourceMapper): disassemble the wasm code section to WAT and map
 *     `pos` <-> WAT line.
 *   - M5 (DwarfSourceMapper): use embedded DWARF to map `pos` -> Rust file:line.
 *
 * The debug adapter only ever talks to this interface in terms of *trace
 * indices* (its cursor). How an index becomes a line is the mapper's business,
 * so swapping mappers never touches the adapter.
 *
 * Pure module (no `vscode` imports).
 */

import { TraceModel } from '../debugAdapter/TraceModel';

export interface VirtualDocument {
  /** Stable identifier used as the DAP Source name / virtual-doc key. */
  name: string;
  /** Language id for syntax highlighting (e.g. 'soroban-wat'). */
  languageId: string;
  /** Full text of the document. */
  content: string;
}

export interface SourceLocation {
  /** 1-based line number within the virtual document. */
  line: number;
  /** Optional 1-based column. */
  column?: number;
}

export interface SourceMapper {
  /** The document to display for this trace. */
  getDocument(): VirtualDocument;
  /** Where to position the caret for the record at `index`. */
  locationForIndex(index: number): SourceLocation | null;
  /** Which trace indices a breakpoint on `line` (1-based) should cover. */
  indicesForLine(line: number): number[];
}

/**
 * v1 mapper: the displayed document is a human-readable listing of the trace,
 * one line per record. Line N corresponds to trace index N-1, so mapping is a
 * trivial bijection and breakpoints land exactly on the instruction shown.
 */
export class TraceListingSource implements SourceMapper {
  private readonly model: TraceModel;
  private readonly docName: string;

  constructor(model: TraceModel, docName = 'trace.komet') {
    this.model = model;
    this.docName = docName;
  }

  getDocument(): VirtualDocument {
    const lines = this.model.records.map((rec, i) => {
      const posText = rec.pos === null ? '----' : `0x${rec.pos.toString(16).padStart(4, '0')}`;
      const instrText = rec.instr.map((t) => String(t)).join(' ');
      return `${String(i).padStart(6, ' ')}  ${posText}  ${instrText}`;
    });
    return {
      name: this.docName,
      languageId: 'soroban-wat',
      content: lines.join('\n') + (lines.length ? '\n' : ''),
    };
  }

  locationForIndex(index: number): SourceLocation | null {
    if (index < 0 || index >= this.model.length) {
      return null;
    }
    return { line: index + 1 };
  }

  indicesForLine(line: number): number[] {
    const index = line - 1;
    if (index < 0 || index >= this.model.length) {
      return [];
    }
    return [index];
  }
}
