import { clipSignatureValid, readClipJson } from "../../clip/frame.js";
import type { EventRecord } from "../../core/history/index.js";
import { fromBase64Url, toBase64Url } from "../../crypto/index.js";
import { sodium } from "../../crypto/sodium.js";
import { type ClipId, clipNoteId } from "../../protocol/index.js";
import type { OpenedClip } from "./open.js";

/** A filed clip's history record (`clipped`): who filed it, and the extension-signed payload. */
export type ClippedRecord = Extract<EventRecord, { type: "clipped" }>;

/** The `clipped` record of a clip filed as version 1 of its note, by `actor` at `at`. */
export function clippedRecord(
  clip: OpenedClip,
  details: { readonly actor: string; readonly at: string },
): ClippedRecord {
  return {
    type: "clipped",
    actor: details.actor,
    at: details.at,
    version: 1,
    clipId: clip.payload.clipId,
    extensionId: clip.payload.extensionId,
    payload: clip.json,
    signature: toBase64Url(clip.signature),
  };
}

/**
 * Whether a note's `clipped` record holds, so a client may show "Saved from <extension>": its
 * payload is a clean clip in canonical form naming this record's clip and extension and this
 * workspace, the extension's signature over it verifies under `signPublicKey` (the extension's
 * key the owner vouched for, `fetchExtensions`), `clipNoteId(clipId)` is this note's ID and the
 * payload's `url` is the `url` of the note's first version. Otherwise show only the version's
 * signer.
 */
export function verifyClippedRecord(
  record: ClippedRecord,
  expected: {
    readonly workspaceId: string;
    readonly noteId: string;
    /** The `url` frontmatter value of the note's version 1. */
    readonly firstVersionUrl: string | null;
    /** The record's extension's owner-vouched Ed25519 public key. */
    readonly signPublicKey: Uint8Array;
  },
): boolean {
  try {
    const payload = readClipJson(record.payload);
    if (
      payload.clipId !== record.clipId ||
      payload.extensionId !== record.extensionId ||
      payload.workspaceId !== expected.workspaceId ||
      clipNoteId(payload.clipId as ClipId) !== expected.noteId ||
      expected.firstVersionUrl === null ||
      payload.url !== expected.firstVersionUrl
    ) {
      return false;
    }
    return clipSignatureValid(
      sodium(),
      payload,
      fromBase64Url(record.signature),
      expected.signPublicKey,
    );
  } catch {
    return false;
  }
}
