import { decryptAttachment, encryptAttachment } from "../../crypto/index.js";
import { foldName, normalizeAttachmentName } from "../../core/files/index.js";
import {
  type Attachment,
  type AttachmentId,
  type CreateAttachmentRequest,
  attachmentChunkCountFits,
  ENVELOPE_OVERHEAD_BYTES,
  type FolderId,
  LIMITS,
  routes,
  type WorkspaceId,
} from "../../protocol/index.js";
import type { ApiClient } from "../api/index.js";
import {
  AttachmentTooLargeError,
  isSyncApiError,
  RequestValidationError,
  StorageFullError,
  VaultError,
} from "../errors/index.js";
import type { AbortSignalLike } from "../platform/abort.js";
import { newId } from "../platform/ids.js";
import type { KeyProvider } from "../vault/index.js";
import { type AttachmentMeta, decryptAttachmentMeta, encryptAttachmentMeta } from "./meta.js";

/** How far an upload or download is: bytes of ciphertext moved and the total. */
export type TransferProgress = (done: number, total: number) => void;

/**
 * An upload ready to send: the request and the encrypted chunks. Keep it to retry a failed upload
 * (`sendAttachmentUpload`): the same request and the same chunk bytes, so the server resumes
 * where it stopped.
 */
export interface PreparedUpload {
  readonly workspaceId: WorkspaceId;
  readonly request: CreateAttachmentRequest;
  readonly chunks: readonly Uint8Array[];
  readonly meta: AttachmentMeta;
}

/** An upload that failed: retry it with `sendAttachmentUpload(api, error.upload)`. */
export class AttachmentUploadError extends Error {
  override readonly name = "AttachmentUploadError";

  constructor(
    readonly upload: PreparedUpload,
    override readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : "the upload failed");
  }
}

/**
 * Encrypts a file for upload: the metadata (`{ name, type, sizeBytes }` as `encMeta`) and the
 * chunks (`encryptAttachment`), with the current key (`keys.forWriting`, so nothing is encrypted
 * while a rotation is pending). The name is normalized like a note's file name (never `.md`) and
 * refused (`RequestValidationError`) when `takenNames`, the folder's other attachment names, has
 * it, letter case ignored. Refuses a file over the size limit (`AttachmentTooLargeError`), and
 * chunks the sync API wouldn't take (`RequestValidationError` at `chunkCount`: a `chunkBytes` whose
 * chunks pass `LIMITS.attachmentChunkBytes`, see `attachmentChunkCountFits`). An empty file is one
 * empty envelope.
 */
export async function prepareAttachmentUpload(
  keys: KeyProvider,
  details: {
    readonly workspaceId: WorkspaceId;
    readonly folderId: FolderId;
    readonly name: string;
    readonly type: string;
    readonly data: Uint8Array;
    /**
     * The names of the folder's other attachments (required, so the check isn't forgotten): a
     * name among them, letter case ignored, is refused.
     */
    readonly takenNames: readonly string[];
    readonly attachmentId?: AttachmentId;
    /** Plaintext bytes per chunk (default 1 MiB). */
    readonly chunkBytes?: number;
  },
): Promise<PreparedUpload> {
  let name: string;
  try {
    name = normalizeAttachmentName(details.name);
  } catch {
    throw new RequestValidationError("createAttachment", "body", ["encMeta"]);
  }
  if (details.takenNames.some((taken) => foldName(taken) === foldName(name))) {
    throw new RequestValidationError("createAttachment", "body", ["encMeta"]);
  }
  if (details.data.length > LIMITS.attachmentBytes) {
    throw new AttachmentTooLargeError(details.data.length, LIMITS.attachmentBytes);
  }
  const keyring = await keys.forWriting();
  const attachmentId = details.attachmentId ?? newId("att");
  const ref = { workspaceId: details.workspaceId, attachmentId };
  const metaRef = { ...ref, folderId: details.folderId };
  const meta: AttachmentMeta = { name, type: details.type, sizeBytes: details.data.length };
  const chunks = encryptAttachment(keyring.current, details.data, ref, details.chunkBytes);
  const sizeBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (sizeBytes > LIMITS.attachmentBytes) {
    throw new AttachmentTooLargeError(sizeBytes, LIMITS.attachmentBytes);
  }
  // the sync API's chunk rules, checked before anything is sent (a chunk size too large for the
  // chunk limit, or chunks the server would refuse to count)
  if (
    chunks.some((chunk) => chunk.length > LIMITS.attachmentChunkBytes) ||
    !attachmentChunkCountFits(sizeBytes, chunks.length)
  ) {
    throw new RequestValidationError("createAttachment", "body", ["chunkCount"]);
  }
  return {
    workspaceId: details.workspaceId,
    meta,
    chunks,
    request: {
      id: attachmentId,
      folderId: details.folderId,
      encMeta: encryptAttachmentMeta(keyring.current, metaRef, meta),
      sizeBytes,
      chunkCount: chunks.length,
    },
  };
}

/**
 * Sends a prepared upload: announces it (the quota is checked first: `StorageFullError`), stores
 * the chunks the server doesn't have yet in order, and completes it. Every step is safe to repeat,
 * so a retry with the same prepared upload resumes where the last attempt stopped. A failure
 * throws `AttachmentUploadError` carrying the prepared upload.
 */
export async function sendAttachmentUpload(
  api: ApiClient,
  upload: PreparedUpload,
  options: { readonly onProgress?: TransferProgress; readonly signal?: AbortSignalLike } = {},
): Promise<Attachment> {
  const { workspaceId, request, chunks } = upload;
  const signal = options.signal === undefined ? {} : { signal: options.signal };
  try {
    let attachment: Attachment;
    try {
      ({
        data: { attachment },
      } = await api.call(routes.createAttachment, {
        params: { workspaceId },
        body: request,
        idempotent: true,
        ...signal,
      }));
    } catch (error) {
      if (isSyncApiError(error, "quota_exceeded") && error.detail.code === "quota_exceeded") {
        throw new StorageFullError(error.detail.usage);
      }
      throw error;
    }
    let done = chunks
      .slice(0, attachment.chunksReceived)
      .reduce((sum, chunk) => sum + chunk.length, 0);
    options.onProgress?.(done, request.sizeBytes);
    for (let index = attachment.chunksReceived; index < chunks.length; index++) {
      const chunk = chunks[index] ?? new Uint8Array();
      ({
        data: { attachment },
      } = await api.call(routes.uploadAttachmentChunk, {
        params: { workspaceId, attachmentId: request.id, chunkIndex: index },
        body: chunk,
        idempotent: true,
        ...signal,
      }));
      done += chunk.length;
      options.onProgress?.(done, request.sizeBytes);
    }
    if (attachment.status === "complete") return attachment;
    const { data } = await api.call(routes.completeAttachment, {
      params: { workspaceId, attachmentId: request.id },
      body: { status: "complete" },
      idempotent: true,
      ...signal,
    });
    return data.attachment;
  } catch (error) {
    if (error instanceof StorageFullError) throw error;
    throw new AttachmentUploadError(upload, error);
  }
}

/** Encrypts and uploads a file as an attachment (`prepareAttachmentUpload`, then `sendAttachmentUpload`). */
export async function uploadAttachment(
  api: ApiClient,
  keys: KeyProvider,
  details: Parameters<typeof prepareAttachmentUpload>[1] & {
    readonly onProgress?: TransferProgress;
    readonly signal?: AbortSignalLike;
  },
): Promise<{ readonly attachment: Attachment; readonly meta: AttachmentMeta }> {
  const upload = await prepareAttachmentUpload(keys, details);
  const attachment = await sendAttachmentUpload(api, upload, {
    ...(details.onProgress === undefined ? {} : { onProgress: details.onProgress }),
    ...(details.signal === undefined ? {} : { signal: details.signal }),
  });
  return { attachment, meta: upload.meta };
}

/**
 * Downloads an attachment: its metadata (decrypted and checked), every chunk in order, decrypted
 * (`decryptAttachment` fails on any missing, extra, reordered or swapped chunk), and checks the
 * size against the metadata (`invalid_attachment`). Refuses an upload that isn't complete.
 */
export async function downloadAttachment(
  api: ApiClient,
  keys: KeyProvider,
  details: {
    readonly workspaceId: WorkspaceId;
    readonly attachmentId: AttachmentId;
    readonly onProgress?: TransferProgress;
    readonly signal?: AbortSignalLike;
  },
): Promise<{ readonly data: Uint8Array; readonly meta: AttachmentMeta }> {
  const { workspaceId, attachmentId } = details;
  const signal = details.signal === undefined ? {} : { signal: details.signal };
  const ref = { workspaceId, attachmentId };
  const keyring = await keys.get();
  const {
    data: { attachment },
  } = await api.call(routes.getAttachment, { params: { workspaceId, attachmentId }, ...signal });
  if (attachment.status !== "complete") {
    throw new VaultError("invalid_attachment", "the attachment's upload isn't complete");
  }
  const meta = decryptAttachmentMeta(
    keyring,
    { ...ref, folderId: attachment.folderId },
    attachment.encMeta,
  );
  // bounded by the metadata before anything is fetched: every chunk holds at least one byte
  // (one empty chunk for an empty file), and each envelope adds a fixed overhead
  const chunkCount = attachment.chunkCount;
  const expected = meta.sizeBytes + chunkCount * ENVELOPE_OVERHEAD_BYTES;
  if (chunkCount > Math.max(1, meta.sizeBytes) || attachment.sizeBytes !== expected) {
    throw new VaultError(
      "invalid_attachment",
      "the attachment's size isn't what its metadata says",
    );
  }
  const chunks: Uint8Array[] = [];
  let done = 0;
  for (let index = 0; index < chunkCount; index++) {
    const { data } = await api.call(routes.getAttachmentChunk, {
      params: { workspaceId, attachmentId, chunkIndex: index },
      ...signal,
    });
    done += data.length;
    if (done > expected) {
      throw new VaultError("invalid_attachment", "the attachment is larger than its metadata says");
    }
    chunks.push(data);
    details.onProgress?.(done, expected);
  }
  const data = decryptAttachment(keyring, chunks, ref);
  if (data.length !== meta.sizeBytes) {
    throw new VaultError(
      "invalid_attachment",
      "the attachment's size isn't what its metadata says",
    );
  }
  return { data, meta };
}

/** Deletes an attachment and its chunks (a person's session). Resolves with the workspace version. */
export async function deleteAttachment(
  api: ApiClient,
  details: { readonly workspaceId: WorkspaceId; readonly attachmentId: AttachmentId },
): Promise<number> {
  const { data } = await api.call(routes.deleteAttachment, {
    params: { workspaceId: details.workspaceId, attachmentId: details.attachmentId },
    idempotent: true,
  });
  return data.workspaceVersion;
}
