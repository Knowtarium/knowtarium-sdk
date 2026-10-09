import { z } from "zod";

/*
 * History events, on decrypted data. A person's edits, deletes, approvals and rejections are
 * recorded by the server from the signed write itself (only the signed envelope, no ciphertext),
 * and so is an agent's direct write (`agent_edited`, signed with the agent's own key, which the
 * owner vouched for); agents append their events (`proposed`, `checked`, `wrote`) as encrypted
 * records; a person can append signed records too (`restored`, `imported`). The client decrypts
 * the records and verifies the signatures; core turns both into typed events.
 */

/**
 * Whether a signature backs an entry:
 *
 * - `verified`: a person's signature that verifies with the trusted key and matches the entry,
 *   or an agent's direct write (`agent_edited`) under a key the owner vouched for (who signed it
 *   is the event's `tokenId`; it never stands for a person)
 * - `invalid`: a signature is there but doesn't verify or names something else
 * - `unsigned`: no signature, and none expected (an agent's event or check)
 * - `unconfirmed`: it claims to be a person's (a `human:` actor or an account author) but no valid
 *   signature backs it; show it as unconfirmed, never as the person's
 */
export type SignatureStatus = "verified" | "invalid" | "unsigned" | "unconfirmed";

const Text = (max: number) => z.string().max(max);
const Actor = z.string().min(1).max(200);
/** An ISO 8601 date-time with `Z` or an offset. */
export const RecordTime = z.iso.datetime({ offset: true });
const At = RecordTime;
const Version = z.int().nonnegative();

/** A conflict an agent's check found: another note that disagrees, and why. */
export const CheckConflict = z.looseObject({ noteId: Text(64), detail: Text(4000).optional() });
export type CheckConflict = z.infer<typeof CheckConflict>;

/** What an agent's check found (inside a `checked` event or a check record). */
export const CheckFindings = z.looseObject({
  actor: Actor,
  at: At,
  result: z.enum(["pass", "fail"]),
  /** The notes the agent looked at. */
  scope: z.array(Text(64)).max(1000).default([]),
  conflicts: z.array(CheckConflict).max(200).default([]),
  summary: Text(4000).optional(),
});
export type CheckFindings = z.infer<typeof CheckFindings>;

/**
 * The encrypted part of an appended event. Fields this version doesn't know are kept (loose
 * objects), so a record written by a newer client survives a read and write by an older one.
 */
export const EventRecord = z.discriminatedUnion("type", [
  z.looseObject({
    type: z.literal("proposed"),
    actor: Actor,
    at: At,
    baseVersion: Version,
    pendingId: Text(64).optional(),
    summary: Text(4000).optional(),
  }),
  CheckFindings.extend({ type: z.literal("checked"), version: Version }),
  z.looseObject({
    type: z.literal("restored"),
    actor: Actor,
    at: At,
    fromVersion: Version,
    version: Version,
  }),
  /**
   * An agent's note on its own direct write (the version `agent_edited` made): who it is and a
   * short summary of the change. Unsigned and optional: the signed `agent_edited` is the proof.
   */
  z.looseObject({
    type: z.literal("wrote"),
    actor: Actor,
    at: At,
    version: Version,
    summary: Text(4000).optional(),
  }),
  z.looseObject({
    type: z.literal("imported"),
    actor: Actor,
    at: At,
    source: z.enum(["okf", "obsidian"]),
    path: Text(1024).optional(),
  }),
]);
export type EventRecord = z.infer<typeof EventRecord>;

/** A history event as the timeline shows it. */
export type HistoryEvent =
  | { readonly type: "edited"; readonly version: number; readonly folderId?: string }
  | { readonly type: "deleted"; readonly version: number }
  | { readonly type: "approved"; readonly version: number; readonly pendingId: string }
  /** A person's session wrote an agent's passing check into the note (not a person's check). */
  | { readonly type: "check_applied"; readonly version: number; readonly checkId: string }
  /**
   * An agent's direct write, signed with its own key: the agent token, and the agent policy
   * revision it checked (with that revision's hash).
   */
  | {
      readonly type: "agent_edited";
      readonly version: number;
      readonly folderId?: string;
      readonly tokenId: string;
      readonly revision: number;
      readonly policySha256: string;
    }
  | { readonly type: "rejected"; readonly pendingId: string; readonly commentId?: string }
  | Exclude<EventRecord, { type: "checked" }>
  | (CheckFindings & { readonly type: "checked"; readonly version: number })
  /** A record that couldn't be decrypted or read. */
  | { readonly type: "unreadable" };

/** The server-visible fields of a signed envelope that make up an event. */
export interface SignedFields {
  readonly type: string;
  /** The signing person's account. */
  readonly accountId?: string;
  readonly version?: number;
  readonly folderId?: string;
  readonly pendingId?: string;
  readonly commentId?: string;
  readonly checkId?: string;
  /** For `agent_edited`: the agent token that signed it. */
  readonly tokenId?: string;
  /** For `agent_edited`: the agent policy revision it checked. */
  readonly revision?: number;
  /** For `agent_edited`: that revision's hash. */
  readonly policySha256?: string;
}

/** What the client knows about one stored event, after decrypting and verifying it. */
export interface EventSource {
  /** The signed envelope's fields, when the event carries one. */
  readonly signed: SignedFields | null;
  /** Whether that signature verified (and matched the event); ignored without one. */
  readonly signatureValid: boolean;
  /** The decrypted record, when the event has ciphertext; `undefined` when it has none. */
  readonly record?: unknown;
  /** Whether the server lists a person (an account) as the author. */
  readonly authorIsPerson: boolean;
}

function fromSigned(signed: SignedFields): HistoryEvent | null {
  const { type, version, pendingId } = signed;
  if (type === "edited" && version !== undefined) {
    return signed.folderId === undefined
      ? { type, version }
      : { type, version, folderId: signed.folderId };
  }
  if (type === "deleted" && version !== undefined) return { type, version };
  if (type === "check_applied" && version !== undefined && signed.checkId !== undefined) {
    return { type, version, checkId: signed.checkId };
  }
  if (type === "agent_edited" && version !== undefined) {
    const { tokenId, revision, policySha256 } = signed;
    if (tokenId === undefined || revision === undefined || policySha256 === undefined) return null;
    return {
      type,
      version,
      ...(signed.folderId === undefined ? {} : { folderId: signed.folderId }),
      tokenId,
      revision,
      policySha256,
    };
  }
  if (type === "approved" && version !== undefined && pendingId !== undefined) {
    return { type, version, pendingId };
  }
  if (type === "rejected" && pendingId !== undefined) {
    return signed.commentId === undefined
      ? { type, pendingId }
      : { type, pendingId, commentId: signed.commentId };
  }
  return null;
}

/** The actor a record names, if any. */
function actorOf(record: unknown): string | undefined {
  const actor = (record as { actor?: unknown } | null)?.actor;
  return typeof actor === "string" ? actor : undefined;
}

/** Whether a record's actor claims a person (`human:`). */
function claimsHuman(actor: string | undefined): boolean {
  return actor?.startsWith("human:") ?? false;
}

function parseRecord(record: unknown): HistoryEvent | null {
  const parsed = EventRecord.safeParse(record);
  return parsed.success ? parsed.data : null;
}

/**
 * Types a stored event and says how far to trust it:
 *
 * - a signed write (`edited`, `deleted`, `approved`, `rejected`, an agent's `agent_edited`) is
 *   its envelope, and carries no record of its own: one that does is `invalid`;
 * - a record counts as a person's only under a valid `recorded` envelope whose signer is the
 *   person the record names (`actor` equal to `human:<the signer's account>`), else `invalid`;
 * - an unsigned record is an agent's (`unsigned`), unless it claims a person (a `human:` actor
 *   or an account as author): then it is `unconfirmed`.
 *
 * A record that doesn't fit the schema is `unreadable`.
 */
export function readHistoryEvent(source: EventSource): {
  readonly event: HistoryEvent;
  readonly actor?: string;
  readonly signature: SignatureStatus;
} {
  const { signed, record } = source;
  const actor = actorOf(record);
  const withActor = actor === undefined ? {} : { actor };
  if (signed !== null && signed.type !== "recorded") {
    const event = fromSigned(signed) ?? { type: "unreadable" as const };
    const signature = source.signatureValid && record === undefined ? "verified" : "invalid";
    return { event, ...withActor, signature };
  }
  const event = (record === undefined ? null : parseRecord(record)) ?? {
    type: "unreadable" as const,
  };
  if (signed !== null) {
    const signerMatches =
      !claimsHuman(actor) ||
      (signed.accountId !== undefined && actor === `human:${signed.accountId}`);
    const valid = source.signatureValid && record !== undefined && signerMatches;
    return { event, ...withActor, signature: valid ? "verified" : "invalid" };
  }
  const claimsPerson = source.authorIsPerson || claimsHuman(actor);
  return { event, ...withActor, signature: claimsPerson ? "unconfirmed" : "unsigned" };
}
