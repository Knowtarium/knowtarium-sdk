import {
  ciphertextSha256,
  type SignedEnvelope,
  type SigningKeyPair,
  type SignedEnvelopeFields,
  signEnvelope,
  signKeyGeneration,
  toBase64Url,
  type WorkspaceKey,
} from "../../crypto/index.js";
import {
  headerKey,
  SIGNATURE_HEADER,
  SIGNATURE_MAX_SKEW_SECONDS,
  SIGNED_AT_HEADER,
  SignedTimestamp,
} from "../../protocol/index.js";
import { RequestValidationError } from "../errors/index.js";
import { type Signer, signedAtNow } from "./signer.js";

// Builders for a person's signed envelopes, one per row of the table in protocol/signatures.ts.
// Each rebuilds exactly the envelope the server will rebuild from the request (same version
// arithmetic, same hashes), signs it, and returns what the request carries: `signedAt` and
// `signature` as body fields, or as headers on raw routes (`signingHeaders`). Every builder takes
// an optional `signedAt` (see `SigningTime`).

/** A signed envelope and the fields a request carries for it. */
export interface SignedAction {
  readonly signed: SignedEnvelope;
  /** The envelope's `createdAt`. */
  readonly signedAt: string;
  readonly signature: string;
}

/** The signing headers of a raw write (`writeNote`, `deleteNote`, `approvePending`). */
export function signingHeaders(action: SignedAction): {
  "knowtarium-signature": string;
  "knowtarium-signed-at": string;
} {
  return {
    [headerKey(SIGNATURE_HEADER)]: action.signature,
    [headerKey(SIGNED_AT_HEADER)]: action.signedAt,
  };
}

/** The signing fields of a JSON body. */
export function signingFields(action: SignedAction): { signedAt: string; signature: string } {
  return { signedAt: action.signedAt, signature: action.signature };
}

/**
 * When a signed write is signed. `signedAt` defaults to now; pass it to make the envelope's
 * `createdAt` equal a time the encrypted content names too (a frontmatter `verified` or history
 * entry written in the same save), with no clock shared between the two. It must be UTC with
 * milliseconds (`2026-10-01T12:00:00.000Z`, as `signedAtNow` writes it) and within
 * `SIGNATURE_MAX_SKEW_SECONDS` of now (the signer's clock), which the server enforces too;
 * otherwise the builder throws `RequestValidationError` before anything is signed or sent.
 */
export interface SigningTime {
  readonly signedAt?: string;
}

/** Where a signing time travels: the route, the request part and the field. */
type SignedAtPlace = readonly [route: string, part: "headers" | "body", key: string];

/**
 * Where each builder's signing time travels, for the error a bad `signedAt` throws. A
 * `key_generation` goes to three routes, so `signGeneration` names its own (`GenerationRoute`);
 * `wrapped_key` envelopes are signed by `wrapAndSignWorkspaceKey`, never with a caller's time.
 */
const SIGNED_AT_PLACE: Partial<Record<SignedEnvelopeFields["type"], SignedAtPlace>> = {
  edited: ["writeNote", "headers", SIGNED_AT_HEADER],
  check_applied: ["writeNote", "headers", SIGNED_AT_HEADER],
  deleted: ["deleteNote", "headers", SIGNED_AT_HEADER],
  approved: ["approvePending", "headers", SIGNED_AT_HEADER],
  rejected: ["rejectPending", "body", "signedAt"],
  commented: ["addComment", "body", "signedAt"],
  recorded: ["addEvent", "body", "signedAt"],
  token_revoked: ["revokeToken", "headers", SIGNED_AT_HEADER],
  folder_created: ["createFolder", "body", "signedAt"],
  folder_moved: ["updateFolder", "body", "signedAt"],
  agent_policy: ["setAgentPolicy", "body", "signedAt"],
  agent_key: ["approveConnect", "body", "agentKeySignedAt"],
  agent_edited: ["writeNoteAsAgent", "headers", SIGNED_AT_HEADER],
};

/**
 * The `createdAt` to sign for an envelope of `type`: `signedAt` once checked (see `SigningTime`),
 * or now.
 */
export function signingTime(
  signer: Signer,
  type: SignedEnvelopeFields["type"],
  signedAt: string | undefined,
  place: SignedAtPlace = SIGNED_AT_PLACE[type] ?? [type, "body", "signedAt"],
): string {
  if (signedAt === undefined) return signedAtNow(signer);
  const at = Date.parse(signedAt);
  const skew = Math.abs(at - (signer.now ?? Date.now)());
  if (
    !SignedTimestamp.safeParse(signedAt).success ||
    !(skew <= SIGNATURE_MAX_SKEW_SECONDS * 1000)
  ) {
    const [route, part, key] = place;
    throw new RequestValidationError(route, part, [key]);
  }
  return signedAt;
}

type Fields = Omit<SignedEnvelopeFields, "accountId" | "workspaceId" | "createdAt">;

function sign(
  signer: Signer,
  workspaceId: string,
  fields: Fields,
  createdAt?: string,
): SignedAction {
  const signedAt = signingTime(signer, fields.type, createdAt);
  const signed = signEnvelope(
    { ...fields, accountId: signer.accountId, workspaceId, createdAt: signedAt },
    signer.signing,
  );
  return { signed, signedAt, signature: signed.signature };
}

/**
 * `edited` for `writeNote`: the new version is the base version + 1. Pass `signedAt` when the
 * note's text names the same time (a `verified` entry written in the same save).
 */
export function signEdited(
  signer: Signer,
  details: {
    readonly workspaceId: string;
    readonly noteId: string;
    readonly folderId: string;
    readonly baseVersion: number;
    readonly ciphertext: Uint8Array;
  } & SigningTime,
): SignedAction {
  return sign(
    signer,
    details.workspaceId,
    {
      type: "edited",
      noteId: details.noteId,
      folderId: details.folderId,
      version: details.baseVersion + 1,
      ciphertextSha256: ciphertextSha256(details.ciphertext),
    },
    details.signedAt,
  );
}

/**
 * `check_applied` for a `writeNote` that applies an agent's passing check (`Knowtarium-Check-Id`):
 * like `edited`, plus the check record's ID. It makes the version, but never confirms a person's
 * `human:` entry.
 */
export function signCheckApplied(
  signer: Signer,
  details: {
    readonly workspaceId: string;
    readonly noteId: string;
    readonly folderId: string;
    readonly baseVersion: number;
    readonly ciphertext: Uint8Array;
    readonly checkId: string;
  } & SigningTime,
): SignedAction {
  return sign(
    signer,
    details.workspaceId,
    {
      type: "check_applied",
      noteId: details.noteId,
      folderId: details.folderId,
      version: details.baseVersion + 1,
      ciphertextSha256: ciphertextSha256(details.ciphertext),
      checkId: details.checkId,
    },
    details.signedAt,
  );
}

/** `deleted` for `deleteNote`: the delete marker is the base version + 1. */
export function signDeleted(
  signer: Signer,
  details: {
    readonly workspaceId: string;
    readonly noteId: string;
    readonly baseVersion: number;
  } & SigningTime,
): SignedAction {
  return sign(
    signer,
    details.workspaceId,
    {
      type: "deleted",
      noteId: details.noteId,
      version: details.baseVersion + 1,
    },
    details.signedAt,
  );
}

/**
 * `approved` for `approvePending`: over the NEW ciphertext, at the pending base version + 1, in
 * the pending change's folder.
 */
export function signApproved(
  signer: Signer,
  details: {
    readonly workspaceId: string;
    readonly noteId: string;
    readonly pendingId: string;
    readonly folderId: string;
    readonly baseVersion: number;
    readonly ciphertext: Uint8Array;
  } & SigningTime,
): SignedAction {
  return sign(
    signer,
    details.workspaceId,
    {
      type: "approved",
      noteId: details.noteId,
      pendingId: details.pendingId,
      folderId: details.folderId,
      version: details.baseVersion + 1,
      ciphertextSha256: ciphertextSha256(details.ciphertext),
    },
    details.signedAt,
  );
}

/** `rejected` for `rejectPending`, naming the comment the rejection leaves and its hash. */
export function signRejected(
  signer: Signer,
  details: {
    readonly workspaceId: string;
    readonly noteId: string;
    readonly pendingId: string;
    readonly commentId: string;
    readonly commentCiphertext: Uint8Array;
  } & SigningTime,
): SignedAction {
  return sign(
    signer,
    details.workspaceId,
    {
      type: "rejected",
      noteId: details.noteId,
      pendingId: details.pendingId,
      commentId: details.commentId,
      ciphertextSha256: ciphertextSha256(details.commentCiphertext),
    },
    details.signedAt,
  );
}

/**
 * `commented` for `addComment` (`baseRevision` null: revision 1) and `updateComment` (revision
 * `baseRevision` + 1).
 */
export function signCommented(
  signer: Signer,
  details: {
    readonly workspaceId: string;
    readonly noteId: string;
    readonly commentId: string;
    readonly baseRevision: number | null;
    readonly ciphertext: Uint8Array;
  } & SigningTime,
): SignedAction {
  return sign(
    signer,
    details.workspaceId,
    {
      type: "commented",
      noteId: details.noteId,
      commentId: details.commentId,
      revision: details.baseRevision === null ? 1 : details.baseRevision + 1,
      ciphertextSha256: ciphertextSha256(details.ciphertext),
    },
    details.signedAt,
  );
}

/** `recorded` for a person's `addEvent`. */
export function signRecorded(
  signer: Signer,
  details: {
    readonly workspaceId: string;
    readonly noteId: string;
    readonly eventId: string;
    readonly ciphertext: Uint8Array;
  } & SigningTime,
): SignedAction {
  return sign(
    signer,
    details.workspaceId,
    {
      type: "recorded",
      noteId: details.noteId,
      eventId: details.eventId,
      ciphertextSha256: ciphertextSha256(details.ciphertext),
    },
    details.signedAt,
  );
}

/** `folder_created` for `createFolder`; a folder at the root has no `parentId`. */
export function signFolderCreated(
  signer: Signer,
  details: {
    readonly workspaceId: string;
    readonly folderId: string;
    readonly parentId: string | null;
    /** The encrypted name's bytes (the decoded `encName`). */
    readonly encName: Uint8Array;
  } & SigningTime,
): SignedAction {
  return sign(
    signer,
    details.workspaceId,
    {
      type: "folder_created",
      folderId: details.folderId,
      ...(details.parentId === null ? {} : { parentId: details.parentId }),
      ciphertextSha256: ciphertextSha256(details.encName),
    },
    details.signedAt,
  );
}

/** `folder_moved` for a move in `updateFolder`; `parentId` null moves it to the root. */
export function signFolderMoved(
  signer: Signer,
  details: {
    readonly workspaceId: string;
    readonly folderId: string;
    readonly parentId: string | null;
  } & SigningTime,
): SignedAction {
  return sign(
    signer,
    details.workspaceId,
    {
      type: "folder_moved",
      folderId: details.folderId,
      ...(details.parentId === null ? {} : { parentId: details.parentId }),
    },
    details.signedAt,
  );
}

/** The requests that carry a signed `key_generation`. */
export type GenerationRoute = "createWorkspace" | "rotateWorkspaceKey" | "approveConnect";

/**
 * The owner's `key_generation` for `createWorkspace` (generation 1), `rotateWorkspaceKey` and
 * `approveConnect` (a new agent joins the generation): it commits to every recipient public key
 * of the generation (`recipientsHash`) and to its key (`keyCommitment`).
 */
export function signGeneration(
  signer: Signer,
  details: {
    readonly workspaceId: string;
    /** The generation's key: the envelope names its generation and commits to it. */
    readonly key: WorkspaceKey;
    readonly recipients: readonly Uint8Array[];
    /** The request the signature goes in (for errors); defaults to `rotateWorkspaceKey`. */
    readonly route?: GenerationRoute;
  } & SigningTime,
): {
  readonly signed: SignedEnvelope;
  /** The envelope's `keyCommitment`, which the request carries (the server can't derive it). */
  readonly keyCommitment: string;
  readonly generationSignedAt: string;
  readonly generationSignature: string;
} {
  const createdAt = signingTime(signer, "key_generation", details.signedAt, [
    details.route ?? "rotateWorkspaceKey",
    "body",
    "generationSignedAt",
  ]);
  const signed = signKeyGeneration(
    {
      accountId: signer.accountId,
      workspaceId: details.workspaceId,
      key: details.key,
      recipients: details.recipients,
      createdAt,
    },
    signer.signing,
  );
  return {
    signed,
    keyCommitment: signed.envelope.keyCommitment ?? "",
    generationSignedAt: createdAt,
    generationSignature: signed.signature,
  };
}

/**
 * The owner's `token_revoked` for `revokeToken`: the token id and the public key its copies were
 * sealed for (from a verified wrapped_key envelope), so no later rotation wraps for it again.
 */
export function signRevocation(
  signer: Signer,
  details: {
    readonly workspaceId: string;
    readonly tokenId: string;
    readonly recipientPublicKey: Uint8Array;
  } & SigningTime,
): SignedAction {
  return sign(
    signer,
    details.workspaceId,
    {
      type: "token_revoked",
      tokenId: details.tokenId,
      recipient: toBase64Url(details.recipientPublicKey),
    },
    details.signedAt,
  );
}

/**
 * The owner's `agent_policy` for `setAgentPolicy`: the new revision (`baseRevision + 1`) and
 * `agentPolicySha256` of the rules sent (`prepareAgentPolicy` computes both).
 */
export function signAgentPolicy(
  signer: Signer,
  details: {
    readonly workspaceId: string;
    readonly revision: number;
    readonly policySha256: string;
  } & SigningTime,
): SignedAction {
  return sign(
    signer,
    details.workspaceId,
    { type: "agent_policy", revision: details.revision, policySha256: details.policySha256 },
    details.signedAt,
  );
}

/**
 * The owner's `agent_key` for `approveConnect`: vouches for the agent's Ed25519 key for its token,
 * with the agent policy revision the owner just verified as the agent's floor
 * (`prepareAgentKeyApproval` reads and checks that revision first).
 */
export function signAgentKey(
  signer: Signer,
  details: {
    readonly workspaceId: string;
    readonly tokenId: string;
    readonly signPublicKey: Uint8Array;
    readonly policyRevision: number;
  } & SigningTime,
): SignedAction {
  return sign(
    signer,
    details.workspaceId,
    {
      type: "agent_key",
      tokenId: details.tokenId,
      signPublicKey: toBase64Url(details.signPublicKey),
      policyRevision: details.policyRevision,
    },
    details.signedAt,
  );
}

/**
 * A connected agent that signs its own direct writes: its token, the workspace owner's account
 * (the `accountId` every `agent_edited` names) and its own Ed25519 key pair, never the account's.
 */
export interface AgentSigner {
  readonly tokenId: string;
  readonly ownerAccountId: string;
  readonly signing: SigningKeyPair;
  /** Milliseconds since the epoch, for `createdAt`; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * `agent_edited` for `writeNoteAsAgent`, signed with the agent's own key: the new version is the
 * base version + 1, with the agent policy revision the agent checked and that revision's hash.
 */
export function signAgentEdited(
  agent: AgentSigner,
  details: {
    readonly workspaceId: string;
    readonly noteId: string;
    readonly folderId: string;
    readonly baseVersion: number;
    readonly ciphertext: Uint8Array;
    readonly revision: number;
    readonly policySha256: string;
  } & SigningTime,
): SignedAction {
  return sign(
    {
      accountId: agent.ownerAccountId,
      signing: agent.signing,
      ...(agent.now === undefined ? {} : { now: agent.now }),
    },
    details.workspaceId,
    {
      type: "agent_edited",
      tokenId: agent.tokenId,
      noteId: details.noteId,
      folderId: details.folderId,
      version: details.baseVersion + 1,
      ciphertextSha256: ciphertextSha256(details.ciphertext),
      revision: details.revision,
      policySha256: details.policySha256,
    },
    details.signedAt,
  );
}
