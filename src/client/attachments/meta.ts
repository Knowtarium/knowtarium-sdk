import { z } from "zod";

import {
  decryptJson,
  encryptJson,
  isCryptoError,
  fromBase64Url,
  toBase64Url,
  type WorkspaceKey,
  type WorkspaceKeys,
} from "../../crypto/index.js";
import { normalizeAttachmentName } from "../../core/files/index.js";
import type { BlobContext } from "../../crypto/index.js";
import { LIMITS } from "../../protocol/index.js";
import { VaultError } from "../errors/index.js";

/** An attachment in a workspace, in its folder. */
export interface AttachmentRef {
  readonly workspaceId: string;
  readonly attachmentId: string;
  readonly folderId: string;
}

/**
 * The context of an attachment's metadata (`attachment_meta`): bound to the attachment and to its
 * folder (`<attachmentId>:<folderId>`), so a server can't show it under another folder (the folder
 * is plaintext for scope checks; the name only means something in it). Attachments don't move
 * between folders; one that did would need its metadata encrypted again.
 */
export function attachmentMetaContext(ref: AttachmentRef): BlobContext {
  return {
    kind: "attachment_meta",
    workspaceId: ref.workspaceId,
    id: `${ref.attachmentId}:${ref.folderId}`,
  };
}

/**
 * What `encMeta` holds: the file name within its folder (normalized, never `.md`, unique in the
 * folder with letter case ignored), the media type and the plaintext size in bytes.
 */
export const AttachmentMeta = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(255)
    .refine(
      (name) => {
        try {
          return normalizeAttachmentName(name) === name;
        } catch {
          return false;
        }
      },
      { error: "Expected a normalized attachment file name" },
    ),
  type: z
    .string()
    .max(255)
    .regex(/^[\w.+-]+\/[\w.+-]+$/, { error: "Expected a media type such as image/png" }),
  sizeBytes: z.int().nonnegative().max(LIMITS.attachmentBytes),
});
export type AttachmentMeta = z.infer<typeof AttachmentMeta>;

/** Encrypts an attachment's metadata as its `encMeta` (base64url). */
export function encryptAttachmentMeta(
  key: WorkspaceKey,
  ref: AttachmentRef,
  meta: AttachmentMeta,
): string {
  return toBase64Url(encryptJson(key, AttachmentMeta.parse(meta), attachmentMetaContext(ref)));
}

/**
 * Decrypts and checks an attachment's `encMeta`. Throws `invalid_attachment` when it doesn't
 * decrypt for this attachment (another one's, or tampered) or decrypts to anything but valid
 * metadata.
 */
export function decryptAttachmentMeta(
  keys: WorkspaceKeys,
  ref: AttachmentRef,
  encMeta: string,
): AttachmentMeta {
  let decrypted: unknown;
  try {
    decrypted = decryptJson(keys, fromBase64Url(encMeta), attachmentMetaContext(ref));
  } catch (error) {
    // another attachment's metadata, or tampered: it doesn't open for this attachment
    if (isCryptoError(error, "decryption_failed")) {
      throw new VaultError("invalid_attachment", "an attachment's metadata doesn't decrypt");
    }
    throw error;
  }
  const parsed = AttachmentMeta.safeParse(decrypted);
  if (!parsed.success) {
    throw new VaultError("invalid_attachment", "an attachment's metadata isn't valid");
  }
  return parsed.data;
}
