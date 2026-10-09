import { fromBase64Url, sha256, toBase64Url } from "../../crypto/index.js";
import { toHex, utf8Encode } from "../../crypto/encoding.js";
import type {
  AccountKeys as ProtocolAccountKeys,
  AccountPublicKeys,
  KdfParams,
} from "../../protocol/index.js";
import { proveAccountKeys } from "./account-proof.js";
import { VaultError } from "../errors/index.js";

/**
 * Where a device keeps what it has seen, to resist rollback: pinned public keys and high-water
 * marks. Values are small JSON strings holding only public keys, IDs and numbers, nothing secret.
 * The web app uses `IndexedDbTrustStorage` (or `MemoryTrustStorage`); the CLI persists the marks
 * to a file on disk with its own implementation.
 */
export interface TrustStorage {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** A `TrustStorage` in memory, for the web app (and tests). */
export class MemoryTrustStorage implements TrustStorage {
  private readonly values = new Map<string, string>();

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }

  set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
}

/** The recipient set of the highest key generation this device verified for a workspace. */
interface GenerationSetMark {
  readonly generation: number;
  /** The recipients' X25519 public keys, lowercase hex, sorted. */
  readonly keys: readonly string[];
}

/** An agent key this device signed into a key generation's recipient set (approving a connect). */
interface ApprovalMark {
  readonly generation: number;
  /** The X25519 public key, lowercase hex. */
  readonly key: string;
}

/** An agent key the owner revoked from this device, and whether a rotation still has to drop it. */
interface RevocationMark {
  readonly tokenId: string;
  /** The X25519 public key, base64url. */
  readonly publicKey: string;
  readonly pending: boolean;
}

/** A remembered revocation, decoded. */
export interface RememberedRevocation {
  readonly tokenId: string;
  readonly publicKey: Uint8Array;
  /** True until a rotation that leaves the key out succeeds. */
  readonly pending: boolean;
}

/**
 * An agent policy revision this device verified, with the owner-signed hash of its rules. Kept
 * beside the floor (`workspace/<id>/agent-policy`, a number), so marks stored before pins existed
 * load unchanged: they just have none yet.
 */
interface AgentPolicyPin {
  readonly revision: number;
  readonly policySha256: string;
}

/** How many verified agent policy revisions keep their pinned hash (the highest ones). */
const AGENT_POLICY_PINS = 20;

interface KdfMark {
  readonly opsLimit: number;
  readonly memLimitBytes: number;
}

/** The storage key of an email's KDF mark: SHA-256 of the trimmed, NFKC, lowercased address. */
function kdfKey(email: string): string {
  return `kdf/${toHex(sha256(utf8Encode(email.trim().normalize("NFKC").toLowerCase())))}`;
}

/**
 * The rollback checks the crypto can't make alone (see DEVELOPING.md): pinned account and owner
 * keys, and the highest KDF parameters, key generation, note version and agent policy revision
 * this device has seen, with the policy hash pinned at each recent revision.
 * A server can serve old but genuine data; this refuses to go back.
 */
export class TrustState {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: TrustStorage) {}

  /** Runs read-modify-write steps one at a time, so two checks never race. */
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async read<T>(key: string): Promise<T | undefined> {
    const value = await this.storage.get(key);
    return value === undefined ? undefined : (JSON.parse(value) as T);
  }

  private write(key: string, value: unknown): Promise<void> {
    return this.storage.set(key, JSON.stringify(value));
  }

  /**
   * Pins the account's public keys on first sight and refuses different ones later
   * (`pin_mismatch`). Returns them decoded, for `unwrapAccountKeys`.
   */
  pinAccountKeys(
    accountId: string,
    keys: AccountPublicKeys,
  ): Promise<{ encryptionPublicKey: Uint8Array; signingPublicKey: Uint8Array }> {
    return this.exclusive(async () => {
      const key = `account/${accountId}/keys`;
      const pinned = await this.read<AccountPublicKeys>(key);
      if (pinned === undefined) await this.write(key, { box: keys.box, sign: keys.sign });
      else if (pinned.box !== keys.box || pinned.sign !== keys.sign) {
        throw new VaultError("pin_mismatch", "the account keys differ from the pinned ones");
      }
      return {
        encryptionPublicKey: fromBase64Url(keys.box),
        signingPublicKey: fromBase64Url(keys.sign),
      };
    });
  }

  /**
   * Re-pins an account's public keys after the account started over (new keys after
   * `completeAccountReset`), replacing the pinned ones, only with proof: the person types their
   * new password on this device, it derives the key-encryption key with the new KDF parameters
   * and unwraps `wrappedByMaster` from the new key material (`getAccount`'s `keys`), and the
   * unwrapped keys must match the new public keys (`untrusted_signature` otherwise). Run it in a
   * Web Worker (Argon2id). A changed key is otherwise exactly what `pinAccountKeys` refuses.
   */
  async acceptAccountReset(
    accountId: string,
    proof: { readonly password: string; readonly material: ProtocolAccountKeys },
  ): Promise<void> {
    // the person proves the new keys are theirs: their password opens them (Argon2id)
    const keys = proveAccountKeys(proof.password, proof.material);
    await this.exclusive(() =>
      this.write(`account/${accountId}/keys`, { box: keys.box, sign: keys.sign }),
    );
  }

  /** The account keys pinned on this device, if any. */
  pinnedAccountKeys(accountId: string): Promise<AccountPublicKeys | undefined> {
    return this.read<AccountPublicKeys>(`account/${accountId}/keys`);
  }

  /**
   * Pins a workspace owner's signing public key (the CLI, from the connect delivery) and refuses
   * a different one later.
   */
  pinOwnerKey(workspaceId: string, signPublicKey: string): Promise<void> {
    return this.exclusive(async () => {
      const key = `workspace/${workspaceId}/owner`;
      const pinned = await this.read<string>(key);
      if (pinned === undefined) await this.write(key, signPublicKey);
      else if (pinned !== signPublicKey) {
        throw new VaultError("pin_mismatch", "the owner key differs from the pinned one");
      }
    });
  }

  /**
   * Forgets a workspace's pinned owner key, so the next connect pins whatever key its delivery
   * carries (the CLI calls it on disconnect). The high-water marks stay.
   */
  unpinOwnerKey(workspaceId: string): Promise<void> {
    return this.exclusive(() => this.storage.delete(`workspace/${workspaceId}/owner`));
  }

  /** The pinned owner signing key of a workspace, decoded, if any. */
  async ownerKey(workspaceId: string): Promise<Uint8Array | undefined> {
    const pinned = await this.read<string>(`workspace/${workspaceId}/owner`);
    return pinned === undefined ? undefined : fromBase64Url(pinned);
  }

  /**
   * Refuses KDF parameters weaker than the strongest this device saw for the email (`rollback`).
   * Call it on the prelogin answer before deriving anything, on top of the fixed floor
   * `assertKdfParams` enforces. The mark is keyed by a hash of the normalized email, so the
   * storage never holds the address itself.
   */
  async checkKdfParams(email: string, kdf: KdfParams): Promise<void> {
    const seen = await this.read<KdfMark>(kdfKey(email));
    if (seen === undefined) return;
    if (kdf.opsLimit < seen.opsLimit || kdf.memLimitBytes < seen.memLimitBytes) {
      throw new VaultError("rollback", "the KDF parameters are weaker than before");
    }
  }

  /** Records KDF parameters after a successful unlock (never for an unverified prelogin). */
  recordKdfParams(email: string, kdf: KdfParams): Promise<void> {
    return this.exclusive(async () => {
      const key = kdfKey(email);
      const seen = await this.read<KdfMark>(key);
      await this.write(key, {
        opsLimit: Math.max(kdf.opsLimit, seen?.opsLimit ?? 0),
        memLimitBytes: Math.max(kdf.memLimitBytes, seen?.memLimitBytes ?? 0),
      } satisfies KdfMark);
    });
  }

  /** The highest verified key generation seen for a workspace (0 before any). */
  async keyGeneration(workspaceId: string): Promise<number> {
    return (await this.read<number>(`workspace/${workspaceId}/generation`)) ?? 0;
  }

  /**
   * Records a verified key generation, refusing one below the highest seen as the newest
   * (`rollback`: the server withheld the newest key).
   */
  acceptKeyGeneration(workspaceId: string, newest: number): Promise<void> {
    return this.exclusive(async () => {
      const key = `workspace/${workspaceId}/generation`;
      const seen = (await this.read<number>(key)) ?? 0;
      if (newest < seen) {
        throw new VaultError("rollback", "the newest key generation is older than one seen");
      }
      if (newest > seen) await this.write(key, newest);
    });
  }

  /** Refuses to write with a key generation older than the highest seen (`rollback`). */
  async assertWriteGeneration(workspaceId: string, generation: number): Promise<void> {
    if (generation < (await this.keyGeneration(workspaceId))) {
      throw new VaultError("rollback", "writing with an older key generation");
    }
  }

  /**
   * Records the owner-signed recipient set of a key generation this device verified, refusing
   * (`rollback`) a generation below the highest seen, or a set for that same generation that
   * leaves out a key seen before. A set may grow within a generation (connecting an agent re-signs
   * it with the new key), never shrink: keys only leave with a new generation. It may not grow by
   * a revoked key either: one this device remembers revoking, or one in `revokedKeys` (the keys of
   * valid owner-signed revocations), unless this device itself signed that key into this
   * generation (`rememberApproval`): an agent it approved, then revoked before seeing the grown
   * set (a connect it couldn't deliver), is history it made, and the rotation the revocation calls
   * for leaves the key out. A device that never saw the workspace has nothing to compare with
   * (see DEVELOPING.md).
   */
  acceptGenerationSet(
    workspaceId: string,
    generation: number,
    publicKeys: readonly Uint8Array[],
    revokedKeys: readonly Uint8Array[] = [],
  ): Promise<void> {
    return this.exclusive(async () => {
      const key = `workspace/${workspaceId}/recipients`;
      const seen = await this.read<GenerationSetMark>(key);
      const keys = [...new Set(publicKeys.map((publicKey) => toHex(publicKey)))].sort();
      if (seen !== undefined) {
        if (generation < seen.generation) {
          throw new VaultError("rollback", "an older key generation than one seen");
        }
        if (generation === seen.generation) {
          if (seen.keys.some((known) => !keys.includes(known))) {
            throw new VaultError(
              "rollback",
              "the generation's recipients differ from the owner-signed set seen before",
            );
          }
          const remembered =
            (await this.read<RevocationMark[]>(`workspace/${workspaceId}/revoked`)) ?? [];
          const revoked = new Set([
            ...revokedKeys.map((publicKey) => toHex(publicKey)),
            ...remembered.map((mark) => toHex(fromBase64Url(mark.publicKey))),
          ]);
          const approved = new Set(
            (await this.approvals(workspaceId))
              .filter((mark) => mark.generation === generation)
              .map((mark) => mark.key),
          );
          const surprise = (added: string) =>
            !seen.keys.includes(added) && revoked.has(added) && !approved.has(added);
          if (keys.some(surprise)) {
            throw new VaultError(
              "rollback",
              "the generation's recipients grew by a revoked key since this device saw them",
            );
          }
        }
      }
      await this.write(key, { generation, keys } satisfies GenerationSetMark);
      // approvals into older generations can't matter any more
      const approvals = await this.approvals(workspaceId);
      const current = approvals.filter((mark) => mark.generation >= generation);
      if (current.length !== approvals.length) {
        await this.write(`workspace/${workspaceId}/approved`, current);
      }
    });
  }

  private async approvals(workspaceId: string): Promise<ApprovalMark[]> {
    const marks = await this.read<unknown>(`workspace/${workspaceId}/approved`);
    if (!Array.isArray(marks)) return [];
    return marks.filter(
      (mark): mark is ApprovalMark =>
        typeof mark === "object" &&
        mark !== null &&
        Number.isSafeInteger((mark as ApprovalMark).generation) &&
        typeof (mark as ApprovalMark).key === "string",
    );
  }

  /**
   * Remembers that this device signed an agent's key into a generation's recipient set (the
   * `key_generation` of `prepareConnectGeneration`), before the approval is sent: that key showing
   * up in the set later is no surprise to `acceptGenerationSet`, even once this device revoked it.
   */
  rememberApproval(workspaceId: string, generation: number, publicKey: Uint8Array): Promise<void> {
    return this.exclusive(async () => {
      const approvals = await this.approvals(workspaceId);
      const key = toHex(publicKey);
      if (approvals.some((mark) => mark.generation === generation && mark.key === key)) return;
      await this.write(`workspace/${workspaceId}/approved`, [
        ...approvals,
        { generation, key },
      ] satisfies ApprovalMark[]);
    });
  }

  /**
   * Pins the owner-signed key commitment (`keyCommitment`) of a key generation on first sight and
   * refuses a different one later (`pin_mismatch`): one generation has one key, so a server can't
   * swap in another owner-signed key set for a generation this device already used (a rotation
   * body it kept after answering an error). Called for every generation a keyring opens, and by a
   * rotation for the key it just created, before reading the keys back.
   */
  acceptKeyCommitment(workspaceId: string, generation: number, commitment: string): Promise<void> {
    return this.exclusive(async () => {
      const key = `workspace/${workspaceId}/key/${String(generation)}`;
      const pinned = await this.read<string>(key);
      if (pinned === undefined) await this.write(key, commitment);
      else if (pinned !== commitment) {
        throw new VaultError(
          "pin_mismatch",
          "another key than the one seen before for this key generation",
        );
      }
    });
  }

  /**
   * Remembers that the owner revoked an agent key, as pending until `settleRevocations`: every
   * later rotation from this device leaves the key out, even when the server forgets the
   * revocation, and an interrupted revoke-and-rotate can resume.
   */
  rememberRevocation(
    workspaceId: string,
    revocation: { readonly tokenId: string; readonly publicKey: Uint8Array },
    pending = true,
  ): Promise<void> {
    return this.exclusive(async () => {
      const key = `workspace/${workspaceId}/revoked`;
      const seen = (await this.read<RevocationMark[]>(key)) ?? [];
      const publicKey = toBase64Url(revocation.publicKey);
      const others = seen.filter((mark) => mark.publicKey !== publicKey);
      await this.write(key, [
        ...others,
        { tokenId: revocation.tokenId, publicKey, pending },
      ] satisfies RevocationMark[]);
    });
  }

  /** The agent keys revoked from this device for a workspace. */
  async revocations(workspaceId: string): Promise<RememberedRevocation[]> {
    const seen = (await this.read<RevocationMark[]>(`workspace/${workspaceId}/revoked`)) ?? [];
    return seen.map((mark) => ({
      tokenId: mark.tokenId,
      publicKey: fromBase64Url(mark.publicKey),
      pending: mark.pending,
    }));
  }

  /** Marks every remembered revocation as done, after a rotation that left them out succeeded. */
  settleRevocations(workspaceId: string): Promise<void> {
    return this.exclusive(async () => {
      const key = `workspace/${workspaceId}/revoked`;
      const seen = (await this.read<RevocationMark[]>(key)) ?? [];
      await this.write(
        key,
        seen.map((mark) => ({ ...mark, pending: false })),
      );
    });
  }

  /** The highest agent policy revision this device verified for a workspace (0 before any). */
  async agentPolicyRevision(workspaceId: string): Promise<number> {
    return (await this.read<number>(`workspace/${workspaceId}/agent-policy`)) ?? 0;
  }

  /**
   * Records a verified agent policy revision as the floor for every later read
   * (`resolveAgentPolicyView`'s `minRevision`), so a server can't replay an older policy to this
   * device. A lower revision changes nothing; the check that refuses it is the resolver's. For a
   * policy this device read itself, use `acceptAgentPolicy`, which pins its hash too.
   */
  acceptAgentPolicyRevision(workspaceId: string, revision: number): Promise<void> {
    return this.exclusive(() => this.raiseAgentPolicyFloor(workspaceId, revision));
  }

  private async raiseAgentPolicyFloor(workspaceId: string, revision: number): Promise<void> {
    const key = `workspace/${workspaceId}/agent-policy`;
    const seen = (await this.read<number>(key)) ?? 0;
    if (revision > seen) await this.write(key, revision);
  }

  /** The pinned agent policy hashes of a workspace, ascending by revision (none before any). */
  private async agentPolicyPins(workspaceId: string): Promise<AgentPolicyPin[]> {
    const pins = await this.read<unknown>(`workspace/${workspaceId}/agent-policy-pins`);
    if (!Array.isArray(pins)) return [];
    return pins.filter(
      (pin): pin is AgentPolicyPin =>
        typeof pin === "object" &&
        pin !== null &&
        Number.isSafeInteger((pin as AgentPolicyPin).revision) &&
        typeof (pin as AgentPolicyPin).policySha256 === "string",
    );
  }

  /**
   * The owner-signed policy hash (`policySha256`) this device verified at an agent policy
   * revision, if it remembers one: it keeps the highest `AGENT_POLICY_PINS` revisions it verified.
   */
  async agentPolicySha256(workspaceId: string, revision: number): Promise<string | undefined> {
    const pins = await this.agentPolicyPins(workspaceId);
    return pins.find((pin) => pin.revision === revision)?.policySha256;
  }

  /**
   * The highest agent policy revision this device verified for a workspace: the floor, or a pin
   * above it (one recorded with `raiseFloor: false`). The owner never signs over a lower base.
   */
  async highestAgentPolicyRevision(workspaceId: string): Promise<number> {
    const pins = await this.agentPolicyPins(workspaceId);
    return Math.max(
      await this.agentPolicyRevision(workspaceId),
      ...pins.map((pin) => pin.revision),
    );
  }

  /**
   * Records a verified agent policy: pins its hash at its revision on first sight and, unless
   * `raiseFloor` is false, raises the floor to it. Returns false, changing nothing, when this
   * device already pinned another hash at that revision: the owner signed two policies at one
   * revision (a server that showed some device an older one to edit), and the caller refuses the
   * policy (`equivocation`). The same hash again is fine.
   */
  acceptAgentPolicy(
    workspaceId: string,
    revision: number,
    policySha256: string,
    options: { readonly raiseFloor?: boolean } = {},
  ): Promise<boolean> {
    return this.exclusive(async () => {
      const pins = await this.agentPolicyPins(workspaceId);
      const pinned = pins.find((pin) => pin.revision === revision);
      if (pinned !== undefined && pinned.policySha256 !== policySha256) return false;
      if (pinned === undefined) {
        const kept = [...pins, { revision, policySha256 }]
          .sort((a, b) => a.revision - b.revision)
          .slice(-AGENT_POLICY_PINS);
        await this.write(`workspace/${workspaceId}/agent-policy-pins`, kept);
      }
      if (options.raiseFloor !== false) await this.raiseAgentPolicyFloor(workspaceId, revision);
      return true;
    });
  }

  /** The highest note version seen (0 before any). */
  async noteVersion(workspaceId: string, noteId: string): Promise<number> {
    return (await this.read<number>(`workspace/${workspaceId}/note/${noteId}`)) ?? 0;
  }

  /**
   * Accepts a verified note version as current, refusing one below the highest seen for the note
   * (`rollback`). The same version again is fine.
   */
  acceptNoteVersion(workspaceId: string, noteId: string, version: number): Promise<void> {
    return this.exclusive(async () => {
      const key = `workspace/${workspaceId}/note/${noteId}`;
      const seen = (await this.read<number>(key)) ?? 0;
      if (version < seen) throw new VaultError("rollback", "an older note version than one seen");
      if (version > seen) await this.write(key, version);
    });
  }
}
