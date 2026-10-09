// A workspace with an owner, a connected agent and a fake server, for the client tests. Needs
// `await ready()` first. Not exported.
import {
  type AccountKeys,
  type BoxKeyPair,
  createAccountKeys,
  createAgentKeyPair,
  createAgentSigningKeyPair,
  createWorkspaceKey,
  type SigningKeyPair,
  type WorkspaceKey,
  signKeyGeneration,
  toBase64Url,
  wrapAndSignWorkspaceKey,
} from "../../crypto/index.js";
import type { AccountId, FolderId, TokenId, WorkspaceId } from "../../protocol/index.js";
import { type ApiClient, createApiClient } from "../api/index.js";
import type { EncryptedCache } from "../cache/index.js";
import { newId } from "../platform/ids.js";
import { SyncEngine } from "../sync/index.js";
import {
  createKeyProvider,
  type KeyProvider,
  encryptWorkspaceName,
  MemoryTrustStorage,
  type Signer,
  signAgentKey,
  TrustState,
} from "../vault/index.js";
import { FakeServer } from "./fake-server.js";
import { wrappedRecord } from "./wrapped.js";

export interface ClientOptions {
  readonly cache?: EncryptedCache;
  readonly trust?: TrustState;
  readonly pageSize?: number;
  /** The CLI's token folders as it saved them at connect (default: the whole workspace). */
  readonly folderIds?: readonly string[];
}

export interface Client {
  readonly api: ApiClient;
  readonly engine: SyncEngine;
  readonly trust: TrustState;
  readonly keys: KeyProvider;
}

export class World {
  readonly account: AccountKeys = createAccountKeys();
  readonly accountId: AccountId = newId("acc");
  readonly workspaceId: WorkspaceId = newId("ws");
  readonly folderId: FolderId = newId("fld");
  readonly tokenId: TokenId = newId("tok");
  readonly agentToken = `kta_${"k".repeat(43)}`;
  readonly agent: BoxKeyPair = createAgentKeyPair();
  /** The agent's Ed25519 key (protocol 2), which the owner vouched for at connect. */
  readonly agentSigning: SigningKeyPair = createAgentSigningKeyPair();
  readonly key: WorkspaceKey = createWorkspaceKey();
  readonly server: FakeServer;
  readonly signer: Signer;

  constructor() {
    this.signer = { accountId: this.accountId, signing: this.account.signing };
    const owner = {
      accountId: this.accountId,
      workspaceId: this.workspaceId,
      signing: this.account.signing,
    };
    // generation 1 is held by the account and the agent: the owner signs both into it
    const signedGeneration = signKeyGeneration(
      {
        accountId: this.accountId,
        workspaceId: this.workspaceId,
        key: this.key,
        recipients: [this.account.encryption.publicKey, this.agent.publicKey],
      },
      this.account.signing,
    );
    const forAccount = wrapAndSignWorkspaceKey(this.key, this.account.encryption.publicKey, {
      ...owner,
      holder: "account",
      signedGeneration,
    });
    const forAgent = wrapAndSignWorkspaceKey(this.key, this.agent.publicKey, {
      ...owner,
      holder: this.tokenId,
      signedGeneration,
    });
    this.server = new FakeServer({
      workspaceId: this.workspaceId,
      ownerId: this.accountId,
      ownerSigningPublicKey: this.account.signing.publicKey,
      ownerBoxPublicKey: this.account.encryption.publicKey,
      tokenId: this.tokenId,
      agentToken: this.agentToken,
      agentPublicKey: this.agent.publicKey,
      encName: encryptWorkspaceName(this.key, this.workspaceId, "Clients"),
      keyGeneration: 1,
      sessionKeys: [
        wrappedRecord(
          this.workspaceId,
          { kind: "account", accountId: this.accountId },
          forAccount,
          1,
        ),
      ],
      agentKeys: [
        wrappedRecord(this.workspaceId, { kind: "token", tokenId: this.tokenId }, forAgent, 1),
      ],
    });
    // the owner vouched for the agent's signing key at connect (no policy yet: revision 0)
    const vouched = signAgentKey(this.signer, {
      workspaceId: this.workspaceId,
      tokenId: this.tokenId,
      signPublicKey: this.agentSigning.publicKey,
      policyRevision: 0,
    });
    this.server.vouchAgentKey({
      signPublicKey: toBase64Url(this.agentSigning.publicKey),
      agentKeySignedAt: vouched.signedAt,
      agentKeySignature: vouched.signature,
    });
  }

  /** The web app: session auth, the account's keys, the account's own signing key trusted. */
  web(options: ClientOptions = {}): Client {
    const api = createApiClient({
      baseUrl: "https://api.test",
      fetch: this.server.fetch,
      auth: { kind: "session" },
    });
    const trust = options.trust ?? new TrustState(new MemoryTrustStorage());
    const keys = createKeyProvider(api, {
      workspaceId: this.workspaceId,
      recipient: this.account.encryption,
      ownerSigningPublicKey: this.account.signing.publicKey,
      ownerAccountId: this.accountId,
      trust,
    });
    const engine = new SyncEngine({
      api,
      workspaceId: this.workspaceId,
      keys,
      trust,
      verifier: { publicKey: this.account.signing.publicKey, accountId: this.accountId },
      identity: this.signer,
      ...(options.cache === undefined ? {} : { cache: options.cache }),
      ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
    });
    return { api, engine, trust, keys };
  }

  /**
   * The CLI: the agent token, the agent's own keypairs (its signing key for direct writes), the
   * owner key and account pinned at connect.
   */
  cli(options: ClientOptions = {}): Client {
    const api = createApiClient({
      baseUrl: "https://api.test",
      fetch: this.server.fetch,
      auth: { kind: "agent", token: this.agentToken },
    });
    const trust = options.trust ?? new TrustState(new MemoryTrustStorage());
    const keys = createKeyProvider(api, {
      workspaceId: this.workspaceId,
      recipient: this.agent,
      ownerSigningPublicKey: this.account.signing.publicKey,
      trust,
    });
    const engine = new SyncEngine({
      api,
      workspaceId: this.workspaceId,
      keys,
      trust,
      verifier: { publicKey: this.account.signing.publicKey, accountId: this.accountId },
      agent: {
        tokenId: this.tokenId,
        signing: this.agentSigning,
        folderIds: options.folderIds ?? [],
      },
      ...(options.cache === undefined ? {} : { cache: options.cache }),
      ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
    });
    return { api, engine, trust, keys };
  }
}
