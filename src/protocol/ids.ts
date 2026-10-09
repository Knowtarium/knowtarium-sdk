import { z } from "zod";

/**
 * IDs are `<prefix>_<body>`: the body is 26 characters of lowercase Crockford base32 (the ULID
 * alphabet) holding 128 random bits, so the first character is 0 to 7. Clients create workspace,
 * folder, note, event, comment, check, attachment and agent token IDs themselves; the server
 * creates the rest (accounts and sessions through Better Auth's `generateId`, pending changes,
 * connect requests, and the events it records from signed writes).
 *
 * Retries are idempotent: a create sent again with the same ID and the same body returns the
 * original result; the same ID with a different body answers `already_exists`.
 */
export const ID_PREFIXES = {
  account: "acc",
  session: "ses",
  workspace: "ws",
  folder: "fld",
  note: "note",
  pending: "pc",
  event: "evt",
  comment: "cmt",
  check: "chk",
  token: "tok",
  connectRequest: "cr",
  attachment: "att",
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

export const ID_BODY_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export const ID_BODY_LENGTH = 26;
/** How many random bytes `formatId` expects. */
export const ID_RANDOM_BYTES = 16;

const bodyPattern = `[0-7][${ID_BODY_ALPHABET}]{${String(ID_BODY_LENGTH - 1)}}`;

function idSchema<const P extends IdPrefix>(prefix: P) {
  const pattern = new RegExp(`^${prefix}_${bodyPattern}$`);
  return z.custom<`${P}_${string}`>((value) => typeof value === "string" && pattern.test(value), {
    error: `Expected a ${prefix}_ id`,
  });
}

/**
 * Builds an ID from 16 random bytes (the caller supplies them, so this package needs no random
 * source): the bytes as a 128-bit number in 26 base32 digits.
 */
export function formatId<const P extends IdPrefix>(
  prefix: P,
  random: Uint8Array,
): `${P}_${string}` {
  if (random.length !== ID_RANDOM_BYTES) {
    throw new RangeError(`formatId needs ${String(ID_RANDOM_BYTES)} random bytes`);
  }
  let value = 0n;
  for (const byte of random) value = (value << 8n) | BigInt(byte);
  let body = "";
  for (let i = 0; i < ID_BODY_LENGTH; i++) {
    body = ID_BODY_ALPHABET.charAt(Number(value & 31n)) + body;
    value >>= 5n;
  }
  return `${prefix}_${body}`;
}

export const AccountId = idSchema(ID_PREFIXES.account);
export type AccountId = z.infer<typeof AccountId>;
export const SessionId = idSchema(ID_PREFIXES.session);
export type SessionId = z.infer<typeof SessionId>;
export const WorkspaceId = idSchema(ID_PREFIXES.workspace);
export type WorkspaceId = z.infer<typeof WorkspaceId>;
export const FolderId = idSchema(ID_PREFIXES.folder);
export type FolderId = z.infer<typeof FolderId>;
export const NoteId = idSchema(ID_PREFIXES.note);
export type NoteId = z.infer<typeof NoteId>;
export const PendingId = idSchema(ID_PREFIXES.pending);
export type PendingId = z.infer<typeof PendingId>;
export const EventId = idSchema(ID_PREFIXES.event);
export type EventId = z.infer<typeof EventId>;
export const CommentId = idSchema(ID_PREFIXES.comment);
export type CommentId = z.infer<typeof CommentId>;
export const CheckId = idSchema(ID_PREFIXES.check);
export type CheckId = z.infer<typeof CheckId>;
export const TokenId = idSchema(ID_PREFIXES.token);
export type TokenId = z.infer<typeof TokenId>;
export const ConnectRequestId = idSchema(ID_PREFIXES.connectRequest);
export type ConnectRequestId = z.infer<typeof ConnectRequestId>;
export const AttachmentId = idSchema(ID_PREFIXES.attachment);
export type AttachmentId = z.infer<typeof AttachmentId>;

/** Who did something: a person (their account) or an agent (its token). */
export const ActorId = z.union([AccountId, TokenId]);
export type ActorId = z.infer<typeof ActorId>;
