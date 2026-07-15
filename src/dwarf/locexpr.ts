/**
 * Evaluator for DWARF location expressions — the little stack-machine byte
 * programs that a variable's `DW_AT_location` (or a scope's `DW_AT_frame_base`)
 * is expressed in. Given the expression bytes, an optional frame-base
 * expression, and a snapshot of the WASM runtime, `evalLocation` resolves where
 * a value lives: in a local/global/operand-stack slot, at a linear-memory
 * address, or as an immediate value.
 *
 * Only the handful of opcodes this target actually emits are interpreted
 * (WASM_location, fbreg, addr, plus_uconst, stack_value). Anything else — an
 * unknown opcode, a composite `DW_OP_piece`, an unsupported WASM_location kind,
 * a truncated program, or a missing runtime value — degrades to
 * `{ kind: 'unavailable' }` rather than throwing: a debugger inspecting a
 * variable it cannot fully resolve should show "unavailable", never crash.
 *
 * Addresses are 4 bytes (this target's WASM address size).
 *
 * Pure module (no `vscode` imports, no external deps).
 */

import { Cursor } from './cursor';
import * as C from './constants';

/** WASM linear-memory address size, in bytes (matches the target's DWARF). */
const ADDRESS_SIZE = 4;

/** Reads a WASM register/local/global/stack slot value, keyed by index. */
export interface RuntimeState {
  localValue: (index: number) => number | bigint | undefined;
  globalValue: (index: number) => number | bigint | undefined;
  stackValue: (index: number) => number | bigint | undefined;
  readMemory: (address: number, size: number) => Uint8Array | undefined;
}

/** Where a value lives, as resolved from a location expression. */
export type ValueLocation =
  | { kind: 'local'; index: number } // WASM local slot
  | { kind: 'global'; index: number } // WASM global slot
  | { kind: 'stack'; index: number } // WASM operand-stack slot
  | { kind: 'memory'; address: number } // linear-memory address
  | { kind: 'value'; value: number } // the value itself (DW_OP_stack_value)
  | { kind: 'unavailable'; reason: string }; // could not be resolved

/** The register-slot variants of `ValueLocation` (local/global/stack). */
type RegisterLocation = Extract<ValueLocation, { kind: 'local' | 'global' | 'stack' }>;

/**
 * Resolves `exprBytes` to a `ValueLocation`. `frameBaseExpr`, when present, is
 * the enclosing scope's `DW_AT_frame_base` expression, evaluated on demand for
 * `DW_OP_fbreg`. Never throws — any malformed or unsupported input yields
 * `{ kind: 'unavailable' }`.
 */
export function evalLocation(
  exprBytes: Uint8Array,
  frameBaseExpr: Uint8Array | undefined,
  state: RuntimeState,
): ValueLocation {
  try {
    return evaluate(exprBytes, frameBaseExpr, state);
  } catch {
    // A truncated program (a Cursor overrun) is just another unresolvable
    // location; report it rather than propagate the parse error.
    return { kind: 'unavailable', reason: 'malformed location expression' };
  }
}

function evaluate(
  exprBytes: Uint8Array,
  frameBaseExpr: Uint8Array | undefined,
  state: RuntimeState,
): ValueLocation {
  const cursor = new Cursor(exprBytes);
  const stack: number[] = [];
  let pendingRegister: RegisterLocation | undefined;
  let isValue = false; // DW_OP_stack_value seen: the top of stack IS the value.

  while (!cursor.atEnd) {
    const op = cursor.u8();
    switch (op) {
      case C.DW_OP_addr:
        stack.push(readAddress(cursor));
        break;
      case C.DW_OP_plus_uconst: {
        const addend = cursor.uleb();
        if (stack.length === 0) {
          return { kind: 'unavailable', reason: 'DW_OP_plus_uconst on empty stack' };
        }
        stack.push(stack.pop()! + addend);
        break;
      }
      case C.DW_OP_fbreg: {
        const offset = cursor.sleb();
        if (frameBaseExpr === undefined) {
          return { kind: 'unavailable', reason: 'DW_OP_fbreg without a frame base' };
        }
        const base = registerValue(evaluate(frameBaseExpr, undefined, state), state);
        if (base === undefined) {
          return { kind: 'unavailable', reason: 'frame-base value unavailable' };
        }
        stack.push(base + offset);
        break;
      }
      case C.DW_OP_stack_value:
        isValue = true;
        break;
      case C.DW_OP_WASM_location: {
        const register = readWasmLocation(cursor);
        if (register === undefined) {
          return { kind: 'unavailable', reason: 'unsupported DW_OP_WASM_location kind' };
        }
        pendingRegister = register;
        break;
      }
      // Composite/piece descriptions are not assembled here.
      case C.DW_OP_piece:
      case C.DW_OP_bit_piece:
        return { kind: 'unavailable', reason: 'composite location (DW_OP_piece)' };
      default:
        return { kind: 'unavailable', reason: `unsupported opcode 0x${op.toString(16)}` };
    }
  }

  // A DW_OP_stack_value makes the top of the stack the value itself.
  if (isValue) {
    if (stack.length > 0) {
      return { kind: 'value', value: stack[stack.length - 1] };
    }
    // LLVM's standard wasm pattern is `DW_OP_WASM_location <local> N ;
    // DW_OP_stack_value`: nothing is pushed onto the numeric stack, but the
    // preceding WASM_location named the register whose CONTENT is the value.
    // Return that register location — decodeValue reads its slot via
    // registerValue and produces the actual number.
    if (pendingRegister) {
      return pendingRegister;
    }
    return { kind: 'unavailable', reason: 'DW_OP_stack_value with empty stack' };
  }
  // Anything pushed onto the stack is a linear-memory address.
  if (stack.length > 0) {
    return { kind: 'memory', address: stack[stack.length - 1] };
  }
  // A lone WASM_location is a register location description.
  if (pendingRegister) {
    return pendingRegister;
  }
  return { kind: 'unavailable', reason: 'empty location expression' };
}

/**
 * Reads the slot integer behind a register `ValueLocation`, coerced to a
 * `Number` (frame bases and addresses are 32-bit on this target). Returns
 * `undefined` for a missing slot or a non-register location.
 */
export function registerValue(loc: ValueLocation, state: RuntimeState): number | undefined {
  let raw: number | bigint | undefined;
  switch (loc.kind) {
    case 'local':
      raw = state.localValue(loc.index);
      break;
    case 'global':
      raw = state.globalValue(loc.index);
      break;
    case 'stack':
      raw = state.stackValue(loc.index);
      break;
    default:
      return undefined;
  }
  if (raw === undefined) {
    return undefined;
  }
  return typeof raw === 'bigint' ? Number(raw) : raw;
}

/** Little-endian fixed-width address (ADDRESS_SIZE bytes). */
function readAddress(cursor: Cursor): number {
  let value = 0;
  for (let i = 0; i < ADDRESS_SIZE; i++) {
    value += cursor.u8() * 2 ** (8 * i);
  }
  return value;
}

/**
 * Decodes a `DW_OP_WASM_location` operand: a 1-byte kind followed by an index.
 * Kinds 0/1/2 (local/global/operand-stack) take a ULEB index; kind 3 is a
 * global with a FIXED 4-byte index. Returns `undefined` for any other kind.
 */
function readWasmLocation(cursor: Cursor): RegisterLocation | undefined {
  const kind = cursor.u8();
  switch (kind) {
    case 0:
      return { kind: 'local', index: cursor.uleb() };
    case 1:
      return { kind: 'global', index: cursor.uleb() };
    case 2:
      return { kind: 'stack', index: cursor.uleb() };
    case 3:
      return { kind: 'global', index: cursor.u32() }; // fixed u32, NOT uleb.
    default:
      return undefined;
  }
}
