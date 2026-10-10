import { clipSignatureValid, readClipJson } from "../../clip/frame.js";
import { clipNoteText } from "../../core/clips/index.js";
import { removeField } from "../../core/frontmatter/index.js";
import type { EventRecord } from "../../core/history/index.js";
import { parseNote, serializeNote } from "../../core/note/index.js";
import { fromBase64Url, toBase64Url } from "../../crypto/index.js";
import { utf8Encode } from "../../crypto/encoding.js";
import type { ClipPayload } from "../../clip/payload.js";
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
  const record = {
    type: "clipped" as const,
    actor: details.actor,
    at: details.at,
    version: 1,
    clipId: clip.payload.clipId,
    extensionId: clip.payload.extensionId,
    payload: clip.json,
    signature: toBase64Url(clip.signature),
  };
  // padded with spaces in `pad` (which readers ignore) so its JSON, as encrypted, is a multiple
  // of 1 KiB: the record's size says no more about the clip than the queue's did
  const bytes = utf8Encode(JSON.stringify({ ...record, pad: "" })).length;
  const pad = " ".repeat(Math.ceil(bytes / RECORD_PAD_BYTES) * RECORD_PAD_BYTES - bytes);
  return { ...record, pad };
}

/** A note's text without the filer's own stamps (`generated`, `verified`). */
function withoutStamps(text: string): string {
  return serializeNote(removeField(removeField(parseNote(text), "generated"), "verified"));
}

/**
 * Whether a note text is exactly the note a clip makes (`clipNoteText`), the filer's own
 * `generated` and `verified` stamps aside.
 */
export function isClipNoteText(text: string, payload: ClipPayload): boolean {
  try {
    return withoutStamps(text) === clipNoteText(payload);
  } catch {
    return false;
  }
}

/** Bytes the JSON of a `clipped` record is padded to a multiple of. */
const RECORD_PAD_BYTES = 1024;

/**
 * Whether a note's `clipped` record holds, so a client may show "Saved from <extension>": its
 * payload is a clean clip in canonical form naming this record's clip and extension and this
 * workspace, the extension's signature over it verifies under `signPublicKey` (the extension's
 * key the owner vouched for, `fetchExtensions`), `clipNoteId(clipId)` is this note's ID and the
 * note's first version is exactly the note the payload makes (`clipNoteText`), the filer's
 * `generated` and `verified` stamps aside. Otherwise show only the version's signer.
 */
export function verifyClippedRecord(
  record: ClippedRecord,
  expected: {
    readonly workspaceId: string;
    readonly noteId: string;
    /** The text of the note's version 1 (null when it can't be read). */
    readonly firstVersionText: string | null;
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
      expected.firstVersionText === null ||
      withoutStamps(expected.firstVersionText) !== clipNoteText(payload)
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
