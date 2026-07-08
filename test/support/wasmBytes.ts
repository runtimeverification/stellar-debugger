/**
 * Hand-built wasm byte-buffer helpers for tests: assemble minimal but valid
 * wasm modules (header, plain sections, custom sections with a name field)
 * without invoking a real toolchain. Pure module (no `vscode` imports).
 */

/** Magic 0x00 0x61 0x73 0x6d followed by version 1 (little-endian u32). */
export const WASM_HEADER: readonly number[] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

/** Encode a non-negative integer as ULEB128 bytes. */
export function uleb(value: number): number[] {
  const out: number[] = [];
  let v = value;
  do {
    let byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v !== 0) {
      byte |= 0x80;
    }
    out.push(byte);
  } while (v !== 0);
  return out;
}

/** A plain section: id byte, ULEB payload size, payload bytes. */
export function section(id: number, payload: readonly number[]): number[] {
  return [id, ...uleb(payload.length), ...payload];
}

/** A custom section (id 0) whose payload is name-length ULEB + name + content. */
export function customSection(name: string, content: readonly number[]): number[] {
  const nameBytes = [...Buffer.from(name, 'utf8')];
  return section(0, [...uleb(nameBytes.length), ...nameBytes, ...content]);
}

/** Concatenate the wasm header and the given pre-encoded sections. */
export function wasmModule(...sections: readonly (readonly number[])[]): Uint8Array {
  return Uint8Array.from([...WASM_HEADER, ...sections.flat()]);
}
