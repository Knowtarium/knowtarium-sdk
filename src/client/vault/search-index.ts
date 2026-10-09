import {
  decryptBytes,
  decryptText,
  encryptBytes,
  encryptText,
  type WorkspaceKey,
  type WorkspaceKeys,
} from "../../crypto/index.js";
import { utf8Encode } from "../../crypto/encoding.js";
import { type LocalBlobRef, localBlobContext, searchIndexContext } from "./contexts.js";

/**
 * Encrypts a serialized search index (for example `SearchIndex.serialize()` from core) for the
 * local encrypted cache. It never goes to the server.
 */
export function encryptSearchIndex(
  key: WorkspaceKey,
  workspaceId: string,
  serialized: string,
  indexId = workspaceId,
): Uint8Array {
  return encryptText(key, serialized, searchIndexContext(workspaceId, indexId));
}

/** Decrypts a cached search index back to the string `encryptSearchIndex` was given. */
export function decryptSearchIndex(
  keys: WorkspaceKeys,
  workspaceId: string,
  blob: Uint8Array,
  indexId = workspaceId,
): string {
  return decryptText(keys, blob, searchIndexContext(workspaceId, indexId));
}

/**
 * Encrypts a blob that stays in this client's local encrypted cache (a search index, a graph
 * layout), bound to its kind, workspace and id. It never goes to the server.
 */
export function encryptLocalBlob(
  key: WorkspaceKey,
  ref: LocalBlobRef,
  data: Uint8Array | string,
): Uint8Array {
  return encryptBytes(
    key,
    typeof data === "string" ? utf8Encode(data) : data,
    localBlobContext(ref),
  );
}

/** Decrypts a local-cache blob from `encryptLocalBlob`. */
export function decryptLocalBlob(
  keys: WorkspaceKeys,
  ref: LocalBlobRef,
  blob: Uint8Array,
): Uint8Array {
  return decryptBytes(keys, blob, localBlobContext(ref));
}
