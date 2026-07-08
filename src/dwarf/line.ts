/**
 * DWARF line-program parser for ONE unit at a given offset in `.debug_line`:
 * decodes the v4 or v5 unit header (directory and file-name tables included)
 * and runs the line-number state machine over the program bytes, emitting one
 * row per matrix entry. Header-only units (header_length consumes the whole
 * unit) yield zero rows.
 *
 * Addresses are whatever the producer wrote; on this target (rustc for
 * wasm32v1-none) they are code-section-payload-relative offsets.
 *
 * Pure module (no `vscode` imports, no external deps).
 */

import { Cursor, DwarfParseError } from './cursor';
import { skipByForm, stringAt } from './info';
import * as C from './constants';

/** One row of the line-number matrix. */
export interface LineRow {
  address: number;
  fileIndex: number;
  line: number;
  column: number;
  isStmt: boolean;
  endSequence: boolean;
}

/** One entry of a unit's file-name table. */
export interface LineProgramFile {
  name: string;
  dirIndex: number;
}

/** A decoded line-program unit. */
export interface LineProgramUnit {
  version: number;
  /** Offset just past this unit in the section (start of the next unit). */
  endOffset: number;
  /**
   * Directory table, directly indexable by a file entry's `dirIndex` for both
   * versions: for v4 the reserved index 0 is stored as '' (the compilation
   * directory); v5 tables are 0-based as written.
   */
  directories: string[];
  /**
   * File-name table, directly indexable by a row's `fileIndex` for both
   * versions: for v4 the reserved index 0 is stored as a placeholder with an
   * empty name (the unit's primary file); v5 tables are 0-based as written.
   */
  files: LineProgramFile[];
  rows: LineRow[];
}

/** String sections backing strp/line_strp forms in v5 headers. */
export interface LineProgramAux {
  str?: Uint8Array;
  lineStr?: Uint8Array;
}

/**
 * Parses the line-program unit starting at `offset` in a `.debug_line`
 * section. Throws DwarfParseError on unsupported versions or malformed data.
 */
export function parseLineProgram(section: Uint8Array, offset: number, aux: LineProgramAux = {}): LineProgramUnit {
  const lengthCursor = new Cursor(section.subarray(offset));
  const unitLength = lengthCursor.initialLength();
  const endOffset = offset + lengthCursor.pos + unitLength;
  if (endOffset > section.length) {
    throw new DwarfParseError(`line-program unit at offset ${offset} extends past the section`);
  }
  const unit = lengthCursor.sub(unitLength);

  const version = unit.u16();
  if (version !== 4 && version !== 5) {
    throw new DwarfParseError(`unsupported .debug_line version ${version} (expected 4 or 5)`);
  }
  let addressSize = 4;
  if (version === 5) {
    addressSize = unit.u8();
    unit.u8(); // segment_selector_size
  }
  const headerLength = unit.u32();
  const programStart = unit.pos + headerLength;
  if (programStart > unitLength) {
    throw new DwarfParseError(`line-program header at offset ${offset} extends past its unit`);
  }

  const minInstLength = unit.u8();
  unit.u8(); // maximum_operations_per_instruction (VLIW; 1 on this target)
  const defaultIsStmt = unit.u8() !== 0;
  const lineBase = toSigned8(unit.u8());
  const lineRange = unit.u8();
  const opcodeBase = unit.u8();
  const standardOpcodeLengths: number[] = [];
  for (let i = 1; i < opcodeBase; i++) {
    standardOpcodeLengths.push(unit.u8());
  }

  const { directories, files } =
    version === 4 ? parseV4Tables(unit) : parseV5Tables(unit, aux, addressSize);

  if (unit.pos > programStart) {
    throw new DwarfParseError(`line-program tables at offset ${offset} overrun header_length`);
  }
  unit.skip(programStart - unit.pos);

  const rows = runStateMachine(unit, {
    minInstLength,
    defaultIsStmt,
    lineBase,
    lineRange,
    opcodeBase,
    standardOpcodeLengths,
  });

  return { version, endOffset, directories, files, rows };
}

/** v4 tables: NUL-terminated lists; index 0 is reserved for the comp dir / primary file. */
function parseV4Tables(unit: Cursor): { directories: string[]; files: LineProgramFile[] } {
  const directories: string[] = [''];
  for (;;) {
    const dir = unit.cstring();
    if (dir === '') {
      break;
    }
    directories.push(dir);
  }
  const files: LineProgramFile[] = [{ name: '', dirIndex: 0 }];
  for (;;) {
    const name = unit.cstring();
    if (name === '') {
      break;
    }
    const dirIndex = unit.uleb();
    unit.uleb(); // mtime
    unit.uleb(); // size
    files.push({ name, dirIndex });
  }
  return { directories, files };
}

/** v5 tables: entry-format-driven; 0-based, entry 0 is the primary file. */
function parseV5Tables(
  unit: Cursor,
  aux: LineProgramAux,
  addressSize: number,
): { directories: string[]; files: LineProgramFile[] } {
  const readEntries = (): LineProgramFile[] => {
    const formatCount = unit.u8();
    const formats: Array<{ contentType: number; form: number }> = [];
    for (let i = 0; i < formatCount; i++) {
      formats.push({ contentType: unit.uleb(), form: unit.uleb() });
    }
    const count = unit.uleb();
    const entries: LineProgramFile[] = [];
    for (let i = 0; i < count; i++) {
      const entry: LineProgramFile = { name: '', dirIndex: 0 };
      for (const { contentType, form } of formats) {
        if (contentType === C.DW_LNCT_path) {
          entry.name = readPath(unit, form, aux, addressSize);
        } else if (contentType === C.DW_LNCT_directory_index) {
          entry.dirIndex = readDirectoryIndex(unit, form);
        } else {
          skipByForm(unit, form, addressSize);
        }
      }
      entries.push(entry);
    }
    return entries;
  };
  const directories = readEntries().map((e) => e.name);
  const files = readEntries();
  return { directories, files };
}

function readPath(unit: Cursor, form: number, aux: LineProgramAux, addressSize: number): string {
  switch (form) {
    case C.DW_FORM_string:
      return unit.cstring();
    case C.DW_FORM_strp:
      return stringAt(aux.str, unit.u32()) ?? '';
    case C.DW_FORM_line_strp:
      return stringAt(aux.lineStr, unit.u32()) ?? '';
    default:
      skipByForm(unit, form, addressSize);
      return '';
  }
}

function readDirectoryIndex(unit: Cursor, form: number): number {
  switch (form) {
    case C.DW_FORM_data1:
      return unit.u8();
    case C.DW_FORM_data2:
      return unit.u16();
    case C.DW_FORM_udata:
      return unit.uleb();
    default:
      throw new DwarfParseError(`unsupported directory-index form 0x${form.toString(16)}`);
  }
}

interface StateMachineParams {
  minInstLength: number;
  defaultIsStmt: boolean;
  lineBase: number;
  lineRange: number;
  opcodeBase: number;
  standardOpcodeLengths: number[];
}

/** Runs the line-number program from the cursor's position to its end. */
function runStateMachine(program: Cursor, params: StateMachineParams): LineRow[] {
  const rows: LineRow[] = [];
  let address = 0;
  let file = 1;
  let line = 1;
  let column = 0;
  let isStmt = params.defaultIsStmt;

  const emit = (endSequence: boolean): void => {
    rows.push({ address, fileIndex: file, line, column, isStmt, endSequence });
  };
  const resetRegisters = (): void => {
    address = 0;
    file = 1;
    line = 1;
    column = 0;
    isStmt = params.defaultIsStmt;
  };

  while (!program.atEnd) {
    const opcode = program.u8();
    if (opcode >= params.opcodeBase) {
      // Special opcode: advances address and line, then emits a row.
      const adjusted = opcode - params.opcodeBase;
      address += Math.floor(adjusted / params.lineRange) * params.minInstLength;
      line += params.lineBase + (adjusted % params.lineRange);
      emit(false);
    } else if (opcode === 0) {
      // Extended opcode: length-prefixed, so unknown ones are skippable.
      const length = program.uleb();
      const body = program.sub(length);
      const extOpcode = length > 0 ? body.u8() : 0;
      if (extOpcode === C.DW_LNE_end_sequence) {
        emit(true);
        resetRegisters();
      } else if (extOpcode === C.DW_LNE_set_address) {
        address = readUintLE(body, body.remaining);
      }
      // Everything else (define_file, vendor extensions) is skipped: `body`
      // is bounded, and the outer cursor already sits past it.
    } else {
      switch (opcode) {
        case C.DW_LNS_copy:
          emit(false);
          break;
        case C.DW_LNS_advance_pc:
          address += program.uleb() * params.minInstLength;
          break;
        case C.DW_LNS_advance_line:
          line += program.sleb();
          break;
        case C.DW_LNS_set_file:
          file = program.uleb();
          break;
        case C.DW_LNS_set_column:
          column = program.uleb();
          break;
        case C.DW_LNS_negate_stmt:
          isStmt = !isStmt;
          break;
        case C.DW_LNS_const_add_pc:
          address += Math.floor((255 - params.opcodeBase) / params.lineRange) * params.minInstLength;
          break;
        case C.DW_LNS_fixed_advance_pc:
          address += program.u16();
          break;
        default: {
          // Standard opcode with no state we track (set_basic_block,
          // set_prologue_end, set_epilogue_begin, set_isa) or one unknown to
          // this parser: skip its operands per standard_opcode_lengths.
          const argCount = params.standardOpcodeLengths[opcode - 1] ?? 0;
          for (let i = 0; i < argCount; i++) {
            program.uleb();
          }
          break;
        }
      }
    }
  }
  return rows;
}

/** Little-endian unsigned integer of `n` bytes (n <= 6 stays exact). */
function readUintLE(cursor: Cursor, n: number): number {
  let value = 0;
  for (let i = 0; i < n; i++) {
    value += cursor.u8() * 2 ** (8 * i);
  }
  return value;
}

function toSigned8(byte: number): number {
  return byte >= 0x80 ? byte - 0x100 : byte;
}
