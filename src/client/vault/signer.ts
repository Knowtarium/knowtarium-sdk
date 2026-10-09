import type { SigningKeyPair } from "../../crypto/index.js";

/** A person who signs: the account ID the server knows and the unlocked account signing key. */
export interface Signer {
  readonly accountId: string;
  readonly signing: SigningKeyPair;
  /** Milliseconds since the epoch, for `createdAt`; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** `createdAt` for an envelope signed now: UTC with milliseconds, as the protocol requires. */
export function signedAtNow(signer: Signer): string {
  return new Date((signer.now ?? Date.now)()).toISOString();
}
