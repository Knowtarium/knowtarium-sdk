// The sealed clip's header (the web clipper), the one part of a clip the server reads. Plain code
// with no imports at all, so knowtarium/clip (which carries no zod) shares it with the protocol:
//
//   0x01 (format) || key generation (uint32 BE) || crypto_box_seal(padded signed clip)

/** The format byte of a sealed clip (the first of its 5 header bytes). */
export const SEALED_CLIP_FORMAT = 1;

/** Bytes of a sealed clip's header: the format byte and the key generation. */
export const SEALED_CLIP_HEADER_BYTES = 5;

/** Bytes `crypto_box_seal` adds: the ephemeral public key and the tag. */
export const SEAL_OVERHEAD_BYTES = 48;

/** The smallest sealed clip: the header, `crypto_box_seal`'s 48 bytes and one padded kilobyte. */
export const SEALED_CLIP_MIN_BYTES = SEALED_CLIP_HEADER_BYTES + SEAL_OVERHEAD_BYTES + 1024;

/**
 * The 5 header bytes of a sealed clip, all the server reads: the format byte and the key
 * generation (uint32 big-endian). Null for a blob too short to be a sealed clip (the header,
 * `crypto_box_seal`'s 48 bytes and one padded kilobyte); the caller checks the format byte
 * (`SEALED_CLIP_FORMAT`) and the generation against the latest `inbox_key`.
 */
export function readSealedClipHeader(
  blob: Uint8Array,
): { readonly format: number; readonly generation: number } | null {
  if (blob.length < SEALED_CLIP_MIN_BYTES) return null;
  const [format = 0, a = 0, b = 0, c = 0, d = 0] = blob;
  return { format, generation: ((a << 24) | (b << 16) | (c << 8) | d) >>> 0 };
}
