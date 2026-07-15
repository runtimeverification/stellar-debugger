/**
 * Wasm binary section walker: validates the module header and enumerates all
 * sections with their byte offsets, without decoding section contents.
 *
 * Pure module (no `vscode` imports, no external deps).
 */

/**
 * One section of a wasm module, located by byte offsets into the input buffer:
 * - `start` is the offset of the section id byte;
 * - `payloadStart` is the first byte of the section CONTENT — for custom
 *   sections (id 0) that is AFTER the name-length ULEB and name bytes;
 * - `payloadEnd` is one past the last content byte.
 */
export interface WasmSection {
  id: number;
  /** Section name; present only for custom sections (id 0). */
  name?: string;
  start: number;
  payloadStart: number;
  payloadEnd: number;
}

export class WasmFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WasmFormatError';
  }
}

export interface ParsedWasm {
  sections: WasmSection[];
  /** The section with id 10, if present. */
  codeSection?: WasmSection;
  /**
   * Content slice of the FIRST custom section with the given name (duplicate
   * names occur in practice, e.g. `contractmetav0` twice — first wins). The
   * returned Uint8Array may share the underlying buffer with the input.
   */
  customSection(name: string): Uint8Array | undefined;
}

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];
const WASM_VERSION = [0x01, 0x00, 0x00, 0x00];
const CUSTOM_SECTION_ID = 0;
const CODE_SECTION_ID = 10;
const MAX_ULEB_BYTES = 5;

/**
 * Parses the section structure of a wasm binary. Throws WasmFormatError on a
 * bad magic/version or any structural inconsistency (a section extending past
 * end of file, a ULEB running off the buffer or longer than 5 bytes).
 */
export function parseWasmSections(bytes: Uint8Array): ParsedWasm {
  if (bytes.length < WASM_MAGIC.length + WASM_VERSION.length) {
    throw new WasmFormatError('buffer too short for wasm header');
  }
  if (!WASM_MAGIC.every((b, i) => bytes[i] === b)) {
    throw new WasmFormatError('bad wasm magic');
  }
  if (!WASM_VERSION.every((b, i) => bytes[WASM_MAGIC.length + i] === b)) {
    throw new WasmFormatError('unsupported wasm version (expected 1)');
  }

  const sections: WasmSection[] = [];
  let offset = WASM_MAGIC.length + WASM_VERSION.length;
  while (offset < bytes.length) {
    const start = offset;
    const id = bytes[offset];
    offset += 1;
    const [size, afterSize] = readUleb(bytes, offset);
    offset = afterSize;
    const sectionEnd = offset + size;
    if (sectionEnd > bytes.length) {
      throw new WasmFormatError(`section at offset ${start} extends past end of file`);
    }

    let name: string | undefined;
    let payloadStart = offset;
    if (id === CUSTOM_SECTION_ID) {
      const [nameLen, afterNameLen] = readUleb(bytes, offset);
      const nameEnd = afterNameLen + nameLen;
      if (nameEnd > sectionEnd) {
        throw new WasmFormatError(`custom section name at offset ${start} extends past the section`);
      }
      name = Buffer.from(bytes.buffer, bytes.byteOffset + afterNameLen, nameLen).toString('utf8');
      payloadStart = nameEnd;
    }

    sections.push({ id, name, start, payloadStart, payloadEnd: sectionEnd });
    offset = sectionEnd;
  }

  return {
    sections,
    codeSection: sections.find((s) => s.id === CODE_SECTION_ID),
    customSection(sectionName: string): Uint8Array | undefined {
      const match = sections.find((s) => s.id === CUSTOM_SECTION_ID && s.name === sectionName);
      return match ? bytes.subarray(match.payloadStart, match.payloadEnd) : undefined;
    },
  };
}

/**
 * Rebuilds `bytes` as a wasm binary omitting every custom section (id 0) whose
 * name `shouldRemove(name)` returns true. All other sections are copied verbatim
 * (their original bytes, including the size ULEB), so non-custom sections — the
 * code section in particular — are byte-for-byte unchanged. Returns an
 * equivalent copy when nothing matches. Throws WasmFormatError on a malformed
 * header (structure is validated via parseWasmSections).
 */
export function stripCustomSections(
  bytes: Uint8Array,
  shouldRemove: (name: string) => boolean,
): Uint8Array {
  const parsed = parseWasmSections(bytes);
  const parts: Uint8Array[] = [bytes.subarray(0, WASM_MAGIC.length + WASM_VERSION.length)];
  for (const s of parsed.sections) {
    if (s.id === CUSTOM_SECTION_ID && s.name !== undefined && shouldRemove(s.name)) {
      continue;
    }
    parts.push(bytes.subarray(s.start, s.payloadEnd));
  }
  return Buffer.concat(parts);
}

/** Strip DWARF debug sections (`.debug*`). */
export function stripDebugSections(bytes: Uint8Array): Uint8Array {
  return stripCustomSections(bytes, (name) => name.startsWith('.debug'));
}

/** Reads a ULEB128 at `offset`; returns [value, offset after the ULEB]. */
function readUleb(bytes: Uint8Array, offset: number): [number, number] {
  let value = 0;
  for (let i = 0; i < MAX_ULEB_BYTES; i++) {
    if (offset + i >= bytes.length) {
      throw new WasmFormatError(`ULEB128 at offset ${offset} runs off the buffer`);
    }
    const byte = bytes[offset + i];
    value += (byte & 0x7f) * 2 ** (7 * i);
    if ((byte & 0x80) === 0) {
      return [value, offset + i + 1];
    }
  }
  throw new WasmFormatError(`ULEB128 at offset ${offset} exceeds ${MAX_ULEB_BYTES} bytes`);
}
