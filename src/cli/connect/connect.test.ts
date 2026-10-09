import { request } from "node:http";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createAgentSigningKeyPair,
  fromBase64Url,
  ready,
  sealConnectPayload,
  toBase64Url,
  wrapAndSignWorkspaceKey,
} from "../../crypto/index.js";
import {
  loopbackConnectUrl,
  parseConnectFragment,
  type SignedAgentKey,
} from "../../protocol/index.js";
import { type FetchLike, type Scheduler, signAgentKey } from "../../client/index.js";
import { World } from "../../client/testing/world.js";
import { wrappedRecord } from "../../client/testing/wrapped.js";
import { temporaryFolder, testContext } from "../testing/context.js";
import { connectCommand } from "../commands/connect.js";
import { ConnectError, runConnect } from "./flow.js";

beforeAll(ready);

const APP_ORIGIN = "https://app.test";

/** Real timers, but every wait is a few milliseconds, so polling tests run fast. */
const fast: Scheduler = {
  setTimeout: (callback) => setTimeout(callback, 5),
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
  now: () => Date.now(),
};

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function setup(wrap: (fetch: FetchLike) => FetchLike = (fetch) => fetch) {
  const world = new World();
  const folder = await temporaryFolder();
  cleanup = folder.cleanup;
  const context = testContext(folder.path, world.server.fetch);
  const run = async (confirm: boolean, interactive = true) =>
    runConnect({
      apiUrl: "https://api.test",
      appUrl: APP_ORIGIN,
      cliVersion: "0.0.0",
      fetch: wrap(world.server.fetch),
      credentials: await context.credentials(),
      trust: context.trust,
      openUrl: (url) => context.io.openUrl(url),
      print: (line) => {
        context.io.out(line);
      },
      interactive,
      confirm: () => Promise.resolve(confirm),
      scheduler: fast,
    });
  return { world, context, run };
}

/** What the browser reads from the link the CLI opened. */
function linkOf(url: string) {
  const parsed = new URL(url);
  const fragment = parseConnectFragment(parsed.hash);
  if (fragment === null) throw new Error("no fragment");
  return { requestId: parsed.searchParams.get("request") ?? "", fragment };
}

/**
 * What the browser's approval does with the link's signing key: the owner vouches for it
 * (`agent_key`, at the current policy revision) and the server stores the record, in place of
 * the world's own. Returns the signed record, as a delivery carries it.
 */
function vouch(world: World, signPublicKey: string): SignedAgentKey {
  world.server.agentKeyRecords.splice(0);
  const signed = signAgentKey(world.signer, {
    workspaceId: world.workspaceId,
    tokenId: world.tokenId,
    signPublicKey: fromBase64Url(signPublicKey),
    policyRevision: world.server.agentPolicy.revision,
  });
  world.server.vouchAgentKey({
    signPublicKey,
    agentKeySignedAt: signed.signedAt,
    agentKeySignature: signed.signature,
  });
  const record = world.server.agentKeyRecords.at(-1);
  if (record === undefined) throw new Error("not vouched");
  return record.signed;
}

/** The browser's delivery for the CLI whose link is `url`, vouching for its signing key. */
function delivery(world: World, url: string, overrides: Record<string, unknown> = {}) {
  const { requestId, fragment } = linkOf(url);
  // the approval stores the link's signing key first, so the token names it
  const agentKey =
    fragment.signPublicKey === undefined ? undefined : vouch(world, fragment.signPublicKey);
  const signed = wrapAndSignWorkspaceKey(world.key, fromBase64Url(fragment.publicKey), {
    accountId: world.accountId,
    workspaceId: world.workspaceId,
    signing: world.account.signing,
    holder: world.tokenId,
  });
  return {
    requestId,
    tokenSecret: world.agentToken,
    token: world.server.agentTokenInfo(),
    ownerId: world.accountId,
    ownerSignPublicKey: toBase64Url(world.account.signing.publicKey),
    wrappedKey: wrappedRecord(
      world.workspaceId,
      { kind: "token", tokenId: world.tokenId },
      signed,
      1,
    ),
    secret: fragment.secret,
    ...(agentKey === undefined ? {} : { agentKey }),
    ...overrides,
  };
}

/** A raw request with a chosen Host header (fetch won't send one). */
function statusWithHost(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const sent = request(
      { host: "127.0.0.1", port, path: "/connect", method: "OPTIONS", headers: { Host: host } },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    sent.on("error", reject);
    sent.end();
  });
}

function post(port: number, body: unknown, origin = APP_ORIGIN) {
  return fetch(loopbackConnectUrl(port), {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("connect over the loopback", () => {
  it("accepts the browser's delivery, pins the owner key and saves the connection", async () => {
    const { world, context, run } = await setup();
    const answers: unknown[] = [];
    let browser: Promise<void> = Promise.resolve();
    context.io.onOpen = (url) => {
      const { fragment } = linkOf(url);
      browser = (async () => {
        const preflight = await fetch(loopbackConnectUrl(fragment.port), {
          method: "OPTIONS",
          headers: {
            Origin: APP_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Private-Network": "true",
          },
        });
        answers.push({
          status: preflight.status,
          origin: preflight.headers.get("access-control-allow-origin"),
          privateNetwork: preflight.headers.get("access-control-allow-private-network"),
        });
        answers.push((await post(fragment.port, {}, "https://evil.test")).status);
        answers.push(await statusWithHost(fragment.port, `evil.test:${String(fragment.port)}`));
        answers.push(
          await (
            await post(fragment.port, {
              ...delivery(world, url),
              secret: toBase64Url(new Uint8Array(32)),
            })
          ).json(),
        );
        answers.push(await (await post(fragment.port, delivery(world, url))).json());
      })();
    };
    const delivered = await run(false);
    await browser;
    expect(delivered.via).toBe("loopback");
    expect(answers).toEqual([
      { status: 204, origin: APP_ORIGIN, privateNetwork: "true" },
      403,
      421,
      { ok: false, error: "bad_secret" },
      { ok: true },
    ]);
    expect(delivered.workspaceKey.key).toEqual(world.key.key);
    const [saved] = await (await context.credentials()).list();
    expect(saved).toMatchObject({
      workspaceId: world.workspaceId,
      tokenId: world.tokenId,
      tokenSecret: world.agentToken,
      ownerSignPublicKey: toBase64Url(world.account.signing.publicKey),
    });
    // its own Ed25519 key, whose public half went in the link, and the owner's agent_key for it
    const { fragment } = linkOf(context.io.opened[0] ?? "");
    expect(fragment.signPublicKey).toBeDefined();
    expect(toBase64Url(fromBase64Url(saved?.agentSignPrivateKey ?? "").slice(32))).toBe(
      fragment.signPublicKey,
    );
    expect(saved?.agentKey?.envelope).toMatchObject({
      type: "agent_key",
      tokenId: world.tokenId,
      signPublicKey: fragment.signPublicKey,
    });
    expect(await context.trust.ownerKey(world.workspaceId)).toEqual(
      world.account.signing.publicKey,
    );
    // the link carries the key and secret only in the fragment, which no server sees
    const [opened] = context.io.opened;
    expect(opened?.startsWith(`${APP_ORIGIN}/connect?request=cr_`)).toBe(true);
    expect(
      world.server.requests.some(({ url }) => url.includes(linkOf(opened ?? "").fragment.secret)),
    ).toBe(false);
  });

  it("refuses a key the owner didn't sign for this CLI", async () => {
    const { world, context, run } = await setup();
    const other = new World();
    const outcome: unknown[] = [];
    context.io.onOpen = (url) => {
      const { fragment } = linkOf(url);
      void (async () => {
        const forged = delivery(world, url, {
          ownerSignPublicKey: toBase64Url(other.account.signing.publicKey),
        });
        outcome.push(await (await post(fragment.port, forged)).json());
        world.server.connectRequests.forEach((entry) => {
          entry.status = "denied";
        });
      })();
    };
    await expect(run(false)).rejects.toMatchObject({ reason: "denied" });
    expect(outcome).toEqual([{ ok: false, error: "bad_signature" }]);
    expect(await (await context.credentials()).list()).toEqual([]);
  });

  it("answers ok only once saved; a different pinned owner key revokes the token", async () => {
    const { world, context, run } = await setup();
    const other = new World();
    await context.trust.pinOwnerKey(
      world.workspaceId,
      toBase64Url(other.account.signing.publicKey),
    );
    const answers: unknown[] = [];
    let browser: Promise<void> = Promise.resolve();
    context.io.onOpen = (url) => {
      browser = (async () => {
        answers.push(await (await post(linkOf(url).fragment.port, delivery(world, url))).json());
      })();
    };
    const error = await run(false).catch((caught: unknown) => caught);
    await browser;
    expect(error).toMatchObject({ reason: "owner_changed" });
    expect((error as Error).message).toContain("the new agent token was revoked");
    expect(answers).toEqual([{ ok: false, error: "owner_changed" }]);
    expect(world.server.tokenRevoked).toBe(true);
    expect(await (await context.credentials()).list()).toEqual([]);
  });
});

describe("connect and the agent's signing key", () => {
  it("pins the policy revision the owner signed into agent_key as the floor", async () => {
    const { world, context, run } = await setup();
    // the workspace's policy is at revision 1 when the person approves
    const web = world.web();
    expect(
      (await web.engine.setAgentPolicy({ default: "review", folders: [], baseRevision: 0 })).status,
    ).toBe("saved");
    let browser: Promise<void> = Promise.resolve();
    context.io.onOpen = (url) => {
      browser = (async () => {
        await post(linkOf(url).fragment.port, delivery(world, url));
      })();
    };
    await run(false);
    await browser;
    const [saved] = await (await context.credentials()).list();
    expect(saved?.agentKey?.envelope.policyRevision).toBe(1);
    expect(await context.trust.agentPolicyRevision(world.workspaceId)).toBe(1);
  });

  it("refuses an agent_key for another key, revokes the token and ends the connect", async () => {
    const { world, context, run } = await setup();
    const answers: unknown[] = [];
    let browser: Promise<void> = Promise.resolve();
    context.io.onOpen = (url) => {
      browser = (async () => {
        // the link's signPublicKey swapped on its way: the owner vouched for someone else's key
        const other = toBase64Url(createAgentSigningKeyPair().publicKey);
        const swapped = { ...delivery(world, url), agentKey: vouch(world, other) };
        swapped.token = world.server.agentTokenInfo();
        answers.push(await (await post(linkOf(url).fragment.port, swapped)).json());
      })();
    };
    const error = await run(false).catch((caught: unknown) => caught);
    await browser;
    expect(error).toMatchObject({ reason: "agent_key_mismatch" });
    expect((error as Error).message).toMatch(/different signing key.*token was revoked/);
    expect(answers).toEqual([{ ok: false, error: "agent_key_mismatch" }]);
    expect(world.server.tokenRevoked).toBe(true);
    expect(await (await context.credentials()).list()).toEqual([]);
  });

  it("refuses an agent_key that doesn't verify under the owner's key", async () => {
    const { world, context, run } = await setup();
    const forger = new World();
    const answers: unknown[] = [];
    let browser: Promise<void> = Promise.resolve();
    context.io.onOpen = (url) => {
      browser = (async () => {
        const { fragment } = linkOf(url);
        const genuine = delivery(world, url);
        // the right key and token, signed by someone else
        const forged = signAgentKey(forger.signer, {
          workspaceId: world.workspaceId,
          tokenId: world.tokenId,
          signPublicKey: fromBase64Url(fragment.signPublicKey ?? ""),
          policyRevision: 0,
        });
        const agentKey = {
          envelope: { ...genuine.agentKey?.envelope, createdAt: forged.signedAt },
          signature: forged.signature,
        };
        answers.push(await (await post(fragment.port, { ...genuine, agentKey })).json());
      })();
    };
    const error = await run(false).catch((caught: unknown) => caught);
    await browser;
    expect(error).toMatchObject({ reason: "agent_key_mismatch" });
    expect(answers).toEqual([{ ok: false, error: "agent_key_mismatch" }]);
    expect(world.server.tokenRevoked).toBe(true);
  });

  it("says how the agent's changes land once connected", async () => {
    const { world, context } = await setup();
    let browser: Promise<void> = Promise.resolve();
    context.io.onOpen = (url) => {
      browser = (async () => {
        await post(linkOf(url).fragment.port, delivery(world, url));
      })();
    };
    expect(await connectCommand(context, ["--no-agents"])).toBe(0);
    await browser;
    expect(context.io.lines).toContain(
      `Connected to workspace ${world.workspaceId} (read and write).`,
    );

    // a folder that asks first
    const web = world.web();
    await web.engine.setAgentPolicy({ default: "review", folders: [], baseRevision: 0 });
    context.io.onOpen = (url) => {
      browser = (async () => {
        await post(linkOf(url).fragment.port, delivery(world, url));
      })();
    };
    expect(await connectCommand(context, ["--no-agents"])).toBe(0);
    await browser;
    expect(context.io.lines).toContain(
      `Connected to workspace ${world.workspaceId} (read; changes need approval).`,
    );
  });

  it("revokes the token of the connection it replaces, or says to", async () => {
    const { world, context, run } = await setup();
    // an earlier connection to the same workspace, with a token the server no longer knows
    await (
      await context.credentials()
    ).put({
      apiUrl: "https://api.test",
      workspaceId: world.workspaceId,
      tokenId: "tok_00000000000000000000000009",
      tokenSecret: `kta_${"o".repeat(43)}`,
      access: "read-write",
      folderIds: [],
      agentPrivateKey: toBase64Url(world.agent.privateKey),
      ownerId: world.accountId,
      ownerSignPublicKey: toBase64Url(world.account.signing.publicKey),
      connectedAt: new Date().toISOString(),
    });
    let browser: Promise<void> = Promise.resolve();
    context.io.onOpen = (url) => {
      browser = (async () => {
        await post(linkOf(url).fragment.port, delivery(world, url));
      })();
    };
    await run(false);
    await browser;
    expect(
      world.server.requests.some(
        (request) =>
          request.init.method === "DELETE" &&
          request.url.endsWith("/tokens/tok_00000000000000000000000009"),
      ),
    ).toBe(true);
    expect(context.io.lines.join("\n")).toMatch(
      /no longer uses its earlier agent token for the workspace \(tok_0+9\): revoke it/,
    );
    const saved = await (await context.credentials()).list();
    expect(saved.map((entry) => entry.tokenId)).toEqual([world.tokenId]);
  });

  it("saves a connection without agent_key as propose-only, not as an error", async () => {
    const { world, context, run } = await setup();
    let browser: Promise<void> = Promise.resolve();
    context.io.onOpen = (url) => {
      browser = (async () => {
        // a web app that doesn't vouch sends no agentKey
        const older: Record<string, unknown> = delivery(world, url);
        delete older["agentKey"];
        await post(linkOf(url).fragment.port, older);
      })();
    };
    await run(false);
    await browser;
    const [saved] = await (await context.credentials()).list();
    expect(saved?.tokenId).toBe(world.tokenId);
    expect(saved?.agentKey).toBeUndefined();
  });
});

describe("connect through the relay", () => {
  /** The relayed delivery, the owner having vouched for `signPublicKey` (default: the link's). */
  function relay(world: World, url: string, signPublicKey?: string): string {
    const { fragment } = linkOf(url);
    const vouched = signPublicKey ?? fragment.signPublicKey;
    if (vouched !== undefined) vouch(world, vouched);
    const cliPublicKey = fromBase64Url(fragment.publicKey);
    const signedWrappedKey = wrapAndSignWorkspaceKey(world.key, cliPublicKey, {
      accountId: world.accountId,
      workspaceId: world.workspaceId,
      signing: world.account.signing,
      holder: world.tokenId,
    });
    const sealed = sealConnectPayload(
      {
        token: world.agentToken,
        ownerSigningPublicKey: world.account.signing.publicKey,
        signedWrappedKey,
      },
      { secret: fromBase64Url(fragment.secret), cliPublicKey },
    );
    return toBase64Url(sealed);
  }

  it("accepts a relayed delivery once the person confirms the code", async () => {
    const { world, context, run } = await setup();
    context.io.onOpen = (url) => {
      const entry = world.server.connectRequests.get(linkOf(url).requestId);
      if (entry !== undefined) entry.relay = relay(world, url);
    };
    const delivered = await run(true);
    expect(delivered.via).toBe("relay");
    expect(delivered.confirmationCode).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(context.io.lines).toContain(`Confirmation code: ${delivered.confirmationCode}`);
    const [saved] = await (await context.credentials()).list();
    expect(saved).toMatchObject({ tokenId: world.tokenId });
    // the sealed payload has no agent_key: it was read from listKeys and checked
    expect(saved?.agentKey?.envelope.signPublicKey).toBe(
      linkOf(context.io.opened[0] ?? "").fragment.signPublicKey,
    );
  });

  it("saves a relayed connection whose agent_key the server hides as propose-only, and says so", async () => {
    const { world, context, run } = await setup();
    context.io.onOpen = (url) => {
      const entry = world.server.connectRequests.get(linkOf(url).requestId);
      if (entry === undefined) return;
      entry.relay = relay(world, url);
      // the token names this CLI's key, but listKeys leaves the record out
      world.server.agentKeyRecords.splice(0);
    };
    await run(true);
    const [saved] = await (await context.credentials()).list();
    expect(saved?.tokenId).toBe(world.tokenId);
    expect(saved?.agentKey).toBeUndefined();
    expect(context.io.lines.join("\n")).toMatch(/didn't vouch for this computer's signing key/);
  });

  it("revokes the token when a relayed connection can't be checked", async () => {
    const { world, context, run } = await setup();
    context.io.onOpen = (url) => {
      const entry = world.server.connectRequests.get(linkOf(url).requestId);
      if (entry !== undefined) entry.relay = relay(world, url);
      world.server.tamper.refuse = (route) => (route === "listKeys" ? "forbidden" : undefined);
    };
    const error = await run(true).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: "cancelled" });
    expect((error as Error).message).toMatch(/couldn't be checked.*token was revoked/);
    expect(world.server.tokenRevoked).toBe(true);
    expect(await (await context.credentials()).list()).toEqual([]);
  });

  it("refuses a relayed connection whose owner vouched for another key", async () => {
    const { world, context, run } = await setup();
    context.io.onOpen = (url) => {
      const entry = world.server.connectRequests.get(linkOf(url).requestId);
      if (entry !== undefined) {
        entry.relay = relay(world, url, toBase64Url(createAgentSigningKeyPair().publicKey));
      }
    };
    const error = await run(true).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: "agent_key_mismatch" });
    expect((error as Error).message).toMatch(/different signing key/);
    expect(world.server.tokenRevoked).toBe(true);
    expect(await (await context.credentials()).list()).toEqual([]);
  });

  it("saves nothing when the codes don't match", async () => {
    const { world, context, run } = await setup();
    context.io.onOpen = (url) => {
      const entry = world.server.connectRequests.get(linkOf(url).requestId);
      if (entry !== undefined) entry.relay = relay(world, url);
    };
    const error = await run(false).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectError);
    expect(error).toMatchObject({ reason: "cancelled" });
    expect(await (await context.credentials()).list()).toEqual([]);
    expect(world.server.tokenRevoked).toBe(true);
  });

  it("says a terminal is needed when nobody can confirm the code", async () => {
    const { world, context, run } = await setup();
    context.io.onOpen = (url) => {
      const entry = world.server.connectRequests.get(linkOf(url).requestId);
      if (entry !== undefined) entry.relay = relay(world, url);
    };
    const error = await run(true, false).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: "no_terminal" });
    expect((error as Error).message).toContain("in a terminal");
    expect(world.server.tokenRevoked).toBe(true);
    expect(await (await context.credentials()).list()).toEqual([]);
  });

  it("keeps polling through network failures", async () => {
    let failures = 0;
    const { world, context, run } = await setup((fetch) => (url, init) => {
      if (url.includes("/poll") && failures < 2) {
        failures++;
        return Promise.reject(new TypeError("fetch failed"));
      }
      return fetch(url, init);
    });
    context.io.onOpen = (url) => {
      const entry = world.server.connectRequests.get(linkOf(url).requestId);
      if (entry !== undefined) entry.relay = relay(world, url);
    };
    const delivered = await run(true);
    expect(failures).toBe(2);
    expect(delivered.via).toBe("relay");
  });

  it("stops when the request expires", async () => {
    const { world, context, run } = await setup();
    context.io.onOpen = (url) => {
      const entry = world.server.connectRequests.get(linkOf(url).requestId);
      if (entry !== undefined) entry.status = "expired";
    };
    await expect(run(false)).rejects.toMatchObject({ reason: "expired" });
  });
});
