import { join } from "node:path";

import { z } from "zod";

import { fromBase64Url, type SigningKeyPair, toBase64Url } from "../../crypto/index.js";
import { sodium } from "../../crypto/sodium.js";
import {
  AccountId,
  AgentTokenSecret,
  FolderId,
  PublicKey,
  SignedAgentKey,
  SignedAgentScope,
  TokenAccess,
  TokenId,
  WorkspaceId,
} from "../../protocol/index.js";
import { readIfExists, removeFile, writePrivateFile } from "./files.js";
import { withFileLock } from "./lock.js";
import type { SecretStore } from "./secret-store.js";

/**
 * One connection as `credentials.enc` keeps it: the format every CLI version reads. Versions
 * before direct writes parse that file strictly, so nothing may be added here; newer fields go in
 * the agent-keys file (`AgentSigning`).
 */
const StoredConnection = z.strictObject({
  apiUrl: z.url(),
  workspaceId: WorkspaceId,
  tokenId: TokenId,
  tokenSecret: AgentTokenSecret,
  access: TokenAccess,
  folderIds: z.array(FolderId),
  /** The CLI's X25519 private key for this connection (base64url, 32 bytes). */
  agentPrivateKey: z.string().min(43).max(43),
  ownerId: AccountId,
  /** The owner's signing key, pinned at connect (never taken from a server response). */
  ownerSignPublicKey: PublicKey,
  connectedAt: z.iso.datetime(),
});

/**
 * A connection's signing key for direct writes (protocol 2), kept in its own sealed file
 * (`agent-keys.enc`) that older CLIs never read, by workspace and token.
 */
const AgentSigning = z.strictObject({
  workspaceId: WorkspaceId,
  tokenId: TokenId,
  /** The CLI's Ed25519 private key (base64url, 64 bytes in libsodium's layout). */
  agentSignPrivateKey: z.string().length(86),
  /**
   * The owner's signed `agent_key` vouching for that key, verified at connect under the pinned
   * owner key (it names this token and this key). Its `policyRevision` is the lowest agent
   * policy revision this connection accepts. Absent when the web app didn't vouch.
   */
  agentKey: SignedAgentKey.optional(),
});
type AgentSigning = z.infer<typeof AgentSigning>;

/**
 * The highest agent scope revision this computer verified for a connection's token (protocol 3),
 * with that signed scope, kept in its own sealed file (`agent-scopes.enc`) that released CLIs
 * never read: a lower revision later, or none, is a rollback, and an offline start knows the
 * scope. `credentials.enc` keeps the access and folders of connect time for older CLIs on the
 * same computer; the server enforces the real scope.
 */
export const AgentScopeFloor = z.strictObject({
  workspaceId: WorkspaceId,
  tokenId: TokenId,
  revision: z.int().positive(),
  signed: SignedAgentScope,
});
export type AgentScopeFloor = z.infer<typeof AgentScopeFloor>;

/** Where a session keeps its token's scope floor (`Credentials`, or memory in tests). */
export interface ScopeFloorStore {
  scopeFloor(workspaceId: string, tokenId: string): Promise<AgentScopeFloor | undefined>;
  putScopeFloor(floor: AgentScopeFloor): Promise<void>;
}

/** One connected workspace: what the CLI needs to act for the agent. */
export const Connection = StoredConnection.extend({
  /** Absent from connections made before direct writes: those only propose. */
  agentSignPrivateKey: AgentSigning.shape.agentSignPrivateKey.optional(),
  agentKey: AgentSigning.shape.agentKey,
});
export type Connection = z.infer<typeof Connection>;

/** The connection's own Ed25519 keypair for direct writes; null for a connection made before. */
export function agentSigningKeyPair(connection: Connection): SigningKeyPair | null {
  if (connection.agentSignPrivateKey === undefined) return null;
  const privateKey = fromBase64Url(connection.agentSignPrivateKey);
  if (privateKey.length !== 64) return null;
  // libsodium's layout: the 32-byte seed, then the public key
  return { privateKey, publicKey: privateKey.slice(32) };
}

/**
 * Whether a connection may write directly where the workspace allows it: read-write, with its own
 * signing key and the owner's `agent_key` naming exactly that key. Otherwise every change is a
 * proposal.
 */
export function writesDirectly(connection: Connection): boolean {
  return connection.access === "read-write" && hasVouchedKey(connection);
}

/**
 * Whether a connection has its own signing key and the owner's `agent_key` naming exactly that
 * key (whatever its access, which its verified scope may have changed since connect).
 */
export function hasVouchedKey(connection: Connection): boolean {
  if (connection.agentKey === undefined) return false;
  const own = agentSigningKeyPair(connection);
  return (
    own !== null &&
    connection.agentKey.envelope.tokenId === connection.tokenId &&
    toBase64Url(own.publicKey) === connection.agentKey.envelope.signPublicKey
  );
}

/*
 * Files are read loosely (unknown keys are kept, and written back as they were), so a newer CLI's
 * additions survive this one rewriting a file.
 */
const CredentialsFile = z.looseObject({
  version: z.literal(1),
  connections: z.array(z.looseObject(StoredConnection.shape)),
});
const AgentKeysFile = z.looseObject({
  version: z.literal(1),
  agents: z.array(z.looseObject(AgentSigning.shape)),
});
const AgentScopesFile = z.looseObject({
  version: z.literal(1),
  scopes: z.array(z.looseObject(AgentScopeFloor.shape)),
});

/** What `status --offline` shows about a connection: nothing secret (IDs, scope, URLs, times). */
export const ConnectionSummary = StoredConnection.omit({
  tokenSecret: true,
  agentPrivateKey: true,
});
export type ConnectionSummary = z.infer<typeof ConnectionSummary>;

const SummaryFile = z.looseObject({
  version: z.literal(1),
  connections: z.array(z.looseObject(ConnectionSummary.shape)),
});

/** The credentials file exists but its key is gone (another keychain, a reset, a restore). */
export class CredentialsLockedError extends Error {
  override readonly name = "CredentialsLockedError";

  constructor(readonly path: string) {
    super(
      `The saved connections in ${path} can't be read: their key is missing from the secret store (the OS keychain, or secrets.json with KNOWTARIUM_KEYCHAIN=off). ` +
        "Revoke this agent in the web app, delete that file, then run `knowtarium connect` again.",
    );
  }
}

const FILE_KEY = "credentials-key";
const FORMAT = 1;
const CREDENTIALS_AD = new TextEncoder().encode("knowtarium-cli-credentials-v1");
const AGENT_KEYS_AD = new TextEncoder().encode("knowtarium-cli-agent-keys-v1");
const AGENT_SCOPES_AD = new TextEncoder().encode("knowtarium-cli-agent-scopes-v1");

type Loose<T> = T & Record<string, unknown>;

/** The files' records as read (unknown keys kept). */
interface Records {
  readonly connections: Loose<z.infer<typeof StoredConnection>>[];
  readonly agents: Loose<AgentSigning>[];
  readonly scopes: Loose<AgentScopeFloor>[];
}

/**
 * The connections, encrypted with XChaCha20-Poly1305 (libsodium) under a random key kept in the
 * `SecretStore` (the OS keychain where there is one), in two files: `credentials.enc` in the
 * format every CLI version reads, and `agent-keys.enc` (same key, its own associated data) with
 * each connection's signing key for direct writes, and `agent-scopes.enc` (its own associated
 * data too) with each token's verified scope floor (`AgentScopeFloor`). The files can sit in a
 * backup or a synced folder: without the keychain entry they can't be read. Needs
 * `await ready()` first.
 */
export class Credentials implements ScopeFloorStore {
  private readonly path: string;
  private readonly agentKeysPath: string;
  private readonly agentScopesPath: string;
  private readonly summaryPath: string;

  constructor(
    home: string,
    private readonly secrets: SecretStore,
  ) {
    this.path = join(home, "credentials.enc");
    this.agentKeysPath = join(home, "agent-keys.enc");
    this.agentScopesPath = join(home, "agent-scopes.enc");
    this.summaryPath = join(home, "connections.json");
  }

  /**
   * The file key: a new one only when there is no credentials file yet. A file whose key is
   * missing is refused rather than silently replaced.
   */
  private async fileKey(fileExists: boolean): Promise<Uint8Array> {
    const stored = await this.secrets.get(FILE_KEY);
    if (stored !== null) return fromBase64Url(stored);
    if (fileExists) throw new CredentialsLockedError(this.path);
    const key = sodium().crypto_aead_xchacha20poly1305_ietf_keygen();
    await this.secrets.set(FILE_KEY, toBase64Url(key));
    return key;
  }

  private static open(sealed: Uint8Array, key: Uint8Array, ad: Uint8Array): unknown {
    const lib = sodium();
    const nonceEnd = 1 + lib.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
    const plaintext = lib.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      sealed.subarray(nonceEnd),
      ad,
      sealed.subarray(1, nonceEnd),
      key,
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  }

  private static seal(value: unknown, key: Uint8Array, ad: Uint8Array): Uint8Array {
    const lib = sodium();
    const nonce = lib.randombytes_buf(lib.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const ciphertext = lib.crypto_aead_xchacha20poly1305_ietf_encrypt(
      new TextEncoder().encode(JSON.stringify(value)),
      ad,
      null,
      nonce,
      key,
    );
    const sealed = new Uint8Array(1 + nonce.length + ciphertext.length);
    sealed[0] = FORMAT;
    sealed.set(nonce, 1);
    sealed.set(ciphertext, 1 + nonce.length);
    return sealed;
  }

  private async records(): Promise<Records> {
    const sealed = await readIfExists(this.path);
    if (sealed === null) return { connections: [], agents: [], scopes: [] };
    const key = await this.fileKey(true);
    if (sealed[0] !== FORMAT) throw new CredentialsLockedError(this.path);
    const { connections } = CredentialsFile.parse(Credentials.open(sealed, key, CREDENTIALS_AD));
    let agents: Loose<AgentSigning>[] = [];
    const sidecar = await readIfExists(this.agentKeysPath);
    if (sidecar?.[0] === FORMAT) {
      try {
        agents = AgentKeysFile.parse(Credentials.open(sidecar, key, AGENT_KEYS_AD)).agents;
      } catch {
        // left behind under an older key (an older CLI removed everything, then connected
        // again): its keys are unusable, so the connections only propose until reconnected
      }
    }
    let scopes: Loose<AgentScopeFloor>[] = [];
    const floors = await readIfExists(this.agentScopesPath);
    if (floors?.[0] === FORMAT) {
      try {
        scopes = AgentScopesFile.parse(Credentials.open(floors, key, AGENT_SCOPES_AD)).scopes;
      } catch {
        // left behind under an older key: the floors are read again from the server
      }
    }
    return { connections, agents, scopes };
  }

  /** Every connection; none when nothing was saved. Throws `CredentialsLockedError` without the key. */
  async list(): Promise<Connection[]> {
    const { connections, agents } = await this.records();
    return connections.map((stored) => {
      const connection: Connection = StoredConnection.parse(
        Object.fromEntries(Object.keys(StoredConnection.shape).map((key) => [key, stored[key]])),
      );
      // the signing key counts only for the same workspace and token (an older CLI may have
      // replaced the token since)
      const signing = agents.find(
        (entry) =>
          entry.workspaceId === connection.workspaceId && entry.tokenId === connection.tokenId,
      );
      if (signing === undefined) return connection;
      return {
        ...connection,
        agentSignPrivateKey: signing.agentSignPrivateKey,
        ...(signing.agentKey === undefined ? {} : { agentKey: signing.agentKey }),
      };
    });
  }

  private async save(records: Records): Promise<void> {
    const key = await this.fileKey((await readIfExists(this.path)) !== null);
    // keep only signing keys and scope floors whose connection is still there
    const connected = (entry: { workspaceId: string; tokenId: string }) =>
      records.connections.some(
        (connection) =>
          connection.workspaceId === entry.workspaceId && connection.tokenId === entry.tokenId,
      );
    const agents = records.agents.filter(connected);
    const scopes = records.scopes.filter(connected);
    await writePrivateFile(
      this.path,
      Credentials.seal({ version: 1, connections: records.connections }, key, CREDENTIALS_AD),
    );
    if (agents.length > 0) {
      await writePrivateFile(
        this.agentKeysPath,
        Credentials.seal({ version: 1, agents }, key, AGENT_KEYS_AD),
      );
    } else {
      await removeFile(this.agentKeysPath);
    }
    if (scopes.length > 0) {
      await writePrivateFile(
        this.agentScopesPath,
        Credentials.seal({ version: 1, scopes }, key, AGENT_SCOPES_AD),
      );
    } else {
      await removeFile(this.agentScopesPath);
    }
    // only the known, non-secret fields: an unknown one may be a newer version's secret
    const summaries = records.connections.map((connection) =>
      ConnectionSummary.parse(
        Object.fromEntries(
          Object.keys(ConnectionSummary.shape).map((field) => [field, connection[field]]),
        ),
      ),
    );
    await writePrivateFile(
      this.summaryPath,
      JSON.stringify({ version: 1, connections: summaries }, null, 2),
    );
  }

  /**
   * Adds a connection, replacing one for the same workspace (under the file's lock). Returns the
   * one it replaced, if any (whose token the caller revokes when it is another).
   */
  put(connection: Connection): Promise<Connection | undefined> {
    return withFileLock(this.path, async () => {
      const records = await this.records();
      const replaced = (await this.list()).find(
        (entry) => entry.workspaceId === connection.workspaceId,
      );
      const { agentSignPrivateKey, agentKey, ...stored } = connection;
      const others = (entry: { workspaceId: string }) =>
        entry.workspaceId !== connection.workspaceId;
      await this.save({
        connections: [...records.connections.filter(others), StoredConnection.parse(stored)],
        agents: [
          ...records.agents.filter(others),
          ...(agentSignPrivateKey === undefined
            ? []
            : [
                AgentSigning.parse({
                  workspaceId: connection.workspaceId,
                  tokenId: connection.tokenId,
                  agentSignPrivateKey,
                  ...(agentKey === undefined ? {} : { agentKey }),
                }),
              ]),
        ],
        scopes: records.scopes,
      });
      return replaced;
    });
  }

  /** The scope floor this computer keeps for a connection's token, if any. */
  async scopeFloor(workspaceId: string, tokenId: string): Promise<AgentScopeFloor | undefined> {
    const { scopes } = await this.records();
    const stored = scopes.find(
      (entry) => entry.workspaceId === workspaceId && entry.tokenId === tokenId,
    );
    const parsed = AgentScopeFloor.safeParse(
      stored === undefined
        ? undefined
        : Object.fromEntries(Object.keys(AgentScopeFloor.shape).map((key) => [key, stored[key]])),
    );
    return parsed.success ? parsed.data : undefined;
  }

  /**
   * Keeps a token's verified scope as its floor (under the file's lock), unless one of a higher
   * revision is kept already. Only for a saved connection of that token.
   */
  putScopeFloor(floor: AgentScopeFloor): Promise<void> {
    return withFileLock(this.path, async () => {
      const records = await this.records();
      const others = (entry: { workspaceId: string; tokenId: string }) =>
        entry.workspaceId !== floor.workspaceId || entry.tokenId !== floor.tokenId;
      const kept = records.scopes.find((entry) => !others(entry));
      if (kept !== undefined && kept.revision >= floor.revision) return;
      await this.save({
        ...records,
        scopes: [...records.scopes.filter(others), AgentScopeFloor.parse(floor)],
      });
    });
  }

  /**
   * Removes a workspace's connection. Removing the last one deletes the files and their key,
   * leaving nothing behind.
   */
  remove(workspaceId: string): Promise<void> {
    return withFileLock(this.path, async () => {
      const records = await this.records();
      const others = (entry: { workspaceId: string }) => entry.workspaceId !== workspaceId;
      const rest = records.connections.filter(others);
      if (rest.length > 0) {
        await this.save({
          connections: rest,
          agents: records.agents.filter(others),
          scopes: records.scopes.filter(others),
        });
        return;
      }
      await removeFile(this.path);
      await removeFile(this.agentKeysPath);
      await removeFile(this.agentScopesPath);
      await removeFile(this.summaryPath);
      await this.secrets.delete(FILE_KEY);
    });
  }
}

/** The connections without their secrets, read without the keychain (for `status --offline`). */
export async function readConnectionSummaries(home: string): Promise<ConnectionSummary[]> {
  const bytes = await readIfExists(join(home, "connections.json"));
  if (bytes === null) return [];
  return SummaryFile.parse(JSON.parse(new TextDecoder().decode(bytes))).connections.map((summary) =>
    ConnectionSummary.parse(
      Object.fromEntries(
        Object.keys(ConnectionSummary.shape).map((field) => [field, summary[field]]),
      ),
    ),
  );
}
