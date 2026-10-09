import {
  createWorkspaceKey,
  fromBase64Url,
  toBase64Url,
  type WorkspaceKey,
  wrapAndSignWorkspaceKey,
  WRAPPED_KEY_ACCOUNT_HOLDER,
} from "../../crypto/index.js";
import { ROOT_FOLDER_NAME } from "../../core/files/index.js";
import type {
  CreateFolderRequest,
  CreateWorkspaceRequest,
  FolderId,
  UpdateFolderRequest,
  WorkspaceId,
} from "../../protocol/index.js";
import { RequestValidationError } from "../errors/index.js";
import { newId } from "../platform/ids.js";
import { encryptFolderName, encryptWorkspaceName } from "./content.js";
import {
  signFolderCreated,
  signFolderMoved,
  signGeneration,
  signingFields,
  type SigningTime,
} from "./envelopes.js";
import type { Signer } from "./signer.js";

/** A new workspace: the `createWorkspace` body and the key to keep in memory. */
export interface PreparedWorkspace {
  readonly request: CreateWorkspaceRequest;
  /** Generation 1 of the workspace key. */
  readonly key: WorkspaceKey;
}

/**
 * Prepares a new workspace in the browser: a fresh ID and key, the encrypted name, the key
 * wrapped for the account's own X25519 public key and signed (`wrapped_key`), and the owner's
 * signature on generation 1 (`key_generation`).
 */
export function prepareWorkspace(
  signer: Signer,
  details: { readonly name: string; readonly accountBoxPublicKey: Uint8Array },
): PreparedWorkspace {
  const workspaceId: WorkspaceId = newId("ws");
  const key = createWorkspaceKey();
  const generation = signGeneration(signer, {
    workspaceId,
    key,
    recipients: [details.accountBoxPublicKey],
    route: "createWorkspace",
  });
  const wrapped = wrapAndSignWorkspaceKey(key, details.accountBoxPublicKey, {
    accountId: signer.accountId,
    workspaceId,
    signing: signer.signing,
    holder: WRAPPED_KEY_ACCOUNT_HOLDER,
    signedGeneration: generation.signed,
  });
  return {
    key,
    request: {
      id: workspaceId,
      encName: encryptWorkspaceName(key, workspaceId, details.name),
      encWorkspaceKey: toBase64Url(wrapped.wrapped),
      signedAt: wrapped.signed.envelope.createdAt,
      signature: wrapped.signed.signature,
      keyCommitment: generation.keyCommitment,
      generationSignedAt: generation.generationSignedAt,
      generationSignature: generation.generationSignature,
    },
  };
}

/**
 * Prepares a `createFolder` body: a fresh ID, the encrypted name and the `folder_created`
 * signature. The root folder convention: the workspace root is one top-level folder with an
 * empty name (`ROOT_FOLDER_NAME`), only for notes at the top level. So an empty name is refused
 * unless it is that folder (no parent, and `rootFolderId` null: no root yet), and
 * a folder created "in the root" is stored with no parent.
 */
export function prepareFolder(
  signer: Signer,
  key: WorkspaceKey,
  details: {
    readonly workspaceId: string;
    readonly parentId: FolderId | null;
    readonly name: string;
    /** The workspace's root folder, or null when it has none (required, so it isn't forgotten). */
    readonly rootFolderId: FolderId | null;
  } & SigningTime,
): CreateFolderRequest {
  const root = details.rootFolderId;
  if (details.name === ROOT_FOLDER_NAME && (details.parentId !== null || root !== null)) {
    throw new RequestValidationError("createFolder", "body", ["encName"]);
  }
  const parentId = details.parentId !== null && details.parentId === root ? null : details.parentId;
  const folderId: FolderId = newId("fld");
  const encName = encryptFolderName(
    key,
    { workspaceId: details.workspaceId, folderId },
    details.name,
  );
  const action = signFolderCreated(signer, {
    workspaceId: details.workspaceId,
    folderId,
    parentId,
    encName: fromBase64Url(encName),
    ...(details.signedAt === undefined ? {} : { signedAt: details.signedAt }),
  });
  return { id: folderId, parentId, encName, ...signingFields(action) };
}

/**
 * Prepares an `updateFolder` body: a rename (the encrypted name), a move (signed as
 * `folder_moved`), or both. By the root folder convention, renaming any folder to the empty name
 * and renaming or moving the root folder itself are refused, and a move "into the root" stores no
 * parent.
 */
export function prepareFolderUpdate(
  signer: Signer,
  key: WorkspaceKey,
  details: {
    readonly workspaceId: string;
    readonly folderId: FolderId;
    readonly name?: string;
    readonly parentId?: FolderId | null;
    /** The workspace's root folder, or null when it has none (required, so it isn't forgotten). */
    readonly rootFolderId: FolderId | null;
  } & SigningTime,
): UpdateFolderRequest {
  const root = details.rootFolderId;
  if (details.folderId === root) {
    throw new RequestValidationError("updateFolder", "params", ["folderId"]);
  }
  if (details.name === ROOT_FOLDER_NAME) {
    throw new RequestValidationError("updateFolder", "body", ["encName"]);
  }
  if (details.name === undefined && details.parentId === undefined) {
    throw new RequestValidationError("updateFolder", "body");
  }
  const parentId =
    details.parentId === undefined
      ? undefined
      : details.parentId !== null && details.parentId === root
        ? null
        : details.parentId;
  const encName =
    details.name === undefined
      ? undefined
      : encryptFolderName(
          key,
          { workspaceId: details.workspaceId, folderId: details.folderId },
          details.name,
        );
  const signing =
    parentId === undefined
      ? {}
      : signingFields(
          signFolderMoved(signer, {
            workspaceId: details.workspaceId,
            folderId: details.folderId,
            parentId,
            ...(details.signedAt === undefined ? {} : { signedAt: details.signedAt }),
          }),
        );
  return {
    ...(encName === undefined ? {} : { encName }),
    ...(parentId === undefined ? {} : { parentId }),
    ...signing,
  };
}
