/**
 * Spec-driven Soroban argument encoding + `${...}` substitution.
 *
 * A contract's wasm carries a `contractspecv0` custom section describing its
 * function signatures and composite types (structs / enums / unions / tuples /
 * vecs / maps). `@stellar/stellar-sdk`'s `contract.Spec.fromWasm` parses that
 * section OFFLINE — no RPC call is made despite its rpc-shaped signature — and
 * `spec.funcArgsToScVals(fn, argsByName)` then encodes named args using the
 * contract's own type defs. So a launch config states arguments the way the
 * contract declares them, and composites need no hand-rolled encoding at all.
 *
 * This module provides:
 *   - `encodeInvokeArgs(wasm, fn, args)` — encode an invoke's args against the
 *     contract's own spec. The spec is parsed only when there are args to
 *     encode, so a zero-arg invoke never pays for it.
 *   - `substitute(value, ctx)` — pure recursive `${sourceAddress}` /
 *     `${contract:<id>}` replacement inside string values.
 *
 * Pure aside from the in-memory wasm parse: no filesystem, no network.
 */

import { contract, xdr } from '@stellar/stellar-sdk';

/**
 * Encode an invoke's `args` for `fn`, keyed by the spec's EXACT parameter names.
 * A wrong name, a wrong value shape, or an unknown function throws (the SDK
 * rejects all three). Absent args encode to no arguments at all.
 */
export async function encodeInvokeArgs(
  wasm: Buffer,
  fn: string,
  args: unknown,
): Promise<xdr.ScVal[]> {
  if (args === undefined || args === null) {
    return [];
  }
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(
      `invalid invoke args for ${fn}: expected an object keyed by parameter name, got ${
        Array.isArray(args) ? 'an array' : typeof args
      }`,
    );
  }
  const spec = await contract.Spec.fromWasm(wasm);
  return spec.funcArgsToScVals(fn, args as Record<string, unknown>);
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
