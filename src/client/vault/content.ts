import {
  decryptJson,
  decryptText,
  encryptJson,
  encryptText,
  fromBase64Url,
  toBase64Url,
  type WorkspaceKey,
  type WorkspaceKeys,
} from "../../crypto/index.js";
import {
  decodeNoteFile,
  encodeNoteFile,
  type NoteContent,
  type NoteFile,
  NoteFileError,
} from "../../core/files/index.js";
import { utf8Encode } from "../../crypto/encoding.js";
import { LIMITS } from "../../protocol/index.js";
import { NoteTooLargeError, VaultError } from "../errors/index.js";
import {
  type AgentRef,
  agentNameContext,
  checkContext,
  extensionNameContext,
  type ExtensionRef,
  commentContext,
  eventContext,
  folderNameContext,
  type FolderRef,
  noteContext,
  type NoteRef,
  pendingContext,
  type PendingRef,
  type RecordRef,
  titleContext,
  workspaceNameContext,
} from "./contexts.js";

// Encrypt and decrypt what the web app and the CLI send, each with its own blob context, so the
// server can't serve one blob as another. Raw bodies (note versions, pending changes) are bytes;
// fields in JSON bodies (`encName`, `ciphertext`) are base64url, as the protocol expects.

/** Reads a decrypted note file, refusing one this client can't read (`invalid_note`). */
function readNoteFile(plaintext: string): NoteContent {
  try {
    return decodeNoteFile(plaintext);
  } catch (error) {
    if (error instanceof NoteFileError) throw new VaultError("invalid_note", error.message);
    throw error;
  }
}

/** Refuses a note blob over the protocol's limit before anything is sent. */
function withinNoteLimit(blob: Uint8Array): Uint8Array {
  if (blob.length > LIMITS.noteBytes) throw new NoteTooLargeError(blob.length, LIMITS.noteBytes);
  return blob;
}

/**
 * Encrypts a note version: the note file (its file name and the whole OKF markdown text, as
 * core's `encodeNoteFile` wrapper) with the current key. The name is validated first, and a blob
 * over `LIMITS.noteBytes` (6 MiB) throws `NoteTooLargeError`.
 */
export function encryptNote(key: WorkspaceKey, ref: NoteRef, file: NoteFile): Uint8Array {
  return withinNoteLimit(encryptText(key, encodeNoteFile(file), noteContext(ref)));
}

/** Decrypts a note version: its name and text (`invalid_note` for anything but a note file). */
export function decryptNote(keys: WorkspaceKeys, ref: NoteRef, blob: Uint8Array): NoteContent {
  return readNoteFile(decryptText(keys, blob, noteContext(ref)));
}

/** Encrypts an agent's proposed note file (a pending change), within the same limit. */
export function encryptPendingNote(key: WorkspaceKey, ref: PendingRef, file: NoteFile): Uint8Array {
  return withinNoteLimit(encryptText(key, encodeNoteFile(file), pendingContext(ref)));
}

/** Decrypts a pending change's proposed note file. */
export function decryptPendingNote(
  keys: WorkspaceKeys,
  ref: PendingRef,
  blob: Uint8Array,
): NoteContent {
  return readNoteFile(decryptText(keys, blob, pendingContext(ref)));
}

/** Encrypts a note title kept apart from its note, as base64url. */
export function encryptTitle(key: WorkspaceKey, ref: NoteRef, title: string): string {
  return toBase64Url(encryptText(key, title, titleContext(ref)));
}

/** Decrypts a title from `encryptTitle`. */
export function decryptTitle(keys: WorkspaceKeys, ref: NoteRef, encTitle: string): string {
  return decryptText(keys, fromBase64Url(encTitle), titleContext(ref));
}

/** Encrypts a folder name as the `encName` field. */
export function encryptFolderName(key: WorkspaceKey, ref: FolderRef, name: string): string {
  return toBase64Url(encryptText(key, name, folderNameContext(ref)));
}

/** Decrypts a folder's `encName`. */
export function decryptFolderName(keys: WorkspaceKeys, ref: FolderRef, encName: string): string {
  return decryptText(keys, fromBase64Url(encName), folderNameContext(ref));
}

/**
 * Encrypts the name a person gives a connected agent (`encName` of `approveConnect`, shown by
 * `listTokens`), bound to its token.
 */
export function encryptAgentName(key: WorkspaceKey, ref: AgentRef, name: string): string {
  return toBase64Url(encryptText(key, name, agentNameContext(ref)));
}

/** Decrypts an agent's `encName`. */
export function decryptAgentName(keys: WorkspaceKeys, ref: AgentRef, encName: string): string {
  return decryptText(keys, fromBase64Url(encName), agentNameContext(ref));
}

/** An extension's name is padded to a multiple of this many bytes before it is encrypted. */
const NAME_PAD_BYTES = 64;

/** Encrypts the name a person gives a paired extension as its `encName`, bound to its ID. */
export function encryptExtensionName(key: WorkspaceKey, ref: ExtensionRef, name: string): string {
  // padded with NUL characters to 64-byte steps, so its size doesn't give the name's length away
  const clean = name.split("\u0000").join("");
  const bytes = utf8Encode(clean).length;
  const padded =
    clean +
    "\u0000".repeat(Math.ceil(Math.max(bytes, 1) / NAME_PAD_BYTES) * NAME_PAD_BYTES - bytes);
  return toBase64Url(encryptText(key, padded, extensionNameContext(ref)));
}

/** Decrypts an extension's `encName` (its padding dropped). */
export function decryptExtensionName(
  keys: WorkspaceKeys,
  ref: ExtensionRef,
  encName: string,
): string {
  const padded = decryptText(keys, fromBase64Url(encName), extensionNameContext(ref));
  let end = padded.length;
  while (end > 0 && padded.charCodeAt(end - 1) === 0) end--;
  return padded.slice(0, end);
}

/** Encrypts a workspace name as the `encName` field. */
export function encryptWorkspaceName(key: WorkspaceKey, workspaceId: string, name: string): string {
  return toBase64Url(encryptText(key, name, workspaceNameContext(workspaceId)));
}

/** Decrypts a workspace's `encName`. */
export function decryptWorkspaceName(
  keys: WorkspaceKeys,
  workspaceId: string,
  encName: string,
): string {
  return decryptText(keys, fromBase64Url(encName), workspaceNameContext(workspaceId));
}

/** An encrypted record: the bytes (what a signature's hash covers) and the `ciphertext` field. */
export interface SealedRecord {
  readonly bytes: Uint8Array;
  readonly ciphertext: string;
}

function seal(bytes: Uint8Array): SealedRecord {
  return { bytes, ciphertext: toBase64Url(bytes) };
}

/** Encrypts a comment record (author, anchor, parent, status and text) as JSON. */
export function encryptComment(key: WorkspaceKey, ref: RecordRef, record: unknown): SealedRecord {
  return seal(encryptJson(key, record, commentContext(ref)));
}

/** Decrypts a comment record. Validate its shape before trusting it. */
export function decryptComment(keys: WorkspaceKeys, ref: RecordRef, ciphertext: string): unknown {
  return decryptJson(keys, fromBase64Url(ciphertext), commentContext(ref));
}

/** Encrypts a history event's details as JSON. */
export function encryptEvent(key: WorkspaceKey, ref: RecordRef, record: unknown): SealedRecord {
  return seal(encryptJson(key, record, eventContext(ref)));
}

/** Decrypts an event's details. Validate their shape before trusting them. */
export function decryptEvent(keys: WorkspaceKeys, ref: RecordRef, ciphertext: string): unknown {
  return decryptJson(keys, fromBase64Url(ciphertext), eventContext(ref));
}

/** Encrypts an agent's check record as JSON. */
export function encryptCheck(key: WorkspaceKey, ref: RecordRef, record: unknown): SealedRecord {
  return seal(encryptJson(key, record, checkContext(ref)));
}

/** Decrypts a check record. Validate its shape before trusting it. */
export function decryptCheck(keys: WorkspaceKeys, ref: RecordRef, ciphertext: string): unknown {
  return decryptJson(keys, fromBase64Url(ciphertext), checkContext(ref));
}
