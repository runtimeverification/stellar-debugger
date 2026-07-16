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
      case 'u32':
      case 'i32':
        // The SDK does not validate 32-bit integers (it will happily encode a
        // float or an out-of-range value), so guard them here to match the
        // strictness of the wide integer path below.
        return nativeToScVal(toInt32(arg.value, arg.type), { type: arg.type });
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

/** Inclusive value ranges for the 32-bit integer ScVal types. */
const INT32_RANGE: Record<'u32' | 'i32', { min: number; max: number }> = {
  u32: { min: 0, max: 0xffffffff },
  i32: { min: -0x80000000, max: 0x7fffffff },
};

/** Validate and coerce a value into an in-range 32-bit integer. */
function toInt32(value: unknown, type: 'u32' | 'i32'): number {
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string') {
    if (!/^[+-]?\d+$/.test(value.trim())) {
      throw new ScValEncodeError(`${type} value '${value}' is not a valid integer`);
    }
    n = Number(value);
  } else {
    throw new ScValEncodeError(`${type} value must be a number or string`);
  }
  if (!Number.isInteger(n)) {
    throw new ScValEncodeError(`${type} value must be an integer, got ${n}`);
  }
  const { min, max } = INT32_RANGE[type];
  if (n < min || n > max) {
    throw new ScValEncodeError(`${type} value ${n} is out of range [${min}, ${max}]`);
  }
  return n;
}

type WideIntType = 'u64' | 'i64' | 'u128' | 'i128' | 'u256' | 'i256';

/** Inclusive value ranges for the wide integer ScVal types. */
const BIGINT_RANGE: Record<WideIntType, { min: bigint; max: bigint }> = {
  u64: { min: 0n, max: 2n ** 64n - 1n },
  i64: { min: -(2n ** 63n), max: 2n ** 63n - 1n },
  u128: { min: 0n, max: 2n ** 128n - 1n },
  i128: { min: -(2n ** 127n), max: 2n ** 127n - 1n },
  u256: { min: 0n, max: 2n ** 256n - 1n },
  i256: { min: -(2n ** 255n), max: 2n ** 255n - 1n },
};

function toBigInt(value: unknown, type: WideIntType): bigint {
  let n: bigint;
  if (typeof value === 'bigint') {
    n = value;
  } else if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new ScValEncodeError(`${type} value must be an integer, got ${value}`);
    }
    n = BigInt(value);
  } else if (typeof value === 'string') {
    try {
      n = BigInt(value.trim());
    } catch {
      throw new ScValEncodeError(`${type} value '${value}' is not a valid integer`);
    }
  } else {
    throw new ScValEncodeError(`${type} value must be a number or string`);
  }
  // The SDK silently wraps out-of-range integers (e.g. 2^64 -> 0); reject them.
  const { min, max } = BIGINT_RANGE[type];
  if (n < min || n > max) {
    throw new ScValEncodeError(`${type} value ${n} is out of range [${min}, ${max}]`);
  }
  return n;
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
