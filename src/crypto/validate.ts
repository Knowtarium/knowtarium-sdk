import { CryptoError } from "./errors.js";

/** Throws `invalid_input` unless `value` is a Uint8Array of exactly `length` bytes. */
export function assertBytes(
  value: unknown,
  length: number,
  what: string,
): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new CryptoError("invalid_input", `${what} must be ${String(length)} bytes`);
  }
}
