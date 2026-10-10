import { beforeAll, describe, expect, it } from "vitest";

import { signClip } from "../../clip/frame.js";
import {
  createExtensionKeys,
  type ExtensionKeys,
  normalizeClip,
  ready as clipReady,
  signAndSealClip,
} from "../../clip/index.js";
import { clipNoteText, parseNote } from "../../core/index.js";
import { concatBytes, fromHex, uint32BE } from "../../crypto/encoding.js";
import {
  boxKeyPairFromPrivateKey,
  deriveInboxKeyPair,
  fromBase64Url,
  ready,
  toBase64Url,
} from "../../crypto/index.js";
import { sodium } from "../../crypto/sodium.js";
import vectors from "../../crypto/vectors.json" with { type: "json" };
import {
  type ClipId,
  clipNoteId,
  type ExtensionId,
  type FolderId,
  type NoteId,
  routes,
  type SignedInboxKey,
} from "../../protocol/index.js";
import { isVaultError } from "../errors/index.js";
import { newId } from "../platform/ids.js";
import type { ClipFolder, FileClipsOptions } from "../sync/index.js";
import { type Client, World } from "../testing/world.js";
import { prepareFolder, rotateWorkspace, signExtensionKey, signInboxKey } from "../vault/index.js";
import { fetchInboxKey } from "./inbox.js";
import { clippedRecord, verifyClippedRecord } from "./clipped.js";
import { clipSignedBy, openClip } from "./open.js";

beforeAll(async () => {
  await ready();
  await clipReady();
});

const [first] = vectors.clips;
if (first === undefined) throw new Error("no clip vectors");
const inboxPair = (privateKey: string, generation: number) => ({
  ...boxKeyPairFromPrivateKey(fromHex(privateKey)),
  generation,
});

describe("opening clips (the vectors)", () => {
  it.each(vectors.clips)("opens $name with the inbox private key", (vector) => {
    const opened = openClip(fromHex(vector.sealed), inboxPair(vector.inboxPrivateKey, 3));
    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.clip.payload).toEqual(vector.payload);
    expect(opened.clip.json).toBe(vector.canonical);
    expect(clipSignedBy(opened.clip, fromHex(vector.signPublicKey))).toBe(true);
    expect(clipSignedBy(opened.clip, createExtensionKeys().publicKey)).toBe(false);
  });

  it("opens nothing with another generation's key", () => {
    const [, other] = vectors.inboxKeyPairs;
    const opened = openClip(fromHex(first.sealed), inboxPair(other?.privateKey ?? "", 3));
    expect(opened).toEqual({ ok: false, reason: "unreadable" });
  });

  it.each(vectors.tamperedClips)("refuses $name ($error)", (vector) => {
    const opened = openClip(fromHex(vector.sealed), inboxPair(first.inboxPrivateKey, 3));
    let reason: string;
    if (!opened.ok) reason = opened.reason;
    else if (
      opened.clip.payload.clipId !== first.payload.clipId ||
      opened.clip.payload.extensionId !== first.payload.extensionId ||
      opened.clip.payload.workspaceId !== first.payload.workspaceId
    ) {
      reason = "mismatch";
    } else if (!clipSignedBy(opened.clip, fromHex(first.signPublicKey))) reason = "bad_signature";
    else reason = "accepted";
    expect(reason).toBe(vector.error);
  });
});

describe("the clipped record", () => {
  const expected: Parameters<typeof verifyClippedRecord>[1] & { signPublicKey: Uint8Array } = {
    workspaceId: first.payload.workspaceId,
    noteId: clipNoteId(first.payload.clipId as ClipId),
    firstVersionUrl: first.payload.url,
    signPublicKey: new Uint8Array(0),
  };
  let record: ReturnType<typeof clippedRecord>;
  beforeAll(() => {
    const opened = openClip(fromHex(first.sealed), inboxPair(first.inboxPrivateKey, 3));
    if (!opened.ok) throw new Error(opened.reason);
    record = clippedRecord(opened.clip, { actor: "human:acc_x", at: "2026-10-10T10:00:00Z" });
    expected.signPublicKey = fromHex(first.signPublicKey);
  });

  it("keeps the payload exactly as signed", () => {
    expect(record).toMatchObject({ type: "clipped", version: 1, payload: first.canonical });
    expect(verifyClippedRecord(record, expected)).toBe(true);
  });

  it("holds only for its own note, the first version's link and the extension's key", () => {
    expect(verifyClippedRecord(record, { ...expected, noteId: newId("note") })).toBe(false);
    expect(
      verifyClippedRecord(record, { ...expected, firstVersionUrl: "https://evil.example/" }),
    ).toBe(false);
    expect(verifyClippedRecord(record, { ...expected, firstVersionUrl: null })).toBe(false);
    expect(
      verifyClippedRecord(record, { ...expected, signPublicKey: createExtensionKeys().publicKey }),
    ).toBe(false);
    const edited = record.payload.replace("How we sped", "How they sped");
    expect(verifyClippedRecord({ ...record, payload: edited }, expected)).toBe(false);
    expect(verifyClippedRecord({ ...record, clipId: newId("clip") }, expected)).toBe(false);
  });
});

/** The decrypted folders and note names a client's engine reported, as the filer reads them. */
function viewOf(client: Client) {
  const folders = new Map<string, ClipFolder>();
  const notes = new Map<NoteId, { folderId: FolderId; name: string | null; text: string | null }>();
  client.engine.subscribe((event) => {
    if (event.type === "folder") {
      if (event.folder.deleted || event.folder.name === null) folders.delete(event.folder.folderId);
      else
        folders.set(event.folder.folderId, {
          name: event.folder.name,
          parentId: event.folder.parentId,
        });
    }
    if (event.type === "note") notes.set(event.note.noteId, event.note);
  });
  return {
    folders,
    notes,
    options(extra: Partial<FileClipsOptions> = {}): FileClipsOptions {
      return {
        folders,
        takenNames: (folderId) =>
          [...notes.values()]
            .filter((note) => note.folderId === folderId && note.name !== null)
            .map((note) => note.name ?? ""),
        actor: "claude-code/1.0",
        ...extra,
      };
    },
  };
}

async function createFolder(
  world: World,
  web: Client,
  name: string,
  parentId: FolderId | null = null,
) {
  const request = prepareFolder(world.signer, world.key, {
    workspaceId: world.workspaceId,
    parentId,
    name,
    rootFolderId: null,
  });
  await web.api.call(routes.createFolder, {
    params: { workspaceId: world.workspaceId },
    body: request,
  });
  return request.id;
}

interface Paired {
  readonly extensionId: ExtensionId;
  readonly keys: ExtensionKeys;
}

/** Pairs an extension as the web app's approval does: the owner signs its key. */
function pair(world: World, revokedAt: string | null = null): Paired {
  const keys = createExtensionKeys();
  const extensionId = newId("ext");
  const signed = signExtensionKey(world.signer, {
    workspaceId: world.workspaceId,
    extensionId,
    signPublicKey: keys.publicKey,
  });
  world.server.extensions.push({
    extensionId,
    signPublicKey: toBase64Url(keys.publicKey),
    keySignedAt: signed.signedAt,
    keySignature: signed.signature,
    encName: toBase64Url(new Uint8Array(64)),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    lastClipAt: null,
    revokedAt,
  });
  return { extensionId, keys };
}

/** What the extension sends: a clean payload, signed and sealed with knowtarium/clip. */
function save(
  world: World,
  paired: Paired,
  inboxKey: SignedInboxKey,
  fields: { url?: string; title?: string; note?: string; category?: string } = {},
  postedAt?: string,
): ClipId {
  const clipId = newId("clip");
  const blob = signAndSealClip(
    {
      clipId,
      workspaceId: world.workspaceId,
      extensionId: paired.extensionId,
      url: fields.url ?? "https://example.com/blog/faster-builds",
      title: fields.title ?? "How we sped up our build",
      note: fields.note ?? "Read before the CI meeting.",
      category: fields.category ?? "",
      savedAt: "2026-10-10T09:41:07.512Z",
    },
    { signingSecretKey: paired.keys.privateKey, inboxKey: inboxKey.envelope },
  );
  world.server.queueClip({
    clipId,
    extensionId: paired.extensionId,
    blob,
    ...(postedAt === undefined ? {} : { postedAt }),
  });
  return clipId;
}

/** A workspace with an inbox folder and a signed inbox key, and the web app's view of it. */
async function withInbox() {
  const world = new World();
  const web = world.web();
  const view = viewOf(web);
  const inboxId = await createFolder(world, web, "Inbox");
  const ensured = await web.engine.ensureInboxKey({ folderId: inboxId });
  if (ensured.inboxKey === null) throw new Error("no inbox key");
  await web.engine.pull();
  return { world, web, view, inboxId, inboxKey: ensured.inboxKey };
}

describe("the inbox key", () => {
  it("signs the first one for the folder, then keeps it while it is current", async () => {
    const { world, web, inboxId, inboxKey } = await withInbox();
    expect(inboxKey.envelope).toMatchObject({ revision: 1, generation: 1, folderId: inboxId });
    expect(inboxKey.envelope.publicKey).toBe(toBase64Url(deriveInboxKeyPair(world.key).publicKey));
    expect(await web.engine.ensureInboxKey()).toMatchObject({ status: "unchanged" });
    expect(world.server.inboxKeys).toHaveLength(1);
  });

  it("does nothing for a workspace without an inbox", async () => {
    const world = new World();
    expect(await world.web().engine.ensureInboxKey()).toEqual({ status: "none", inboxKey: null });
  });

  it("signs a new revision for a new inbox folder and after a rotation", async () => {
    const { world, web } = await withInbox();
    const again = await createFolder(world, web, "Inbox 2");
    expect(await web.engine.ensureInboxKey({ folderId: again })).toMatchObject({
      status: "signed",
    });
    await rotateWorkspace(web.api, {
      workspaceId: world.workspaceId,
      signer: world.signer,
      ownerBoxPublicKey: world.account.encryption.publicKey,
      keys: web.keys,
      trust: web.trust,
    });
    const latest = world.server.inboxKey;
    expect(latest?.envelope).toMatchObject({ revision: 3, generation: 2, folderId: again });
    const keyring = await web.keys.get();
    expect(latest?.envelope.publicKey).toBe(
      toBase64Url(deriveInboxKeyPair(keyring.current).publicKey),
    );
  });

  it("refuses an inbox key the owner didn't sign, or one swapped for another key", async () => {
    const { world, web } = await withInbox();
    const stored = world.server.inboxKeys[0];
    if (stored === undefined) throw new Error("no inbox key");
    const owner = { publicKey: world.account.signing.publicKey, accountId: world.accountId };
    const read = () => fetchInboxKey(web.api, { workspaceId: world.workspaceId, owner });
    await expect(read()).resolves.toEqual(stored);
    const swapped = {
      ...stored,
      envelope: { ...stored.envelope, publicKey: toBase64Url(createExtensionKeys().publicKey) },
    };
    world.server.inboxKeys[0] = swapped;
    const error = await read().catch((caught: unknown) => caught);
    expect(isVaultError(error, "untrusted_signature")).toBe(true);
  });
});

describe("filing clips in the web app", () => {
  it("files a clip as the person's note in the inbox, with its clipped record", async () => {
    const { world, web, view, inboxId, inboxKey } = await withInbox();
    const paired = pair(world);
    const clipId = save(world, paired, inboxKey);
    const result = await web.engine.fileClips(view.options());
    const noteId = clipNoteId(clipId);
    expect(result).toMatchObject({
      status: "done",
      filed: [
        { clipId, noteId, folderId: inboxId, name: "How we sped up our build.md", recorded: true },
      ],
      duplicates: [],
      rejected: [],
      released: [],
    });
    expect(world.server.clipQueue.size).toBe(0);
    expect(world.server.acked).toEqual([clipId]);
    const note = await web.engine.readNote(noteId);
    expect(note.text).toBe(
      [
        "---",
        "title: How we sped up our build",
        "type: Clip",
        "status: inbox",
        "url: https://example.com/blog/faster-builds",
        "saved: 2026-10-10T09:41:07.512Z",
        "---",
        "Read before the CI meeting.",
      ].join("\n"),
    );
    expect(note.signedWrite?.by).toBe(world.accountId);
    // "Saved from": the record holds under the extension's vouched key
    const clipped = await clippedEntry(web, noteId);
    expect(clipped?.signature).toBe("verified");
    const record = clipped?.event as Parameters<typeof verifyClippedRecord>[0];
    expect(
      verifyClippedRecord(record, {
        workspaceId: world.workspaceId,
        noteId,
        firstVersionUrl: "https://example.com/blog/faster-builds",
        signPublicKey: paired.keys.publicKey,
      }),
    ).toBe(true);
  });

  it("files into a category folder, making a new one when the web app may", async () => {
    const { world, web, view, inboxId, inboxKey } = await withInbox();
    const paired = pair(world);
    const reading = await createFolder(world, web, "Reading", inboxId);
    await web.engine.pull();
    const known = save(world, paired, inboxKey, { category: "READING" });
    const fresh = save(world, paired, inboxKey, { category: "Recipes", title: "" });
    const made: string[] = [];
    const result = await web.engine.fileClips(
      view.options({
        createFolder: async (name, parentId) => {
          made.push(name);
          return createFolder(world, web, name, parentId);
        },
      }),
    );
    expect(made).toEqual(["Recipes"]);
    expect(result.filed.find((entry) => entry.clipId === known)?.folderId).toBe(reading);
    const recipes = result.filed.find((entry) => entry.clipId === fresh);
    if (recipes === undefined) throw new Error("not filed");
    expect(recipes.folderId).not.toBe(inboxId);
    expect(world.server.folders.get(recipes.folderId)?.parentId).toBe(inboxId);
    // no title: named after the link's host
    expect(recipes.name).toBe("example.com.md");
  });

  it("numbers a name taken in the folder", async () => {
    const { world, web, view, inboxKey } = await withInbox();
    const paired = pair(world);
    save(world, paired, inboxKey);
    save(world, paired, inboxKey);
    const result = await web.engine.fileClips(view.options());
    expect(result.filed.map((entry) => entry.name).sort()).toEqual([
      "How we sped up our build 2.md",
      "How we sped up our build.md",
    ]);
  });

  it("files a clip once when two clients race for it, or when it was filed already", async () => {
    const { world, web, view, inboxKey } = await withInbox();
    const paired = pair(world);
    const clipId = save(world, paired, inboxKey);
    // the first filer's ack got lost: the clip comes back after its lease
    const firstPass = await web.engine.fileClips(view.options());
    expect(firstPass.filed).toHaveLength(1);
    const blob = signAndSealClip(
      {
        clipId,
        workspaceId: world.workspaceId,
        extensionId: paired.extensionId,
        url: "https://example.com/blog/faster-builds",
        savedAt: "2026-10-10T09:41:07.512Z",
      },
      { signingSecretKey: paired.keys.privateKey, inboxKey: inboxKey.envelope },
    );
    world.server.clipQueue.set(clipId, {
      clipId,
      extensionId: paired.extensionId,
      generation: 1,
      blob: toBase64Url(blob),
      postedAt: new Date().toISOString(),
      leaseUntil: 0,
    });
    const other = world.web();
    const otherView = viewOf(other);
    await other.engine.pull();
    const second = await other.engine.fileClips(otherView.options());
    expect(second).toMatchObject({ filed: [], duplicates: [clipId] });
    expect(world.server.clipQueue.size).toBe(0);
    // the server answers a repeated post with `duplicate` from the note row
    expect(world.server.queueClip({ clipId, extensionId: paired.extensionId, blob })).toBe(
      "duplicate",
    );
    // and two filers at the same moment: the lease gives each clip to one of them
    const racing = [save(world, paired, inboxKey), save(world, paired, inboxKey)];
    const [a, b] = await Promise.all([
      web.engine.fileClips(view.options({ max: 1 })),
      other.engine.fileClips(otherView.options({ max: 1 })),
    ]);
    const filed = [
      ...a.filed,
      ...b.filed,
      ...a.duplicates.map((clipId) => ({ clipId })),
      ...b.duplicates.map((clipId) => ({ clipId })),
    ];
    expect(filed.map((entry) => entry.clipId).sort()).toEqual([...racing].sort());
    const notes = [...world.server.notes.keys()].filter((noteId) =>
      racing.map((id) => clipNoteId(id)).includes(noteId),
    );
    expect(notes).toHaveLength(2);
  });

  it("rejects a forged clip, one from a revoked extension posted after, and one over the limits", async () => {
    const { world, web, view, inboxKey } = await withInbox();
    const paired = pair(world);
    const stranger: Paired = { extensionId: paired.extensionId, keys: createExtensionKeys() };
    const forged = save(world, stranger, inboxKey);
    const unknown = save(
      world,
      { extensionId: newId("ext"), keys: createExtensionKeys() },
      inboxKey,
    );
    const revoked = pair(world, "2026-10-10T10:00:00.000Z");
    const before = save(world, revoked, inboxKey, {}, "2026-10-10T09:59:59.000Z");
    const after = save(world, revoked, inboxKey, {}, "2026-10-10T10:00:01.000Z");
    // a payload the extension's cleaning would refuse, signed and sealed by hand
    const lib = sodium();
    const tooLongId = newId("clip");
    const raw = {
      v: 1 as const,
      clipId: tooLongId,
      workspaceId: world.workspaceId,
      extensionId: paired.extensionId,
      url: "https://example.com/",
      title: "x".repeat(301),
      note: "",
      category: "",
      savedAt: "2026-10-10T09:41:07.512Z",
    };
    const plaintext = signClip(lib, raw, paired.keys.privateKey);
    const inboxPublic = deriveInboxKeyPair(world.key).publicKey;
    world.server.queueClip({
      clipId: tooLongId,
      extensionId: paired.extensionId,
      blob: concatBytes(
        Uint8Array.of(1),
        uint32BE(1),
        lib.crypto_box_seal(lib.pad(plaintext, 1024), inboxPublic),
      ),
    });
    // a sealed clip whose payload names another clip than its queue entry
    const swappedId = newId("clip");
    world.server.queueClip({
      clipId: swappedId,
      extensionId: paired.extensionId,
      blob: fromQueue(world, save(world, paired, inboxKey)),
    });
    const result = await web.engine.fileClips(view.options());
    const reasons = Object.fromEntries(
      result.rejected.map((entry) => [entry.clipId, entry.reason]),
    );
    expect(reasons).toEqual({
      [forged]: "bad_signature",
      [unknown]: "bad_signature",
      [after]: "revoked",
      [tooLongId]: "invalid_clip",
      [swappedId]: "mismatch",
    });
    expect(result.filed.map((entry) => entry.clipId)).toContain(before);
    expect(world.server.clipQueue.size).toBe(0);
  });

  it("writes a title with bidi controls and YAML-breaking characters only as the title", async () => {
    const { world, web, view, inboxKey } = await withInbox();
    const paired = pair(world);
    const clipId = save(world, paired, inboxKey, {
      title: 'Invoice ‮gnp.exe\n---\ntype: Policy\nstatus: "done" # x: [y]',
      note: "---\nstatus: done\n---\nbody",
    });
    await web.engine.fileClips(view.options());
    const note = await web.engine.readNote(clipNoteId(clipId));
    const parsed = parseNote(note.text ?? "");
    expect(parsed.problems).toEqual([]);
    expect(parsed.frontmatter?.data).toEqual({
      title: "Invoice gnp.exe---type: Policystatus: done # x: [y]",
      type: "Clip",
      status: "inbox",
      url: "https://example.com/blog/faster-builds",
      saved: "2026-10-10T09:41:07.512Z",
    });
    expect(parsed.body).toBe("---\nstatus: done\n---\nbody");
  });

  it("files nothing while the inbox folder is gone, and nothing without an inbox", async () => {
    const { world, web, view, inboxKey } = await withInbox();
    const paired = pair(world);
    save(world, paired, inboxKey);
    view.folders.clear();
    expect(await web.engine.fileClips(view.options())).toMatchObject({
      status: "inbox_folder_missing",
      filed: [],
    });
    expect(world.server.claims).toBe(0);
    const bare = new World();
    const bareWeb = bare.web();
    expect((await bareWeb.engine.fileClips(viewOf(bareWeb).options())).status).toBe("no_inbox");
  });

  it("files nothing under an inbox key it doesn't derive itself", async () => {
    const { world, web, view, inboxId } = await withInbox();
    // the owner signed a key that isn't this generation's (a bug, or another key)
    const wrong = toBase64Url(createExtensionKeys().publicKey);
    const signed = signInboxKey(world.signer, {
      workspaceId: world.workspaceId,
      baseRevision: 1,
      generation: 1,
      publicKey: fromBase64Url(wrong),
      folderId: inboxId,
    });
    await web.api.call(routes.putInboxKey, {
      params: { workspaceId: world.workspaceId },
      body: {
        baseRevision: 1,
        generation: 1,
        publicKey: wrong,
        folderId: inboxId,
        signedAt: signed.signedAt,
        signature: signed.signature,
      },
    });
    expect((await web.engine.fileClips(view.options())).status).toBe("inbox_key_mismatch");
  });
});

/** The `clipped` event of a note's timeline. */
async function clippedEntry(client: Client, noteId: NoteId) {
  const timeline = await client.engine.readHistory(noteId);
  for (const entry of timeline.entries) {
    if (entry.kind === "event" && entry.event.event.type === "clipped") return entry.event;
  }
  return undefined;
}

/** A queued clip's sealed bytes, taken out of the queue. */
function fromQueue(world: World, clipId: ClipId): Uint8Array {
  const queued = world.server.clipQueue.get(clipId);
  if (queued === undefined) throw new Error("not queued");
  world.server.clipQueue.delete(clipId);
  return fromBase64Url(queued.blob);
}

describe("filing clips from the CLI", () => {
  it("files where agents write directly, as the agent, and releases what it can't file", async () => {
    const { world, web, view: webView, inboxId, inboxKey } = await withInbox();
    const paired = pair(world);
    const review = await createFolder(world, web, "Later", inboxId);
    await web.engine.setAgentPolicy({
      default: "direct",
      folders: [{ folderId: review, mode: "review" }],
      baseRevision: 0,
    });
    const direct = save(world, paired, inboxKey);
    const asks = save(world, paired, inboxKey, { category: "later" });
    const missing = save(world, paired, inboxKey, { category: "Recipes" });
    const cli = world.cli();
    const view = viewOf(cli);
    await cli.engine.pull();
    const result = await cli.engine.fileClips(view.options());
    expect(result.filed.map((entry) => entry.clipId)).toEqual([direct]);
    expect(
      Object.fromEntries(result.released.map((entry) => [entry.clipId, entry.reason])),
    ).toEqual({
      [asks]: "review",
      [missing]: "new_category",
    });
    expect([...world.server.clipQueue.keys()].sort()).toEqual([asks, missing].sort());
    expect(world.server.clipQueue.get(asks)?.leaseUntil).toBe(0);
    const note = await cli.engine.readNote(clipNoteId(direct));
    expect(note.agentWrite?.tokenId).toBe(world.tokenId);
    expect(note.signedWrite).toBeNull();
    // the agent's clipped record is unsigned, like its `wrote`
    const clipped = await clippedEntry(web, clipNoteId(direct));
    expect(clipped).toMatchObject({ actor: "claude-code/1.0", signature: "unsigned" });
    // the web app files the rest as the person, in every folder mode
    await web.engine.pull();
    const rest = await web.engine.fileClips(
      webView.options({
        createFolder: (name, parentId) => createFolder(world, web, name, parentId),
      }),
    );
    expect(rest.filed.map((entry) => entry.clipId).sort()).toEqual([asks, missing].sort());
  });

  it("releases a clip of a generation it has no copy of", async () => {
    const { world, inboxKey } = await withInbox();
    const paired = pair(world);
    // a clip sealed to generation 2's inbox key, which the agent wasn't given
    const clipId = newId("clip");
    const key2 = deriveInboxKeyPair({ generation: 2, key: new Uint8Array(32).fill(5) });
    const blob = signAndSealClip(
      {
        clipId,
        workspaceId: world.workspaceId,
        extensionId: paired.extensionId,
        url: "https://example.com/",
        savedAt: "2026-10-10T09:41:07.512Z",
      },
      {
        signingSecretKey: paired.keys.privateKey,
        inboxKey: { generation: 2, publicKey: key2.publicKey },
      },
    );
    world.server.queueClip({ clipId, extensionId: paired.extensionId, blob });
    expect(inboxKey.envelope.generation).toBe(1);
    const cli = world.cli();
    const view = viewOf(cli);
    await cli.engine.pull();
    const result = await cli.engine.fileClips(view.options());
    expect(result.released).toEqual([{ clipId, reason: "old_generation" }]);
  });

  it("builds an empty clip's note with no body", () => {
    const text = clipNoteText(normalizeClip({ ...first.payload, note: "" }));
    expect(text).toBe(
      `---\ntitle: How we sped up our build\ntype: Clip\nstatus: inbox\nurl: ${first.payload.url}\nsaved: 2026-10-10T09:41:07.512Z\n---\n`,
    );
  });
});
