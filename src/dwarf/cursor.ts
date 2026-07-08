/**
 * Little-endian byte cursor over a Uint8Array, tailored to DWARF encodings:
 * fixed-width integers, U/SLEB128 varints, initial-length fields (32-bit DWARF
 * only), and NUL-terminated UTF-8 strings.
 *
 * Every read that would run past the end of the buffer throws DwarfParseError,
 * so callers never have to bounds-check individually.
 *
 * Pure module (no `vscode` imports, no external deps).
 */

/** Raised for any malformed or unsupported DWARF encountered while parsing. */
export class DwarfParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DwarfParseError';
  }
}

/** Smallest 32-bit initial-length value reserved for DWARF extensions (0xfffffff0). */
const INITIAL_LENGTH_RESERVED = 0xfffffff0;

export class Cursor {
  private offset = 0;

  constructor(private readonly data: Uint8Array) {}

  /** Current read position, in bytes from the start of the buffer. */
  get pos(): number {
    return this.offset;
  }

  /** Bytes left to read. */
  get remaining(): number {
    return this.data.length - this.offset;
  }

  /** True when the cursor has consumed the whole buffer. */
  get atEnd(): boolean {
    return this.offset >= this.data.length;
  }

  u8(): number {
    this.require(1);
    return this.data[this.offset++];
  }

  u16(): number {
    this.require(2);
    const v = this.data[this.offset] | (this.data[this.offset + 1] << 8);
    this.offset += 2;
    return v;
  }

  u32(): number {
    this.require(4);
    const v =
      this.data[this.offset] +
      this.data[this.offset + 1] * 0x100 +
      this.data[this.offset + 2] * 0x10000 +
      this.data[this.offset + 3] * 0x1000000;
    this.offset += 4;
    return v;
  }

  /** Unsigned LEB128. Values are accumulated as JS numbers (safe to 2^53). */
  uleb(): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = this.u8();
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) {
        return value;
      }
      shift += 7;
    }
  }

  /** Signed LEB128. */
  sleb(): number {
    let value = 0;
    let shift = 0;
    let byte;
    do {
      byte = this.u8();
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while ((byte & 0x80) !== 0);
    if (shift < 53 && (byte & 0x40) !== 0) {
      value -= 2 ** shift;
    }
    return value;
  }

  /**
   * DWARF initial-length field. 64-bit DWARF (escape values 0xfffffff0 through
   * 0xffffffff) is not supported and throws DwarfParseError.
   */
  initialLength(): number {
    const length = this.u32();
    if (length >= INITIAL_LENGTH_RESERVED) {
      throw new DwarfParseError('64-bit DWARF not supported');
    }
    return length;
  }

  /** NUL-terminated UTF-8 string; consumes the terminator. */
  cstring(): string {
    const end = this.data.indexOf(0, this.offset);
    if (end < 0) {
      throw new DwarfParseError(`unterminated string at offset ${this.offset}`);
    }
    const text = Buffer.from(this.data.buffer, this.data.byteOffset + this.offset, end - this.offset).toString('utf8');
    this.offset = end + 1;
    return text;
  }

  /** Returns the next `n` bytes (a view sharing the underlying buffer) and advances. */
  bytes(n: number): Uint8Array {
    this.require(n);
    const slice = this.data.subarray(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }

  skip(n: number): void {
    this.require(n);
    this.offset += n;
  }

  /** A new cursor bounded to the next `n` bytes; this cursor advances past them. */
  sub(n: number): Cursor {
    return new Cursor(this.bytes(n));
  }

  private require(n: number): void {
    if (this.offset + n > this.data.length) {
      throw new DwarfParseError(
        `read of ${n} byte(s) at offset ${this.offset} runs past the end (${this.data.length} bytes)`,
      );
    }
  }
}
