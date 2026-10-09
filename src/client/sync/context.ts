import type { Confirmations } from "./confirmations.js";
import { isCryptoError, type WorkspaceKeyring } from "../../crypto/index.js";
import type { WorkspaceId } from "../../protocol/index.js";
import type { ApiClient } from "../api/index.js";
import type { EncryptedCache } from "../cache/index.js";
import { isSyncApiError, RequestValidationError } from "../errors/index.js";
import type { AgentPolicyFolderInfo } from "../../protocol/index.js";
import type { AgentSigner, KeyProvider, Signer, TrustState } from "../vault/index.js";
import type { VersionVerifier } from "./agent-keys.js";
import type { SyncEmitter } from "./events.js";
import type { Quarantine } from "./quarantine.js";

/** What the sync modules share. */
export interface SyncContext {
  readonly api: ApiClient;
  readonly workspaceId: WorkspaceId;
  readonly keys: KeyProvider;
  readonly trust: TrustState;
  /**
   * Whose signature makes a note version current: the owner (from a trusted source), or an agent
   * whose key the owner vouched for (`agent_edited`).
   */
  readonly verifier: VersionVerifier;
  /** The person's signing key, for the session routes that need a signature. */
  readonly identity: Signer | undefined;
  /** The agent's own signing key, for its direct writes (an agent connection only). */
  readonly agent: AgentConnection | undefined;
  /** The folders the engine has seen (the feed and the cache), for the agent policy. */
  readonly folders: Map<string, AgentPolicyFolderInfo>;
  /** Each note's folder as last reported, so an agent's move checks the folder it leaves. */
  readonly noteFolders: Map<string, string>;
  readonly cache: EncryptedCache | undefined;
  readonly emitter: SyncEmitter;
  readonly quarantine: Quarantine;
  /** The person's verified signed writes per note, which confirm their `human:` entries. */
  readonly confirmations: Confirmations;
}

/**
 * Runs `use` with the verified keyring; when a blob names a generation the keyring lacks, fetches
 * the keys again once and retries.
 */
export async function withKeys<T>(
  context: SyncContext,
  use: (keys: WorkspaceKeyring) => T | Promise<T>,
): Promise<T> {
  try {
    return await use(await context.keys.get());
  } catch (error) {
    if (!isCryptoError(error, "unknown_key_generation")) throw error;
    return use(await context.keys.refresh());
  }
}

/**
 * Runs a write with the current key (`keys.forWriting`: `rotation_pending` while the current
 * generation still holds a revoked agent); when the server says the generation is stale, fetches
 * the keys again once and writes again with the new current key.
 */
export async function withCurrentKey<T>(
  context: SyncContext,
  write: (keys: WorkspaceKeyring) => Promise<T>,
): Promise<T> {
  const attempt = async (keys: WorkspaceKeyring) => {
    await context.trust.assertWriteGeneration(context.workspaceId, keys.current.generation);
    return write(keys);
  };
  try {
    return await attempt(await context.keys.forWriting());
  } catch (error) {
    if (!isSyncApiError(error, "stale_key_generation")) throw error;
    await context.keys.refresh();
    return attempt(await context.keys.forWriting());
  }
}

/** The person's signer, or a refusal when this engine has none (agent mode). */
export function requireIdentity(context: SyncContext, action: string): Signer {
  if (context.identity === undefined || context.api.auth.kind !== "session") {
    throw new RequestValidationError(action, "auth");
  }
  return context.identity;
}

/**
 * A connected agent that writes directly (protocol 2): its own Ed25519 key, which the owner
 * vouched for at connect time, and its token's folders.
 */
export interface AgentConnection extends Omit<AgentSigner, "ownerAccountId"> {
  /**
   * The token's folders, as the CLI saved them at connect; empty for the whole workspace. The
   * policy view's `ancestors` may name only these.
   */
  readonly folderIds: readonly string[];
}

/** The agent's signer, or a refusal when this engine has none (or isn't an agent's). */
export function requireAgent(
  context: SyncContext,
  action: string,
): { readonly agent: AgentConnection; readonly signer: AgentSigner } {
  const agent = context.agent;
  const ownerAccountId = context.verifier.owner.accountId;
  if (agent === undefined || ownerAccountId === undefined || context.api.auth.kind !== "agent") {
    throw new RequestValidationError(action, "auth");
  }
  return {
    agent,
    signer: {
      tokenId: agent.tokenId,
      ownerAccountId,
      signing: agent.signing,
      ...(agent.now === undefined ? {} : { now: agent.now }),
    },
  };
}
