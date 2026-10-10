import { canonicalJson } from "../crypto/canonical-json.js";
import { utf8Encode } from "../crypto/encoding.js";
import { ClipError } from "./errors.js";

// A clip: what the extension saves from a tab. The payload is cleaned (`normalizeClip`) by the
// extension and checked again by every filer, which refuses a payload the cleaning would change,
// so no title, note or category can hide text from the person or the agent (bidi controls,
// invisible format characters) or break a file name. Its signature covers
//
//   "knowtarium-clip-v1\n" + canonical JSON of the payload (RFC 8785, integers only)
//
// and the signed plaintext (frame.ts) carries the signature next to that JSON. The payload names
// its clip, workspace and extension, since a sealed box binds no associated data: the filer
// checks each one against the queue entry.

/** The payload's `v`, and the version byte of the signed plaintext and the sealed clip. */
export const CLIP_FORMAT_VERSION = 1;

/** Limits of a clip's fields and of the sealed clip. Characters are Unicode code points. */
export const CLIP_LIMITS = {
  /** The link, as `new URL(raw).href`, in UTF-8 bytes. */
  urlBytes: 2048,
  titleChars: 300,
  noteChars: 4000,
  /** After `normalizeCategory`, which cuts a longer name. */
  categoryChars: 60,
  /** The sealed clip, header included (the sync API refuses a larger one). */
  sealedBytes: 24 * 1024,
  /** The signed plaintext is padded to a multiple of this, so sizes leak only in 1 KiB steps. */
  padBlockBytes: 1024,
} as const;

/** What the extension signs and seals. */
export interface ClipPayload {
  readonly v: typeof CLIP_FORMAT_VERSION;
  /** `clip_<body>`, made by the extension from 16 random bytes (`createClipId`). */
  readonly clipId: string;
  /** The paired workspace (`ws_...`). */
  readonly workspaceId: string;
  /** The extension's own ID (`ext_...`), from the pairing. */
  readonly extensionId: string;
  /** An `http:` or `https:` link, as `new URL(raw).href`. */
  readonly url: string;
  /** The page title as the person kept it (may be empty). */
  readonly title: string;
  /** The person's note (may be empty); keeps line breaks and tabs. */
  readonly note: string;
  /** A category name (`normalizeCategory`); empty means the inbox folder itself. */
  readonly category: string;
  /** When it was saved, by the extension's clock, as `toISOString()` writes it (display only). */
  readonly savedAt: string;
}

/** What `normalizeClip` takes: a payload before cleaning (`v` optional; text fields default to ""). */
export interface ClipInput {
  readonly v?: number;
  readonly clipId: string;
  readonly workspaceId: string;
  readonly extensionId: string;
  readonly url: string;
  readonly title?: string;
  readonly note?: string;
  readonly category?: string;
  readonly savedAt: string;
}

/** The prefix of the message a clip's signature covers. */
export const CLIP_SIGNING_PREFIX = "knowtarium-clip-v1\n";

const PAYLOAD_KEYS = [
  "v",
  "clipId",
  "workspaceId",
  "extensionId",
  "url",
  "title",
  "note",
  "category",
  "savedAt",
] as const;

const ID_BODY = "[0-7][0-9a-hjkmnp-tv-z]{25}";
const CLIP_ID = new RegExp(`^clip_${ID_BODY}$`);
const WORKSPACE_ID = new RegExp(`^ws_${ID_BODY}$`);
const EXTENSION_ID = new RegExp(`^ext_${ID_BODY}$`);
const ISO_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Control (Cc), format (Cf, the bidi controls among them) and lone surrogate (Cs) characters. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}]/gu;
const ZERO_WIDTH_JOINER = "‍";
/** What a file name can't hold on some system (core's `UNSAFE`, controls and bidi aside). */
const TITLE_UNSAFE = /[\\*?"<>|]/g;
const NAME_UNSAFE = /[\\/:*?"<>|]/g;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * Text without control and format characters (U+200D, which joins emoji, stays). With
 * `keepLines`, line breaks (CR LF and CR become LF) and tabs stay too. Callers apply NFC after
 * their own removals, so a removal can't leave a sequence NFC would compose on a second pass.
 */
function visible(text: string, keepLines: boolean): string {
  const unified = keepLines ? text.replace(/\r\n?/g, "\n") : text;
  return unified.replace(INVISIBLE, (char) =>
    char === ZERO_WIDTH_JOINER || (keepLines && (char === "\n" || char === "\t")) ? char : "",
  );
}

/** Code points in `text`. */
function length(text: string): number {
  return Array.from(text).length;
}

/** The first `max` code points of `text`. */
function cut(text: string, max: number): string {
  return Array.from(text).slice(0, max).join("");
}

/** As a case-insensitive file system compares names (core's `foldName`). */
function fold(name: string): string {
  return name.normalize("NFC").toUpperCase().toLowerCase();
}

/**
 * A category name as a folder under the inbox: cleaned like any clip text, trimmed, inner
 * whitespace collapsed, every character a file name can't hold (`\ / : * ? " < > |`) replaced with
 * `-` (as core's `safeSegment` does), leading dots and spaces and trailing ones dropped, a
 * Windows reserved name prefixed with `_`, cut to 60 characters. `Inbox` in any letter case is
 * the inbox itself: empty.
 */
export function normalizeCategory(name: string): string {
  let text = visible(name, false)
    .replace(NAME_UNSAFE, "-")
    .replace(/\s+/gu, " ")
    .normalize("NFC")
    .replace(/^[.\s]+/u, "");
  text = cut(text, CLIP_LIMITS.categoryChars).replace(/[.\s]+$/u, "");
  if (WINDOWS_RESERVED.test(text)) {
    text = cut(`_${text}`, CLIP_LIMITS.categoryChars).replace(/[.\s]+$/u, "");
  }
  return fold(text) === "inbox" ? "" : text;
}

/** The WHATWG URL parser, typed by hand: `src/` has neither DOM nor Node types on purpose. */
interface UrlParser {
  URL: new (input: string) => { readonly href: string; readonly protocol: string };
}
const { URL } = globalThis as unknown as UrlParser;

/** The link as `new URL(raw).href`: `http:` or `https:` only, at most 2,048 bytes. */
function normalizeUrl(raw: unknown): string {
  if (typeof raw !== "string") throw new ClipError("bad_url", "the link must be a string");
  let url: { readonly href: string; readonly protocol: string };
  try {
    url = new URL(raw);
  } catch {
    throw new ClipError("bad_url", "the link isn't a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ClipError("bad_url", "only http: and https: links can be saved");
  }
  if (utf8Encode(url.href).length > CLIP_LIMITS.urlBytes) {
    throw new ClipError("too_long", "the link is over 2,048 bytes");
  }
  return url.href;
}

function text(value: unknown, field: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new ClipError("invalid", `${field} must be a string`);
  return value;
}

function matching(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ClipError("invalid", `${field} is malformed`);
  }
  return value;
}

/**
 * A clip payload made valid: IDs and `savedAt` checked; the link `http:` or `https:` as
 * `new URL(raw).href`; every text field without control and format characters (bidi controls
 * included; U+200D stays, and the note keeps line breaks and tabs) and in NFC; the title also
 * without `\ * ? " < > |` and trimmed; the category through `normalizeCategory`. Throws
 * `ClipError` (`invalid`, `bad_url` or `too_long`) when a field can't be made valid; a title, note
 * or link over its limit is refused, not cut. The extension calls it before signing, and every
 * filer checks the payload it opened is already in this form.
 */
export function normalizeClip(input: ClipInput): ClipPayload {
  // a filer passes what it parsed from an opened clip: anything at all
  const value: unknown = input;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ClipError("invalid", "a clip is an object");
  }
  for (const key of Object.keys(input)) {
    if (!(PAYLOAD_KEYS as readonly string[]).includes(key)) {
      throw new ClipError("invalid", "a clip has no such field");
    }
  }
  if (input.v !== undefined && input.v !== CLIP_FORMAT_VERSION) {
    throw new ClipError("invalid", "unsupported clip version");
  }
  const savedAt = matching(input.savedAt, ISO_MILLISECONDS, "savedAt");
  const time = Date.parse(savedAt);
  if (Number.isNaN(time) || new Date(time).toISOString() !== savedAt) {
    throw new ClipError("invalid", "savedAt is not a real time");
  }
  const title = visible(text(input.title, "title"), false)
    .replace(TITLE_UNSAFE, "")
    .normalize("NFC")
    .trim();
  const note = visible(text(input.note, "note"), true).normalize("NFC");
  const rawCategory = text(input.category, "category");
  if (length(title) > CLIP_LIMITS.titleChars) {
    throw new ClipError("too_long", "the title is over 300 characters");
  }
  if (length(note) > CLIP_LIMITS.noteChars) {
    throw new ClipError("too_long", "the note is over 4,000 characters");
  }
  return {
    v: CLIP_FORMAT_VERSION,
    clipId: matching(input.clipId, CLIP_ID, "clipId"),
    workspaceId: matching(input.workspaceId, WORKSPACE_ID, "workspaceId"),
    extensionId: matching(input.extensionId, EXTENSION_ID, "extensionId"),
    url: normalizeUrl(input.url),
    title,
    note,
    category: normalizeCategory(rawCategory),
    savedAt,
  };
}

/** The payload's canonical JSON, the text its signature covers after the prefix. */
export function clipCanonicalJson(payload: ClipPayload): string {
  return canonicalJson({ ...payload });
}

/** The exact bytes a clip's signature covers. */
export function clipSigningMessage(payload: ClipPayload): Uint8Array {
  return utf8Encode(CLIP_SIGNING_PREFIX + clipCanonicalJson(payload));
}

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** `clip_` and 16 random bytes as 26 base32 digits, like every Knowtarium ID (`formatId`). */
export function formatClipId(random: Uint8Array): string {
  if (random.length !== 16) throw new ClipError("invalid", "a clip ID takes 16 random bytes");
  let value = 0n;
  for (const byte of random) value = (value << 8n) | BigInt(byte);
  let body = "";
  for (let i = 0; i < 26; i++) {
    body = ID_ALPHABET.charAt(Number(value & 31n)) + body;
    value >>= 5n;
  }
  return `clip_${body}`;
}
