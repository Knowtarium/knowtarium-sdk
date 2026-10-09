import { type NoteEvent, routes, type TokenRevocation } from "../../protocol/index.js";
import type { ApiClient } from "../api/index.js";
import { type TrustedSigner, verifiedAgentKeys, type VerifiedAgentKey } from "../vault/index.js";

/**
 * The workspace's agent signing keys, as the owner vouched for them (`listKeys` `agentKeys`,
 * each `agent_key` verified against the owner's key), fetched on first need: only a version an
 * agent signed asks for them. A token not among them is looked up once more (an agent connected
 * since; concurrent lookups share that fetch), then refused until `invalidate` (a key rotation,
 * which a revocation brings).
 *
 * Revocation knowledge only grows: the earliest verified signed revocation of each token and the
 * fact that the server marked it revoked are kept across fetches, so a server that later
 * withholds them changes nothing for this engine.
 */
export class AgentKeyDirectory {
  private loaded: Promise<Map<string, VerifiedAgentKey[]>> | undefined;
  private refetching: Promise<Map<string, VerifiedAgentKey[]>> | undefined;
  private readonly retried = new Set<string>();
  private readonly revocations = new Map<string, TokenRevocation>();
  private readonly revokedAt = new Map<string, string>();

  constructor(
    private readonly api: ApiClient,
    private readonly workspaceId: string,
    private readonly owner: TrustedSigner,
  ) {}

  private async fetch(): Promise<Map<string, VerifiedAgentKey[]>> {
    const { data } = await this.api.call(routes.listKeys);
    const keys = verifiedAgentKeys(
      {
        agentKeys: data.agentKeys ?? [],
        revocations: [...(data.revocations ?? []), ...this.revocations.values()],
      },
      this.owner,
      this.workspaceId,
    );
    for (const [tokenId, list] of keys) {
      for (const key of list) this.remember(tokenId, key);
    }
    return new Map(
      [...keys].map(([tokenId, list]) => {
        const at = this.revokedAt.get(tokenId);
        return [
          tokenId,
          list.map((key) =>
            key.revoked || at === undefined ? key : { ...key, revoked: true, revokedAt: at },
          ),
        ];
      }),
    );
  }

  /** Keeps what a key says about its token's revocation (the earliest signed one wins). */
  private remember(tokenId: string, key: VerifiedAgentKey): void {
    if (key.revokedAt !== null && !this.revokedAt.has(tokenId)) {
      this.revokedAt.set(tokenId, key.revokedAt);
    }
    if (key.revocation === null || key.revokedSignedAt === null) return;
    const known = this.revocations.get(tokenId)?.signed.envelope.createdAt;
    if (known === undefined || Date.parse(key.revokedSignedAt) < Date.parse(known)) {
      this.revocations.set(tokenId, {
        workspaceId: this.workspaceId as TokenRevocation["workspaceId"],
        tokenId: tokenId as TokenRevocation["tokenId"],
        signed: key.revocation,
      });
    }
  }

  private load(): Promise<Map<string, VerifiedAgentKey[]>> {
    if (this.loaded === undefined) {
      const loading = this.fetch();
      // a failed fetch is tried again by the next lookup
      loading.catch(() => {
        if (this.loaded === loading) this.loaded = undefined;
        if (this.refetching === loading) this.refetching = undefined;
      });
      this.loaded = loading;
    }
    return this.loaded;
  }

  /** The verified keys of one agent token (empty: the owner never vouched for one). */
  async forToken(tokenId: string): Promise<readonly VerifiedAgentKey[]> {
    const known = (await this.load()).get(tokenId);
    if (known !== undefined) return known;
    if (!this.retried.has(tokenId)) {
      this.retried.add(tokenId);
      this.loaded = undefined;
      this.refetching = this.load();
    }
    return (await (this.refetching ?? this.load())).get(tokenId) ?? [];
  }

  /**
   * Every verified key of the workspace, revoked tokens' too (an owner's floor: no current agent
   * policy is older than a revision the owner signed into one of them).
   */
  async all(): Promise<readonly VerifiedAgentKey[]> {
    return [...(await this.load()).values()].flat();
  }

  /**
   * Forgets what was fetched (the keys and the tokens looked up again), so the next lookup
   * fetches them and the revocations again. What it learned about revocations stays.
   */
  invalidate(): void {
    this.loaded = undefined;
    this.refetching = undefined;
    this.retried.clear();
  }
}

/** Who may have signed a note version: the owner, and the agents the owner vouched for. */
export interface VersionVerifier {
  /** The owner's signing key, from a source the server can't swap. */
  readonly owner: TrustedSigner;
  readonly agentKeys: AgentKeyDirectory;
}

/** The verified keys of the agent whose `agent_edited` an event carries; none for other events. */
export async function agentKeysFor(
  verifier: VersionVerifier,
  event: NoteEvent | undefined,
): Promise<readonly VerifiedAgentKey[]> {
  const fields = event?.signed?.envelope;
  return fields?.type === "agent_edited" ? verifier.agentKeys.forToken(fields.tokenId) : [];
}

/** Whether the agent behind these keys was revoked (flag only; see `VerifiedAgentKey`). */
export function anyRevoked(keys: readonly VerifiedAgentKey[]): boolean {
  return keys.some((key) => key.revoked);
}
