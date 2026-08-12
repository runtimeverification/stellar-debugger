/**
 * The Disassembly View presentation: a window of `DisassembledInstruction` rows
 * around a requested address, annotated with source locations from the mapper.
 *
 * Addresses are code offsets (see wasm/Disassembly), rendered as hex. A request
 * may reach outside the disassembly — VS Code scrolls a fixed-size window — so
 * out-of-range rows are emitted as inert `(invalid)` padding at synthetic
 * addresses that keep the response strictly increasing.
 *
 * Uses `@vscode/debugprotocol` for its wire types only; no `vscode` and no
 * runtime DAP dependency.
 */

import * as path from 'path';
import { DebugProtocol } from '@vscode/debugprotocol';
import { Disassembly } from '../wasm/Disassembly';
import { SourceMapper } from '../sourcemap/SourceMapper';

/** Hex form of a code offset; negatives (padding only) render as '-0x…'. */
export function formatAddress(n: number): string {
  return n < 0 ? '-0x' + (-n).toString(16) : '0x' + n.toString(16);
}

/**
 * Numeric value of a client-supplied memory reference. Our own references are
 * always '0x…', which parseInt(ref, 16) accepts; anything unparseable or
 * negative clamps to 0.
 */
export function parseAddress(reference: string): number {
  const n = parseInt(reference, 16);
  return Number.isNaN(n) || n < 0 ? 0 : n;
}

/**
 * The rows of one `disassemble` request: `args.instructionCount` instructions
 * starting `args.instructionOffset` from the instruction containing
 * `args.memoryReference + args.offset`.
 */
export function disassemblyRows(
  disassembly: Disassembly | undefined,
  source: SourceMapper | undefined,
  args: DebugProtocol.DisassembleArguments,
): DebugProtocol.DisassembledInstruction[] {
  const instructions = disassembly?.instructions ?? [];
  const base = parseAddress(args.memoryReference) + (args.offset ?? 0);
  const anchor = Math.max(0, disassembly?.indexForAddress(base) ?? 0);
  const start = anchor + (args.instructionOffset ?? 0);

  const rows: DebugProtocol.DisassembledInstruction[] = [];
  let previousPath: string | undefined;
  for (let i = start; i < start + args.instructionCount; i++) {
    if (i < 0 || i >= instructions.length) {
      rows.push({
        address: formatAddress(paddingAddress(i, i - start, instructions)),
        instruction: '(invalid)',
        presentationHint: 'invalid',
      });
      continue;
    }
    const instruction = instructions[i];
    const row: DebugProtocol.DisassembledInstruction = {
      address: formatAddress(instruction.address),
      instruction: instruction.text,
    };
    if (instruction.bytes !== undefined) {
      row.instructionBytes = [...instruction.bytes]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');
    }
    const loc = source?.locationForAddress(instruction.address);
    if (loc) {
      row.line = loc.line;
      if (loc.column !== undefined) {
        row.column = loc.column;
      }
      // DAP lets `location` be omitted while the file is unchanged from the
      // previous row's; clients inherit it downward.
      if (loc.path !== previousPath) {
        row.location = { name: path.basename(loc.path), path: loc.path };
        previousPath = loc.path;
      }
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Synthetic address for the padding row at out-of-range instruction index
 * `index`: counts down from the first instruction's address below the range
 * and up from the last one's above it, keeping every address in the response
 * unique and strictly increasing (VS Code keys rows by address). Below the
 * first instruction this can go negative — code offsets start near 0, so a
 * window scrolled above the top underflows; those rows are inert padding and
 * never real instructions. With no instructions at all, addresses are simply
 * the row index (0, 1, 2, …).
 */
function paddingAddress(
  index: number,
  rowIndex: number,
  instructions: readonly { address: number }[],
): number {
  if (instructions.length === 0) {
    return rowIndex;
  }
  if (index < 0) {
    return instructions[0].address + index;
  }
  return instructions[instructions.length - 1].address + (index - (instructions.length - 1));
}
