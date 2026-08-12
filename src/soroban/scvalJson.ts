/**
 * Display rendering and identity for `ScVal`s **as the trace encodes them**
 * (komet's `ScVal2JSON`: `{ type, value }`, see `komet/traceEvents.ts`).
 *
 * This is the inverse direction of `soroban/scval.ts`, which encodes launch
 * arguments into `ScVal`s for submission. Here a decoded ledger value has to be
 * shown to a user, so the output is a `DecodedValue` — the very shape the DWARF
 * value decoder produces — which lets both consumers reuse their existing
 * plumbing unchanged: the DAP session's `toDapVariable` (lazy child handles) and
 * the CLI projection's `expandDecoded` (eager, budgeted expansion).
 *
 * Following DAP convention the *value* goes in `display` and the type name in
 * `typeName`, rather than baking `u32(5)` into one string; `summarizeScVal` is
 * the compact one-line form for places that have only a single label to give
 * (a storage entry's name, for instance).
 *
 * Pure module (no `vscode` / DAP imports), and deliberately free of
 * @stellar/stellar-sdk: this sits in the debug adapter's module graph, where the
 * SDK's ~6s load time would delay every session start past the DAP handshake
 * timeout. Strkey encoding comes from the local `strkey.ts` instead.
 */

import { ScValJson, TraceAddress } from '../komet/trace';
import { DecodedValue, ChildVar } from '../dwarf/ValueDecoder';
import { ADDRESS_BYTES, encodeContract, encodeEd25519PublicKey } from './strkey';

/**
 * Render an address as the strkey a user recognizes — `C…` for a contract, `G…`
 * for an account. komet's own test ledgers use short ids (`"63"`) that are not
 * valid 32-byte addresses; those fall back to `0x`-prefixed hex rather than
 * throwing or fabricating a strkey.
 */
export function renderAddress(address: TraceAddress): string {
  const hex = address.value;
  if (hex.length === ADDRESS_BYTES * 2) {
    const raw = Buffer.from(hex, 'hex');
    try {
      return address.addrType === 'contract'
        ? encodeContract(raw)
        : encodeEd25519PublicKey(raw);
    } catch {
      // Fall through to hex: a value that cannot be encoded is still worth showing.
    }
  }
  return `0x${hex}`;
}

/** Render an `ScVal` for display, expandable when it is a vec or a map. */
export function renderScVal(value: ScValJson): DecodedValue {
  const type = value.type;

  switch (type) {
    case 'void':
      return { display: 'void', typeName: 'void' };

    case 'error': {
      const errType = value.errType ?? 'error';
      const code = value.code ?? 0;
      return { display: `${errType}#${code}`, typeName: 'error' };
    }

    case 'address':
      return {
        display: renderAddress({
          addrType: value.addrType === 'account' ? 'account' : 'contract',
          value: typeof value.value === 'string' ? value.value : '',
        }),
        typeName: 'address',
      };

    case 'string':
      return { display: JSON.stringify(String(value.value)), typeName: 'string' };

    case 'bytes':
      return { display: `0x${String(value.value)}`, typeName: 'bytes' };

    case 'vec': {
      const items = Array.isArray(value.value) ? (value.value as ScValJson[]) : [];
      const decoded: DecodedValue = { display: `vec[${items.length}]`, typeName: 'vec' };
      if (items.length > 0) {
        decoded.children = () =>
          items.map((item, i): ChildVar => ({ name: `[${i}]`, value: renderScVal(item) }));
      }
      return decoded;
    }

    case 'map': {
      const entries = Array.isArray(value.value) ? (value.value as [ScValJson, ScValJson][]) : [];
      const decoded: DecodedValue = { display: `map{${entries.length}}`, typeName: 'map' };
      if (entries.length > 0) {
        decoded.children = () =>
          entries.map(([key, val]): ChildVar => ({
            name: renderScVal(key).display,
            value: renderScVal(val),
          }));
      }
      return decoded;
    }

    default:
      // Every remaining modelled type (bool, the integer widths, symbol) shows
      // its value verbatim, and so does a type this module has never seen.
      return { display: String(value.value), typeName: type };
  }
}

/**
 * A compact one-line form, `type(value)` — for labels that have room for only a
 * single string, e.g. a storage entry's name in the Ledger tree.
 */
export function summarizeScVal(value: ScValJson): string {
  const rendered = renderScVal(value);
  if (rendered.typeName === 'void') {
    return 'void';
  }
  return `${rendered.typeName}(${rendered.display})`;
}

/**
 * A stable identity string for an `ScVal`, so storage entries can be keyed in a
 * `Map`. Structurally equal values MUST produce equal keys regardless of JSON
 * key order, and different values must not collide.
 *
 * Within one type, a JSON number and its decimal string denote the same integer
 * and share a key: komet emits `u128`/`i128`/`u256` as numbers today, and a
 * producer that switched to strings must not split one storage entry in two.
 */
export function scvalKey(value: ScValJson): string {
  const type = value.type;
  switch (type) {
    case 'void':
      return 'void';
    case 'error':
      return `error:${value.errType ?? ''}:${value.code ?? 0}`;
    case 'address':
      return `address:${value.addrType ?? ''}:${String(value.value ?? '')}`;
    case 'vec': {
      const items = Array.isArray(value.value) ? (value.value as ScValJson[]) : [];
      return `vec[${items.map(scvalKey).join(',')}]`;
    }
    case 'map': {
      const entries = Array.isArray(value.value) ? (value.value as [ScValJson, ScValJson][]) : [];
      return `map{${entries.map(([k, v]) => `${scvalKey(k)}=>${scvalKey(v)}`).join(',')}}`;
    }
    default:
      return `${type}:${String(value.value)}`;
  }
}
