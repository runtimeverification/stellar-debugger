/**
 * Static wasm disassembly indexed by CODE OFFSET — the byte offset of an
 * instruction relative to the code section's payload. This is the canonical
 * address space of the debugger: komet's `pos` for function code and DWARF
 * line-table addresses both live in it (established empirically by
 * scripts/verify-addresses.mjs).
 *
 * Two constructors: `fromWasm` disassembles the real binary with wasmparser
 * (full instruction stream, raw bytes); `fromTrace` degrades to the executed
 * instructions of a trace when no wasm is available (rawTrace replay).
 *
 * Pure module (no `vscode` imports) so it can be unit-tested in plain Node.
 */

import { BinaryReader } from 'wasmparser';
import { WasmDisassembler } from 'wasmparser/dist/cjs/WasmDis';
import { parseWasmSections, WasmFormatError } from './sections';
import { renderInstr } from '../komet/mnemonics';
import { TraceModel } from '../debugAdapter/TraceModel';
import { FunctionRange } from '../debugAdapter/stops';

/** One disassembled instruction. */
export interface WasmInstruction {
  /** Code offset (code-section-payload-relative) of the instruction's first byte. */
  address: number;
  /** Instruction text, e.g. 'i64.const 255'. */
  text: string;
  /**
   * Raw bytes from `address` to the next instruction (or the enclosing
   * function body's end), when known. May share the underlying buffer with the
   * input wasm. Absent for trace-derived disassemblies.
   */
  bytes?: Uint8Array;
}

export class Disassembly {
  /** Instructions sorted by address, strictly increasing (constructor-enforced). */
  readonly instructions: readonly WasmInstruction[];
  /**
   * Function bodies in code-offset space, sorted and disjoint — the input to
   * call-depth reconstruction (debugAdapter/stops.ts). Empty for trace-derived
   * disassemblies, which carry no function structure.
   */
  readonly functionRanges: readonly FunctionRange[];

  private constructor(instructions: WasmInstruction[], functionRanges: FunctionRange[]) {
    for (let i = 1; i < instructions.length; i++) {
      if (instructions[i].address <= instructions[i - 1].address) {
        throw new Error(
          `disassembly addresses not strictly increasing: ` +
            `${instructions[i - 1].address} then ${instructions[i].address}`,
        );
      }
    }
    this.instructions = instructions;
    this.functionRanges = functionRanges.sort((a, b) => a.start - b.start);
  }

  /**
   * Disassemble a wasm binary. Every wasmparser line whose offset falls inside
   * a function body range is an instruction (the other lines are module/type/
   * func headers and closing parens); file offsets are converted to code
   * offsets by subtracting the code section's payload start. Throws
   * WasmFormatError when the module has no code section.
   */
  static fromWasm(bytes: Uint8Array): Disassembly {
    const { codeSection } = parseWasmSections(bytes);
    if (!codeSection) {
      throw new WasmFormatError('wasm module has no code section');
    }

    const reader = new BinaryReader();
    const data = new ArrayBuffer(bytes.length);
    new Uint8Array(data).set(bytes);
    reader.setData(data, 0, bytes.length);
    const disassembler = new WasmDisassembler();
    disassembler.addOffsets = true;
    disassembler.disassembleChunk(reader);
    const { lines, offsets, functionBodyOffsets } = disassembler.getResult();
    if (!offsets || !functionBodyOffsets) {
      throw new WasmFormatError('wasmparser did not report offsets');
    }

    // File offset + text + enclosing body end, for the in-body lines only.
    const pending: { fileOffset: number; text: string; bodyEnd: number }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const fileOffset = offsets[i];
      const body = functionBodyOffsets.find((b) => fileOffset >= b.start && fileOffset < b.end);
      if (body) {
        pending.push({ fileOffset, text: lines[i].trim(), bodyEnd: body.end });
      }
    }
    pending.sort((a, b) => a.fileOffset - b.fileOffset);

    const instructions = pending.map((p, i): WasmInstruction => {
      const next = pending[i + 1];
      const end = next && next.fileOffset <= p.bodyEnd ? next.fileOffset : p.bodyEnd;
      return {
        address: p.fileOffset - codeSection.payloadStart,
        text: p.text,
        bytes: bytes.subarray(p.fileOffset, end),
      };
    });
    const functionRanges = functionBodyOffsets.map(
      (b): FunctionRange => ({
        start: b.start - codeSection.payloadStart,
        end: b.end - codeSection.payloadStart,
      }),
    );
    return new Disassembly(instructions, functionRanges);
  }

  /**
   * Degraded fallback for wasm-less replay: one instruction per unique
   * non-null `pos` in the trace, text rendered from the komet instr array, no
   * raw bytes. Positions from different address spaces can collide (global
   * initializers vs function code); the FIRST record at a pos wins.
   */
  static fromTrace(model: TraceModel): Disassembly {
    const byPos = new Map<number, WasmInstruction>();
    for (const record of model.records) {
      if (record.pos !== null && !byPos.has(record.pos)) {
        byPos.set(record.pos, { address: record.pos, text: renderInstr(record.instr) });
      }
    }
    const instructions = [...byPos.values()].sort((a, b) => a.address - b.address);
    return new Disassembly(instructions, []);
  }

  /**
   * Index of the instruction containing `addr`: the greatest i with
   * instructions[i].address <= addr. Returns -1 when `addr` precedes the first
   * instruction or the disassembly is empty.
   */
  indexForAddress(addr: number): number {
    let lo = 0;
    let hi = this.instructions.length - 1;
    let result = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.instructions[mid].address <= addr) {
        result = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return result;
  }
}
