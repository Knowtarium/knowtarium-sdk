// Wrapped key records as `listKeys` returns them, for the client tests. Not exported.
import { type SignedWrappedKey, toBase64Url } from "../../crypto/index.js";
import type {
  KeyRecipient,
  SignedEvent,
  SignedKeyGeneration,
  WorkspaceId,
  WrappedWorkspaceKey,
} from "../../protocol/index.js";

/** A wrapped key as `listKeys` returns it. */
export function wrappedRecord(
  workspaceId: WorkspaceId,
  recipient: KeyRecipient,
  signedKey: SignedWrappedKey,
  keyGeneration: number,
): WrappedWorkspaceKey {
  return {
    workspaceId,
    recipient,
    keyGeneration,
    encWorkspaceKey: toBase64Url(signedKey.wrapped),
    createdAt: signedKey.signed.envelope.createdAt,
    signed: {
      envelope: signedKey.signed.envelope,
      signature: signedKey.signed.signature,
    } as SignedEvent,
    signedGeneration: {
      envelope: signedKey.signedGeneration.envelope,
      signature: signedKey.signedGeneration.signature,
    } as SignedKeyGeneration,
  };
}
