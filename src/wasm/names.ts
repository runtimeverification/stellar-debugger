/**
 * Wasm function symbols: the `name` custom section, the import count that maps
 * body order to function index, and Rust symbol demangling.
 *
 * This is the naming ladder's second rung (docs/callstack.md, C4). When a module
 * carries DWARF, frames are named from the DIE tree; when it does not — a
 * release build with `debugInfo: false`, or any wasm whose `.debug_*` sections
 * were stripped — the `name` section is usually still there, and it holds the
 * Rust symbol of every function. Demangled, `_ZN7control7Control10while_call17h…E`
 * reads `control::Control::while_call`, which is what a wasm-level call stack
 * shows instead of a bare function index.
 *
 * Both readers are DELIBERATELY lenient: a truncated or unexpected name
 * subsection yields the names read so far rather than an error, because a
 * cosmetic section must never fail a debug session. Structural wasm errors
 * (bad magic, a section running past EOF) still throw from `parseWasmSections`.
 *
 * Pure module (no `vscode` imports).
 */

import { BinaryReader, BinaryReaderState, ExternalKind } from 'wasmparser';
import { parseWasmSections, readUleb } from './sections';

/** The `name` section's subsection id for the function-name map. */
const FUNCTION_NAMES_SUBSECTION = 1;
/** Wasm section id of the import section. */
const IMPORT_SECTION_ID = 2;

/**
 * Function names by wasm function index (imports included in the numbering), as
 * written in the `name` custom section — still mangled. Empty when the module
 * carries no `name` section or no function-name subsection.
 */
export function functionNames(bytes: Uint8Array): Map<number, string> {
  const names = new Map<number, string>();
  const section = parseWasmSections(bytes).customSection('name');
  if (!section) {
    return names;
  }
  let offset = 0;
  while (offset < section.length) {
    const id = section[offset];
    let size: number;
    let payloadStart: number;
    try {
      [size, payloadStart] = readUleb(section, offset + 1);
    } catch {
      return names; // Truncated subsection header; keep what we have.
    }
    const payloadEnd = payloadStart + size;
    if (payloadEnd > section.length) {
      return names;
    }
    if (id === FUNCTION_NAMES_SUBSECTION) {
      readNameMap(section.subarray(payloadStart, payloadEnd), names);
      return names; // Function names appear once; later subsections name locals.
    }
    offset = payloadEnd;
  }
  return names;
}

/**
 * Read a `namemap` — `count` followed by `(index, name)` pairs — into `out`,
 * stopping at the first entry that does not fit (a truncated section).
 */
function readNameMap(payload: Uint8Array, out: Map<number, string>): void {
  let offset: number;
  let count: number;
  try {
    [count, offset] = readUleb(payload, 0);
  } catch {
    return;
  }
  for (let i = 0; i < count; i++) {
    try {
      const [index, afterIndex] = readUleb(payload, offset);
      const [length, afterLength] = readUleb(payload, afterIndex);
      const end = afterLength + length;
      if (end > payload.length) {
        return;
      }
      out.set(index, Buffer.from(payload.subarray(afterLength, end)).toString('utf8'));
      offset = end;
    } catch {
      return;
    }
  }
}

/**
 * How many functions the module IMPORTS. Wasm numbers imported functions first,
 * so the i-th function BODY (the i-th entry of `Disassembly.functionRanges`) is
 * function index `importedFunctionCount(bytes) + i` — the index the `name`
 * section keys on.
 */
export function importedFunctionCount(bytes: Uint8Array): number {
  const data = new ArrayBuffer(bytes.length);
  new Uint8Array(data).set(bytes);
  const reader = new BinaryReader();
  reader.setData(data, 0, bytes.length);
  let count = 0;
  while (reader.read()) {
    if (reader.state === BinaryReaderState.BEGIN_SECTION) {
      // Stop once the walk is past the import section (id 2) rather than
      // decoding every instruction of the code section for nothing. Custom
      // sections (id 0) may appear anywhere, so they never end the walk.
      const id = (reader.result as { id: number }).id;
      if (id > IMPORT_SECTION_ID) {
        break;
      }
    }
    if (
      reader.state === BinaryReaderState.IMPORT_SECTION_ENTRY &&
      (reader.result as { kind: number }).kind === ExternalKind.Function
    ) {
      count++;
    }
  }
  return count;
}

/** Legacy-mangling hash segment: `h` followed by 16 hex digits. */
const HASH_SEGMENT_RE = /^h[0-9a-f]{16}$/;

/** The fixed `$…$` escapes rustc's legacy mangling emits. */
const ESCAPES: Record<string, string> = {
  SP: ' ',
  BP: '*',
  RF: '&',
  LT: '<',
  GT: '>',
  LP: '(',
  RP: ')',
  C: ',',
};

/**
 * Demangle a Rust LEGACY-mangled symbol (`_ZN…E`), the scheme rustc still emits
 * by default: length-prefixed path segments, a trailing disambiguating hash
 * segment, and `$…$` escapes for characters illegal in a symbol name. So
 * `_ZN7control4bump17h2628dce790f861d2E` becomes `control::bump`.
 *
 * Anything else — a plain name, a C symbol, or a v0-mangled symbol (`_R…`,
 * which rustc emits only under `-Csymbol-mangling-version=v0`) — is returned
 * unchanged: an undemangled symbol still names the frame, so guessing is worse
 * than passing it through.
 */
export function demangleRust(symbol: string): string {
  if (!symbol.startsWith('_ZN') || !symbol.endsWith('E')) {
    return symbol;
  }
  const segments: string[] = [];
  let offset = 3;
  const body = symbol.slice(0, -1);
  while (offset < body.length) {
    const digits = /^\d+/.exec(body.slice(offset));
    if (!digits) {
      return symbol; // Not length-prefixed after all; not a legacy symbol.
    }
    const length = Number(digits[0]);
    const start = offset + digits[0].length;
    if (start + length > body.length) {
      return symbol;
    }
    segments.push(body.slice(start, start + length));
    offset = start + length;
  }
  if (segments.length === 0) {
    return symbol;
  }
  if (HASH_SEGMENT_RE.test(segments[segments.length - 1])) {
    segments.pop();
  }
  return segments.map(unescapeSegment).join('::');
}

/**
 * Decode one mangled path segment: the fixed `$…$` escapes, the general
 * `$u<hex>$` form, `..` for `::`, and a leading `_` guarding a segment that
 * would otherwise start with a digit or `$`.
 */
function unescapeSegment(segment: string): string {
  // The guard is removed BEFORE unescaping: after `$LT$` has become `<` there is
  // no way to tell a guarded segment from one that starts with a real `_`.
  const unguarded = /^_(\$|\d)/.test(segment) ? segment.slice(1) : segment;
  const unescaped = unguarded.replace(/\$(u[0-9a-fA-F]{2,6}|[A-Z]{1,2})\$/g, (match, code: string) => {
    if (code.startsWith('u')) {
      const point = Number.parseInt(code.slice(1), 16);
      return Number.isNaN(point) ? match : String.fromCodePoint(point);
    }
    return ESCAPES[code] ?? match;
  });
  return unescaped.replace(/\.\./g, '::');
}
