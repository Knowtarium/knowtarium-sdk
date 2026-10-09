import { concatBytes } from "./encoding.js";
import { decryptBytes, encryptBytes, type WorkspaceKeys } from "./envelope.js";
import { CryptoError } from "./errors.js";
import type { WorkspaceKey } from "./workspace-keys.js";

// Attachments are split into chunks, each its own envelope with the context
// { kind: "attachment_chunk", workspaceId, id: attachmentId, chunkIndex, chunkCount }. Every chunk
// binds its position and the total count, so reordering, dropping or appending chunks (including
// cutting off the tail) makes decryption fail.

/** Plaintext bytes per chunk unless the caller picks another size (1 MiB). */
export const DEFAULT_CHUNK_BYTES = 1024 * 1024;

/** Which attachment the chunks belong to. */
export interface AttachmentContext {
  readonly workspaceId: string;
  readonly attachmentId: string;
}

/** Encrypts an attachment into chunk envelopes, in order. An empty file gives one empty chunk. */
export function encryptAttachment(
  key: WorkspaceKey,
  data: Uint8Array,
  attachment: AttachmentContext,
  chunkBytes = DEFAULT_CHUNK_BYTES,
): Uint8Array[] {
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1) {
    throw new CryptoError("invalid_input", "the chunk size must be a positive integer");
  }
  const chunkCount = Math.max(1, Math.ceil(data.length / chunkBytes));
  return Array.from({ length: chunkCount }, (_, chunkIndex) =>
    encryptBytes(key, data.subarray(chunkIndex * chunkBytes, (chunkIndex + 1) * chunkBytes), {
      kind: "attachment_chunk",
      workspaceId: attachment.workspaceId,
      id: attachment.attachmentId,
      chunkIndex,
      chunkCount,
    }),
  );
}

/**
 * Decrypts all chunk envelopes of an attachment, in order. Throws `decryption_failed` if any chunk
 * is missing, extra, out of order, from another attachment or tampered with.
 */
export function decryptAttachment(
  keys: WorkspaceKeys,
  chunks: readonly Uint8Array[],
  attachment: AttachmentContext,
): Uint8Array {
  if (chunks.length === 0)
    throw new CryptoError("decryption_failed", "an attachment has no chunks");
  const parts = chunks.map((chunk, chunkIndex) =>
    decryptBytes(keys, chunk, {
      kind: "attachment_chunk",
      workspaceId: attachment.workspaceId,
      id: attachment.attachmentId,
      chunkIndex,
      chunkCount: chunks.length,
    }),
  );
  return concatBytes(...parts);
}
