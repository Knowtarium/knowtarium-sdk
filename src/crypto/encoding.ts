import { CryptoError } from "./errors.js";

// Byte and text encodings the crypto code shares. Pure JavaScript, so they work before `ready()`.

/** The UTF-8 codecs, typed by hand: `src/` has neither DOM nor Node types on purpose. */
interface TextCodecs {
  TextEncoder: new () => { encode(input: string): Uint8Array };
  TextDecoder: new (
    label: "utf-8",
    options: { fatal: true },
  ) => { decode(input: Uint8Array): string };
}

const codecs = globalThis as unknown as TextCodecs;

/** Each character of an ASCII alphabet mapped to its index. */
function alphabetValues(alphabet: string): Map<string, number> {
  return new Map(
    Array.from({ length: alphabet.length }, (_, index) => [alphabet.charAt(index), index]),
  );
}

/** UTF-8 bytes of `text`. */
export function utf8Encode(text: string): Uint8Array {
  return new codecs.TextEncoder().encode(text);
}

/** Decodes UTF-8 strictly: invalid byte sequences throw `invalid_input` instead of becoming U+FFFD. */
export function utf8Decode(bytes: Uint8Array): string {
  try {
    return new codecs.TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CryptoError("invalid_input", "bytes are not valid UTF-8");
  }
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64URL_VALUES = alphabetValues(BASE64URL);

/** Base64url without padding (RFC 4648 section 5), the text form of keys and signatures. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let c = 0; c < chars; c++) out += BASE64URL.charAt((chunk >> (18 - 6 * c)) & 63);
  }
  return out;
}

/** Decodes unpadded base64url strictly (no padding, no whitespace, no non-canonical tails). */
export function fromBase64Url(text: string): Uint8Array {
  if (text.length % 4 === 1) throw new CryptoError("invalid_input", "invalid base64url length");
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of text) {
    const value = BASE64URL_VALUES.get(char);
    if (value === undefined) throw new CryptoError("invalid_input", "invalid base64url character");
    buffer = ((buffer << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >> bits) & 0xff;
    }
  }
  if ((buffer & ((1 << bits) - 1)) !== 0) {
    throw new CryptoError("invalid_input", "non-canonical base64url");
  }
  return out;
}

/** Lowercase hex, used by the test vectors. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Decodes hex (either case). */
export function fromHex(text: string): Uint8Array {
  if (text.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(text)) {
    throw new CryptoError("invalid_input", "invalid hex");
  }
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/**
 * Crockford's base32 alphabet: digits and uppercase letters without I, L, O and U, so a code read
 * aloud or copied by hand can't mix up 1/I/L or 0/O.
 */
const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BASE32_VALUES = alphabetValues(BASE32);
for (const [alias, char] of [
  ["O", "0"],
  ["I", "1"],
  ["L", "1"],
] as const) {
  BASE32_VALUES.set(alias, BASE32_VALUES.get(char) ?? 0);
}

/** Crockford base32 of `bytes`, most significant bit first; the last character is zero-padded. */
export function toBase32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32.charAt((buffer >> bits) & 31);
    }
  }
  if (bits > 0) out += BASE32.charAt((buffer << (5 - bits)) & 31);
  return out;
}

/**
 * Decodes Crockford base32 into exactly `length` bytes. Case-insensitive, reads O as 0 and I or L
 * as 1. Returns `undefined` for any other character, a wrong length or non-zero padding bits.
 */
export function fromBase32(text: string, length: number): Uint8Array | undefined {
  if (text.length !== Math.ceil((length * 8) / 5)) return undefined;
  const out = new Uint8Array(length);
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of text.toUpperCase()) {
    const value = BASE32_VALUES.get(char);
    if (value === undefined) return undefined;
    buffer = ((buffer << 5) | value) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >> bits) & 0xff;
    }
  }
  return (buffer & ((1 << bits) - 1)) === 0 ? out : undefined;
}

/** The four big-endian bytes of an unsigned 32-bit integer. */
export function uint32BE(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new CryptoError("invalid_input", "value is not an unsigned 32-bit integer");
  }
  return new Uint8Array([value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

/** Reads a big-endian unsigned 32-bit integer at `offset`. */
export function readUint32BE(bytes: Uint8Array, offset: number): number {
  const [a = 0, b = 0, c = 0, d = 0] = bytes.subarray(offset, offset + 4);
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

/** Joins byte arrays into one new array. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
