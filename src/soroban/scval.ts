/**
 * Encoding of user-supplied launch arguments into Soroban ScVals.
 *
 * Launch configurations describe function arguments declaratively as
 * `{ value, type }` pairs (see the `args` attribute in package.json). This
 * module turns those into `xdr.ScVal` instances suitable for
 * `Contract.call(fn, ...scvals)`.
 *
 * Pure module (no `vscode` imports); depends only on @stellar/stellar-sdk.
 */

import { nativeToScVal, scValToNative, Address, xdr } from '@stellar/stellar-sdk';

/** Supported ScVal type tags accepted in launch configurations. */
export type ScValType =
  | 'bool'
  | 'u32'
  | 'i32'
  | 'u64'
  | 'i64'
  | 'u128'
  | 'i128'
  | 'u256'
  | 'i256'
  | 'symbol'
  | 'string'
  | 'bytes'
  | 'address'
  | 'vec'
  | 'map';

/** A single declarative function argument from a launch configuration. */
export interface ScValArg {
  value: unknown;
  type: ScValType;
}

const SUPPORTED_TYPES: ReadonlySet<string> = new Set<ScValType>([
  'bool', 'u32', 'i32', 'u64', 'i64', 'u128', 'i128', 'u256', 'i256',
  'symbol', 'string', 'bytes', 'address', 'vec', 'map',
]);

export class ScValEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScValEncodeError';
  }
}

/** Encode one declarative argument into an ScVal. */
export function encodeArg(arg: ScValArg): xdr.ScVal {
  if (!arg || typeof arg !== 'object') {
    throw new ScValEncodeError('argument must be an object { value, type }');
  }
  if (!SUPPORTED_TYPES.has(arg.type)) {
    throw new ScValEncodeError(`unsupported arg type '${arg.type}'`);
  }

  try {
    switch (arg.type) {
      case 'address':
        return new Address(String(arg.value)).toScVal();
      case 'bytes':
        return nativeToScVal(toBytes(arg.value), { type: 'bytes' });
      case 'symbol':
        return nativeToScVal(String(arg.value), { type: 'symbol' });
      case 'string':
        return nativeToScVal(String(arg.value), { type: 'string' });
      case 'u64':
      case 'i64':
      case 'u128':
      case 'i128':
      case 'u256':
      case 'i256':
        // Large integers must round-trip exactly; accept string or number.
        return nativeToScVal(toBigInt(arg.value, arg.type), { type: arg.type });
      default:
        return nativeToScVal(arg.value, { type: arg.type });
    }
  } catch (e) {
    if (e instanceof ScValEncodeError) {
      throw e;
    }
    throw new ScValEncodeError(`failed to encode ${arg.type} value ${JSON.stringify(arg.value)}: ${(e as Error).message}`);
  }
}

/** Encode a list of declarative arguments into ScVals, preserving order. */
export function encodeArgs(args: ScValArg[] | undefined): xdr.ScVal[] {
  return (args ?? []).map(encodeArg);
}

/** Decode an ScVal back to a JS value (used for return values / inspection). */
export function decodeScVal(scval: xdr.ScVal): unknown {
  return scValToNative(scval);
}

function toBigInt(value: unknown, type: string): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new ScValEncodeError(`${type} value must be an integer, got ${value}`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string') {
    try {
      return BigInt(value);
    } catch {
      throw new ScValEncodeError(`${type} value '${value}' is not a valid integer`);
    }
  }
  throw new ScValEncodeError(`${type} value must be a number or string`);
}

function toBytes(value: unknown): Buffer {
  if (typeof value === 'string') {
    // Hex string (optionally 0x-prefixed).
    const hex = value.startsWith('0x') ? value.slice(2) : value;
    if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
      throw new ScValEncodeError(`bytes value '${value}' is not valid hex`);
    }
    return Buffer.from(hex, 'hex');
  }
  if (Array.isArray(value) && value.every((b) => typeof b === 'number')) {
    return Buffer.from(value as number[]);
  }
  throw new ScValEncodeError('bytes value must be a hex string or an array of byte values');
}
