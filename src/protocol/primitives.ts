import { z } from "zod";

/** Length of the unpadded base64url encoding of `bytes` bytes. */
export function base64UrlLength(bytes: number): number {
  return Math.ceil((bytes * 8) / 6);
}

/**
 * Bytes as unpadded base64url (RFC 4648 section 5). Every binary value in a JSON body (ciphertext,
 * keys, hashes, salts, signatures) uses it. A length of 1 mod 4 can never be valid.
 */
export const Base64Url = z
  .string()
  .regex(/^[A-Za-z0-9_-]*$/, { error: "Expected unpadded base64url" })
  .refine((value) => value.length % 4 !== 1, { error: "Not a valid base64url length" });

/** An ISO 8601 UTC timestamp with a `Z` suffix, for example `2026-09-30T12:00:00.000Z`. */
export const Timestamp = z.iso.datetime();
export type Timestamp = z.infer<typeof Timestamp>;

/**
 * A timestamp inside a signed envelope: always exactly milliseconds, `2026-09-30T12:00:00.000Z`,
 * so the signed text has one form.
 */
export const SignedTimestamp = z.iso.datetime({ precision: 3 });
export type SignedTimestamp = z.infer<typeof SignedTimestamp>;

/** A note version or workspace version. 0 means "nothing yet" (a new note, the start of a feed). */
export const Version = z.int().nonnegative();
export type Version = z.infer<typeof Version>;

/** A byte count (always of ciphertext: the server never knows plaintext sizes). */
export const SizeBytes = z.int().nonnegative();

/** The generation of a workspace key, starting at 1 and bumped on every rotation. */
export const KeyGeneration = z.int().positive();

/** An account email, the one piece of plaintext identity the server keeps. */
export const Email = z.email().max(254);

/** The body of a successful call that has nothing else to return. */
export const Ok = z.object({ ok: z.literal(true) });
export type Ok = z.infer<typeof Ok>;

/** An opaque secret issued by the server (agent tokens, grants, tickets, email links). */
export function secretSchema(prefix: string) {
  return z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]{32,128}$`), {
    error: `Expected a ${prefix}_ secret`,
  });
}

/** A version in a query string (`?since=12`). */
export const QueryVersion = z.coerce.number().int().nonnegative();
