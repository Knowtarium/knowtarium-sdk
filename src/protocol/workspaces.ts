import { z } from "zod";

import { EncKey, EncName, PublicKey } from "./ciphertext.js";
import { AccountId, WorkspaceId } from "./ids.js";
import { KeyGeneration, Ok, Timestamp, Version } from "./primitives.js";
import { defineRoute } from "./route.js";
import { keyGenerationSigningFields, requiredSigningFields } from "./signatures.js";

/** A workspace as the server knows it: an ID, an encrypted name and counters. */
export const Workspace = z.object({
  id: WorkspaceId,
  encName: EncName,
  ownerId: AccountId,
  /**
   * The owner's Ed25519 public key, for display. Clients must never trust this copy for
   * verification: the web app uses its own account key, and the CLI pins the key from the
   * loopback delivery or from a relayed delivery whose confirmation code the person matched.
   */
  ownerSignPublicKey: PublicKey,
  /** The current key generation; new ciphertext must use it. */
  keyGeneration: KeyGeneration,
  /** Bumped by every change in the workspace; the cursor of the changes feed. */
  currentVersion: Version,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Workspace = z.infer<typeof Workspace>;

/**
 * The browser makes the ID and the key; the key arrives wrapped for the account (generation 1)
 * and signed (`wrapped_key`, with `signedAt` and `signature`), with the owner's signature on
 * generation 1 (`key_generation`, with `generationSignedAt` and `generationSignature`), which
 * the server verifies and stores.
 */
export const CreateWorkspaceRequest = z.strictObject({
  id: WorkspaceId,
  encName: EncName,
  encWorkspaceKey: EncKey,
  ...requiredSigningFields,
  ...keyGenerationSigningFields,
});
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequest>;

export const RenameWorkspaceRequest = z.strictObject({ encName: EncName });
export type RenameWorkspaceRequest = z.infer<typeof RenameWorkspaceRequest>;

export const WorkspaceResponse = z.object({ workspace: Workspace });
export type WorkspaceResponse = z.infer<typeof WorkspaceResponse>;

export const ListWorkspacesResponse = z.object({ workspaces: z.array(Workspace) });
export type ListWorkspacesResponse = z.infer<typeof ListWorkspacesResponse>;

export const workspaceRoutes = {
  listWorkspaces: defineRoute({
    method: "GET",
    path: "/workspaces",
    auth: "any",
    summary: "The account's workspaces (for an agent, the one in its scope)",
    response: ListWorkspacesResponse,
  }),
  createWorkspace: defineRoute({
    method: "POST",
    path: "/workspaces",
    auth: "session",
    summary: "Create a workspace with its encrypted name and wrapped key",
    body: CreateWorkspaceRequest,
    response: WorkspaceResponse,
    status: 201,
  }),
  getWorkspace: defineRoute({
    method: "GET",
    path: "/workspaces/:workspaceId",
    auth: "any",
    summary: "One workspace",
    response: WorkspaceResponse,
  }),
  renameWorkspace: defineRoute({
    method: "PATCH",
    path: "/workspaces/:workspaceId",
    auth: "session",
    summary: "Replace the encrypted name",
    body: RenameWorkspaceRequest,
    response: WorkspaceResponse,
  }),
  deleteWorkspace: defineRoute({
    method: "DELETE",
    path: "/workspaces/:workspaceId",
    auth: "session",
    summary: "Delete the workspace with its blobs, keys, tokens and records",
    response: Ok,
  }),
};
