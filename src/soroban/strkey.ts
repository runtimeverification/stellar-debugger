/**
 * Minimal Stellar **strkey** encoding — the `G…` / `C…` textual form of a raw
 * 32-byte address (SEP-0023).
 *
 * @stellar/stellar-sdk has `StrKey`, but importing it costs ~8 seconds of module
 * load time, and this runs inside the debug adapter's module graph: pulling the
 * SDK in delays every session start past the DAP handshake timeout, so the
 * adapter never starts at all (test/dapLedger.test.ts is the guard). Encoding is
 * a version byte, the payload, and a CRC16-XModem checksum in base32 — small
 * enough to own, in keeping with the adapter's hand-written DWARF and wasm
 * parsers. `test/scvalJson.test.ts` pins the output against the SDK's `StrKey`,
 * which is the right place for the heavyweight dependency.
 *
 * Pure module, no dependencies.
 */

/** Version byte for a contract address (`2 << 3`), which renders as `C…`. */
const VERSION_CONTRACT = 2 << 3;
/** Version byte for an ed25519 public key (`6 << 3`), which renders as `G…`. */
const VERSION_ED25519_PUBLIC_KEY = 6 << 3;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Raw byte length of every address strkey this module encodes. */
export const ADDRESS_BYTES = 32;

/** `C…` strkey of a 32-byte contract address. */
export function encodeContract(raw: Uint8Array): string {
  return encodeCheck(VERSION_CONTRACT, raw);
}

/** `G…` strkey of a 32-byte ed25519 public key. */
export function encodeEd25519PublicKey(raw: Uint8Array): string {
  return encodeCheck(VERSION_ED25519_PUBLIC_KEY, raw);
}

/**
 * version byte ++ payload ++ CRC16-XModem(version ++ payload), base32-encoded.
 * The 35-byte result is exactly 56 base32 characters, so no padding arises.
 */
function encodeCheck(version: number, payload: Uint8Array): string {
  if (payload.length !== ADDRESS_BYTES) {
    throw new Error(`strkey payload must be ${ADDRESS_BYTES} bytes, got ${payload.length}`);
  }
  const body = new Uint8Array(1 + payload.length);
  body[0] = version;
  body.set(payload, 1);

  const checksum = crc16XModem(body);
  const full = new Uint8Array(body.length + 2);
  full.set(body, 0);
  // The checksum is appended little-endian.
  full[body.length] = checksum & 0xff;
  full[body.length + 1] = (checksum >> 8) & 0xff;

  return base32Encode(full);
}

/** CRC16-XModem: polynomial 0x1021, initial value 0, no final xor. */
function crc16XModem(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/** RFC 4648 base32, without padding (never needed for a 35-byte input). */
function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(buffer << (5 - bits)) & 0x1f];
  }
  return out;
}
