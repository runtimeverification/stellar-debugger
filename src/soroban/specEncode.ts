/**
 * Spec-driven Soroban argument encoding + `${...}` substitution.
 *
 * A contract's wasm carries a `contractspecv0` custom section describing its
 * function signatures and composite types (structs / enums / unions / tuples /
 * vecs / maps). `@stellar/stellar-sdk`'s `contract.Client.fromWasm` parses that
 * section OFFLINE — no RPC call is made despite its rpc-shaped signature — and
 * exposes a `contract.Spec`. `spec.funcArgsToScVals(fn, argsByName)` then
 * encodes named args using the contract's own type defs, so composite inputs no
 * longer need the hand-rolled `{type,value}` encoder in `./scval`.
 *
 * This module provides:
 *   - `loadContractSpec(wasm)` — resolve the `Spec` from a wasm buffer, offline.
 *   - `encodeNamedArgs(spec, fn, namedArgs)` — spec-driven encoding by param name.
 *   - `encodeInvokeArgs(spec, fn, args)` — dispatch: a legacy `{type,value}[]`
 *     array routes to `./scval`'s `encodeArgs`; an object routes to the
 *     spec-driven path.
 *   - `substitute(value, ctx)` — pure recursive `${sourceAddress}` /
 *     `${contract:<id>}` replacement inside string values.
 *
 * Pure aside from the in-memory wasm parse: no filesystem, no network.
 */

import { contract, xdr } from '@stellar/stellar-sdk';
import { encodeArgs, ScValArg } from './scval';

export type Spec = contract.Spec;

/**
 * Resolve a contract `Spec` from its wasm buffer, fully OFFLINE. `Spec.fromWasm`
 * parses the wasm's `contractspecv0` custom section directly — no rpc endpoint
 * and no contract id are involved.
 */
export async function loadContractSpec(wasm: Buffer): Promise<Spec> {
  return contract.Spec.fromWasm(wasm);
}

/**
 * Encode named args for `fn` using the contract's own type defs. Args are keyed
 * by the spec's EXACT parameter names; a wrong name or an unknown function
 * throws (the SDK rejects both).
 */
export function encodeNamedArgs(
  spec: Spec,
  fn: string,
  namedArgs: Record<string, unknown>,
): xdr.ScVal[] {
  return spec.funcArgsToScVals(fn, namedArgs);
}

/**
 * Dispatch invoke args to the right encoder:
 *   - an ARRAY is the legacy `{type,value}[]` form → `./scval`'s `encodeArgs`;
 *   - an OBJECT is spec-driven named args → `encodeNamedArgs`.
 */
export function encodeInvokeArgs(
  spec: Spec,
  fn: string,
  args: unknown,
): xdr.ScVal[] {
  if (Array.isArray(args)) {
    return encodeArgs(args as ScValArg[]);
  }
  if (args !== null && typeof args === 'object') {
    return encodeNamedArgs(spec, fn, args as Record<string, unknown>);
  }
  if (args === undefined) {
    return [];
  }
  throw new Error(
    `invalid invoke args: expected a { param: value } object or a legacy {type,value}[] array, got ${typeof args}`,
  );
}

/** Matches a `${...}` substitution token. */
const TOKEN = /\$\{([^}]*)\}/g;

/**
 * Recursively replace `${sourceAddress}` and `${contract:<id>}` tokens inside
 * string values. Non-string primitives pass through untouched; arrays and
 * objects are walked. THROWS on an unknown `${...}` token or an unknown
 * contract handle. Pure — no IO, no mutation of the input.
 */
export function substitute(
  value: unknown,
  ctx: { sourceAddress: string; contracts: Record<string, string> },
): unknown {
  if (typeof value === 'string') {
    return substituteString(value, ctx);
  }
  if (Array.isArray(value)) {
    return value.map((v) => substitute(v, ctx));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = substitute(v, ctx);
    }
    return out;
  }
  return value;
}

function substituteString(
  s: string,
  ctx: { sourceAddress: string; contracts: Record<string, string> },
): string {
  return s.replace(TOKEN, (_match, token: string) => {
    if (token === 'sourceAddress') {
      return ctx.sourceAddress;
    }
    const contractPrefix = 'contract:';
    if (token.startsWith(contractPrefix)) {
      const id = token.slice(contractPrefix.length);
      const resolved = ctx.contracts[id];
      if (resolved === undefined) {
        throw new Error(`unknown contract handle in substitution: "${id}"`);
      }
      return resolved;
    }
    throw new Error(`unknown substitution token: "\${${token}}"`);
  });
}
