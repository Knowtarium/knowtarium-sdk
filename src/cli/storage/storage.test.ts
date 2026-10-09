import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { z } from "zod";

import {
  createAgentSigningKeyPair,
  fromBase64Url,
  ready,
  toBase64Url,
} from "../../crypto/index.js";
import { sodium } from "../../crypto/sodium.js";
import { TrustState } from "../../client/index.js";
import { temporaryFolder } from "../testing/context.js";
import {
  agentSigningKeyPair,
  type Connection,
  Credentials,
  CredentialsLockedError,
  readConnectionSummaries,
  writesDirectly,
} from "./credentials.js";
import { FileCacheAdapter } from "./file-cache.js";
import { FileTrustStorage } from "./file-trust.js";
import { withFileLock } from "./lock.js";
import { MemorySecretStore } from "./secret-store.js";

beforeAll(ready);

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function folder(): Promise<string> {
  const created = await temporaryFolder();
  cleanup = created.cleanup;
  return created.path;
}

const connection: Connection = {
  apiUrl: "https://api.test",
  workspaceId: "ws_00000000000000000000000001",
  tokenId: "tok_00000000000000000000000001",
  tokenSecret: `kta_${"s".repeat(43)}`,
  access: "read-write",
  folderIds: [],
  agentPrivateKey: "A".repeat(43),
  ownerId: "acc_00000000000000000000000001",
  ownerSignPublicKey: "B".repeat(43),
  connectedAt: "2026-10-01T12:00:00.000Z",
};

describe("credentials", () => {
  it("keeps connections encrypted under a key in the secret store", async () => {
    const home = await folder();
    const secrets = new MemorySecretStore();
    const credentials = new Credentials(home, secrets);
    await credentials.put(connection);
    expect(await credentials.list()).toEqual([connection]);
    const file = await readFile(join(home, "credentials.enc"));
    expect(file.toString("latin1")).not.toContain(connection.tokenSecret);
    // POSIX permissions (Windows has ACLs instead)
    if (process.platform !== "win32") {
      expect((await stat(join(home, "credentials.enc"))).mode & 0o777).toBe(0o600);
    }
    const summaries = await readConnectionSummaries(home);
    expect(summaries.map((summary) => "tokenSecret" in summary)).toEqual([false]);
    // without the key the file is refused, never silently replaced
    await expect(new Credentials(home, new MemorySecretStore()).list()).rejects.toBeInstanceOf(
      CredentialsLockedError,
    );
    await expect(
      new Credentials(home, new MemorySecretStore()).put(connection),
    ).rejects.toBeInstanceOf(CredentialsLockedError);
    await credentials.remove(connection.workspaceId);
    expect(await credentials.list()).toEqual([]);
    expect(secrets.values.size).toBe(0);
    expect(await readConnectionSummaries(home)).toEqual([]);
  });

  it("keeps the signing key in its own file, so an older CLI still reads credentials.enc", async () => {
    const home = await folder();
    const secrets = new MemorySecretStore();
    const credentials = new Credentials(home, secrets);
    // a connection saved before direct writes: no signing key, no agent_key
    await credentials.put(connection);
    const signing = createAgentSigningKeyPair();
    const secret = toBase64Url(signing.privateKey);
    const newer: Connection = {
      ...connection,
      workspaceId: "ws_00000000000000000000000002",
      agentSignPrivateKey: secret,
    };
    await credentials.put(newer);
    expect(await credentials.list()).toEqual([connection, newer]);
    expect(agentSigningKeyPair(connection)).toBeNull();
    expect(agentSigningKeyPair(newer)?.publicKey).toEqual(signing.publicKey);
    // no agent_key: it only proposes
    expect(writesDirectly(newer)).toBe(false);

    // credentials.enc is exactly the format older CLIs parse strictly
    const key = fromBase64Url(secrets.values.get("credentials-key") ?? "");
    const main = openSealed(await readFile(join(home, "credentials.enc")), key, CREDENTIALS_AD);
    expect(OlderCredentialsFile.safeParse(main).success).toBe(true);
    expect(JSON.stringify(main)).not.toContain(secret);
    // the signing key is sealed in agent-keys.enc, and never in connections.json
    const sidecar = openSealed(await readFile(join(home, "agent-keys.enc")), key, AGENT_KEYS_AD);
    expect(JSON.stringify(sidecar)).toContain(secret);
    if (process.platform !== "win32") {
      expect((await stat(join(home, "agent-keys.enc"))).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(join(home, "connections.json"), "utf8")).not.toContain(secret);
    const summaries = await readConnectionSummaries(home);
    expect(summaries.map((summary) => "agentSignPrivateKey" in summary)).toEqual([false, false]);

    // an older CLI connected the workspace again (another token): the old key no longer counts
    const older: Record<string, unknown> = {
      ...newer,
      tokenId: "tok_00000000000000000000000002",
    };
    delete older["agentSignPrivateKey"];
    await writeFile(
      join(home, "credentials.enc"),
      sealWith({ version: 1, connections: [connection, older] }, key, CREDENTIALS_AD),
    );
    const [, reloaded] = await credentials.list();
    expect(reloaded?.tokenId).toBe("tok_00000000000000000000000002");
    expect(reloaded?.agentSignPrivateKey).toBeUndefined();

    // removing the last connection deletes the agent keys too
    await credentials.remove(connection.workspaceId);
    await credentials.remove(newer.workspaceId);
    expect(await readdir(home)).toEqual([]);
  });

  it("keeps fields a newer CLI added when it rewrites the files", async () => {
    const home = await folder();
    const secrets = new MemorySecretStore();
    const credentials = new Credentials(home, secrets);
    await credentials.put(connection);
    const key = fromBase64Url(secrets.values.get("credentials-key") ?? "");
    await writeFile(
      join(home, "credentials.enc"),
      sealWith(
        { version: 1, connections: [{ ...connection, fromTheFuture: "kept" }], more: 1 },
        key,
        CREDENTIALS_AD,
      ),
    );
    await credentials.put({ ...connection, workspaceId: "ws_00000000000000000000000002" });
    const main = openSealed(await readFile(join(home, "credentials.enc")), key, CREDENTIALS_AD);
    expect(JSON.stringify(main)).toContain('"fromTheFuture":"kept"');
    // but never into connections.json: an unknown field may be a secret
    expect(await readFile(join(home, "connections.json"), "utf8")).not.toContain("fromTheFuture");
  });
});

const CREDENTIALS_AD = new TextEncoder().encode("knowtarium-cli-credentials-v1");
const AGENT_KEYS_AD = new TextEncoder().encode("knowtarium-cli-agent-keys-v1");

/** credentials.enc as the CLI versions before direct writes parse it. */
const OlderCredentialsFile = z.strictObject({
  version: z.literal(1),
  connections: z.array(
    z.strictObject({
      apiUrl: z.string(),
      workspaceId: z.string(),
      tokenId: z.string(),
      tokenSecret: z.string(),
      access: z.string(),
      folderIds: z.array(z.string()),
      agentPrivateKey: z.string(),
      ownerId: z.string(),
      ownerSignPublicKey: z.string(),
      connectedAt: z.string(),
    }),
  ),
});

function openSealed(sealed: Uint8Array, key: Uint8Array, ad: Uint8Array): unknown {
  const lib = sodium();
  const end = 1 + lib.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  const plaintext = lib.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    sealed.subarray(end),
    ad,
    sealed.subarray(1, end),
    key,
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

function sealWith(value: unknown, key: Uint8Array, ad: Uint8Array): Uint8Array {
  const lib = sodium();
  const nonce = lib.randombytes_buf(lib.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = lib.crypto_aead_xchacha20poly1305_ietf_encrypt(
    new TextEncoder().encode(JSON.stringify(value)),
    ad,
    null,
    nonce,
    key,
  );
  return new Uint8Array([1, ...nonce, ...ciphertext]);
}

describe("file cache", () => {
  it("stores, lists and deletes by key, and refuses keys that leave its folder", async () => {
    const cache = new FileCacheAdapter(await folder());
    await cache.put("ws/ws_1/notes/note_1/blob", new Uint8Array([1, 2, 3]));
    await cache.put("ws/ws_1/cursor", new Uint8Array([4]));
    expect(await cache.get("ws/ws_1/notes/note_1/blob")).toEqual(new Uint8Array([1, 2, 3]));
    expect((await cache.list("ws/ws_1/")).sort()).toEqual([
      "ws/ws_1/cursor",
      "ws/ws_1/notes/note_1/blob",
    ]);
    await cache.delete("ws/ws_1/cursor");
    expect(await cache.get("ws/ws_1/cursor")).toBeUndefined();
    await expect(cache.put("ws/../../etc", new Uint8Array())).rejects.toThrow();
    await expect(cache.get("/etc/passwd")).rejects.toThrow();
  });
});

describe("the advisory lock", () => {
  it("runs one holder at a time and breaks a stale lock", async () => {
    const home = await folder();
    const path = join(home, "file");
    const order: string[] = [];
    const hold = (name: string) =>
      withFileLock(path, async () => {
        order.push(`${name} in`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push(`${name} out`);
      });
    await Promise.all([hold("a"), hold("b")]);
    // whichever got the lock first, the two never overlap
    expect([order[0]?.split(" ")[0], order[1]?.split(" ")[0]]).toEqual([
      order[0]?.split(" ")[0],
      order[0]?.split(" ")[0],
    ]);
    expect(order.map((entry) => entry.split(" ")[1])).toEqual(["in", "out", "in", "out"]);
    // held by a live process (our parent): waited for, then refused, unless it went stale
    await writeFile(`${path}.lock`, `${String(process.ppid)}:alive`);
    await expect(withFileLock(path, () => Promise.resolve(1), { timeoutMs: 50 })).rejects.toThrow(
      /delete/,
    );
    expect(await withFileLock(path, () => Promise.resolve(2), { staleMs: 0 })).toBe(2);
    // left by a process that is gone (an agent killed its MCP server): broken at once
    await writeFile(`${path}.lock`, "999999:dead");
    const started = Date.now();
    expect(await withFileLock(path, () => Promise.resolve(3), { timeoutMs: 5_000 })).toBe(3);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("lets only one of several processes breaking a dead lock at once hold it", async () => {
    const home = await folder();
    const path = join(home, "file");
    for (let round = 0; round < 3; round++) {
      await writeFile(`${path}.lock`, "999999:dead");
      let holding = 0;
      let most = 0;
      await Promise.all(
        Array.from({ length: 8 }, () =>
          withFileLock(
            path,
            async () => {
              holding++;
              most = Math.max(most, holding);
              await new Promise((resolve) => setTimeout(resolve, 5));
              holding--;
            },
            { timeoutMs: 10_000 },
          ),
        ),
      );
      expect(most).toBe(1);
      // nothing left behind: no lock, no broken copies
      expect((await readdir(home)).filter((name) => name.includes(".lock"))).toEqual([]);
    }
  }, 30_000);
});

describe("file trust storage", () => {
  it("keeps marks across runs", async () => {
    const home = await folder();
    await new FileTrustStorage(home).set("workspace/ws_1/generation", "3");
    expect(await new FileTrustStorage(home).get("workspace/ws_1/generation")).toBe("3");
  });

  it("loads a trust.json written before agent policy pins, and adds them", async () => {
    const home = await folder();
    await writeFile(
      join(home, "trust.json"),
      JSON.stringify({ "workspace/ws_1/agent-policy": "4", "workspace/ws_1/generation": "2" }),
    );
    const trust = new TrustState(new FileTrustStorage(home));
    expect(await trust.agentPolicyRevision("ws_1")).toBe(4);
    expect(await trust.agentPolicySha256("ws_1", 4)).toBeUndefined();
    expect(await trust.acceptAgentPolicy("ws_1", 4, "hash-a")).toBe(true);
    const again = new TrustState(new FileTrustStorage(home));
    expect(await again.acceptAgentPolicy("ws_1", 4, "hash-b")).toBe(false);
    expect(await again.agentPolicyRevision("ws_1")).toBe(4);
    expect(await again.keyGeneration("ws_1")).toBe(2);
  });

  it("keeps what another process wrote meanwhile", async () => {
    const home = await folder();
    const first = new FileTrustStorage(home);
    const second = new FileTrustStorage(home);
    await first.set("a", "1");
    await second.set("b", "2");
    await first.set("c", "3");
    await second.delete("a");
    const reader = new FileTrustStorage(home);
    expect([await reader.get("a"), await reader.get("b"), await reader.get("c")]).toEqual([
      undefined,
      "2",
      "3",
    ]);
  });
});
