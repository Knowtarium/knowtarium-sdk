import { concatBytes, uint32BE, utf8Encode } from "./encoding.js";
import { CryptoError } from "./errors.js";

// What an envelope is, bound as associated data so the server can't serve one blob in place of
// another (another note, another workspace, a name as a body, a chunk out of order). Required on
// every encrypt and decrypt, and encoded without ambiguity:
//
//   u32(len) kind || u32(len) workspaceId || u32(len) id  [|| u32 chunkIndex || u32 chunkCount]
//
// u32 is a big-endian uint32 and each string is UTF-8 prefixed by its byte length. The chunk
// fields exist only for "attachment_chunk".

/** The kinds of encrypted blob. */
export const BLOB_KINDS = [
  "note",
  "pending_change",
  "title",
  "folder_name",
  "workspace_name",
  "comment",
  "event",
  "check",
  "attachment_chunk",
  "attachment_meta",
  "search_index",
  "agent_name",
  "graph_layout",
] as const;

/** One kind of encrypted blob. */
export type BlobKind = (typeof BLOB_KINDS)[number];

/**
 * What a blob is. `id` is the id of the thing encrypted: the note id for "note" and "title"; for
 * "pending_change", whose ID the server makes only after the upload, the proposal's binding
 * `<noteId>:<folderId>:<baseVersion>:<nonce>` (the note, the folder it goes to, the version it
 * builds on and the agent's random nonce, which the server stores as `clientNonce`); the folder,
 * comment, event or check record id; the workspace id for "workspace_name"; the attachment id for
 * "attachment_chunk" and "attachment_meta" (an attachment's JSON metadata: its file name, media
 * type and size); and for "search_index" (a client's serialized local search index, kept only
 * in its own encrypted cache) the id of the index, by default the workspace id; for "agent_name"
 * (the name a person gives a connected agent, such as "Laptop Claude Code") the agent token id;
 * for "graph_layout" (a client's saved graph positions, kept only in its own encrypted cache, like
 * "search_index") the id of the layout, by default the workspace id.
 */
export type BlobContext =
  | {
      readonly kind: Exclude<BlobKind, "attachment_chunk">;
      readonly workspaceId: string;
      readonly id: string;
    }
  | {
      readonly kind: "attachment_chunk";
      readonly workspaceId: string;
      readonly id: string;
      /** 0-based position of this chunk. */
      readonly chunkIndex: number;
      /** How many chunks the attachment has, so a dropped tail fails to decrypt. */
      readonly chunkCount: number;
    };

const KINDS = new Set<string>(BLOB_KINDS);

/** The associated-data encoding of a context. Throws `invalid_input` for a malformed one. */
export function encodeBlobContext(context: BlobContext): Uint8Array {
  const raw: unknown = context;
  const { kind, workspaceId, id } = (raw ?? {}) as Partial<Record<string, unknown>>;
  const text = (value: unknown) => typeof value === "string" && value.length > 0;
  if (typeof kind !== "string" || !KINDS.has(kind) || !text(workspaceId) || !text(id)) {
    throw new CryptoError("invalid_input", "a blob context needs a known kind, workspaceId and id");
  }
  const parts = [kind, workspaceId as string, id as string].map((value) => {
    const bytes = utf8Encode(value);
    return concatBytes(uint32BE(bytes.length), bytes);
  });
  if (context.kind === "attachment_chunk") {
    const { chunkIndex, chunkCount } = context;
    if (
      !Number.isInteger(chunkCount) ||
      !Number.isInteger(chunkIndex) ||
      chunkIndex < 0 ||
      chunkIndex >= chunkCount
    ) {
      throw new CryptoError("invalid_input", "a chunk index must be below the chunk count");
    }
    parts.push(uint32BE(chunkIndex), uint32BE(chunkCount));
  }
  return concatBytes(...parts);
}
