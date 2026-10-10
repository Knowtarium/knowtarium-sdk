import { beforeAll, describe, expect, it } from "vitest";

import { signClip } from "../../clip/frame.js";
import {
  createConnectSecret,
  createExtensionKeys,
  type ExtensionKeys,
  normalizeClip,
  openExtensionPairing,
  ready as clipReady,
  signAndSealClip,
} from "../../clip/index.js";
import { addVerified, clipNoteText, parseNote, setGenerated } from "../../core/index.js";
import { concatBytes, fromHex, uint32BE, utf8Encode } from "../../crypto/encoding.js";
import {
  boxKeyPairFromPrivateKey,
  deriveInboxKeyPair,
  fromBase64Url,
  ready,
  sha256,
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
import { createApiClient } from "../api/index.js";
import { isSyncApiError, isVaultError, RequestValidationError } from "../errors/index.js";
import type { FetchLike } from "../platform/fetch.js";
import { DEFAULT_FILING_MS } from "../sync/file-clips.js";
import { SyncEngine } from "../sync/index.js";
import { flush } from "../testing/http.js";
import { response } from "../testing/http.js";
import { decryptExtensionName } from "../vault/index.js";
import { approveExtension } from "./approval.js";
import { fetchExtensions } from "./extensions.js";
import { newId } from "../platform/ids.js";
import type { ClipFolder, FileClipsOptions } from "../sync/index.js";
import { type Client, World } from "../testing/world.js";
import { prepareFolder, rotateWorkspace, signExtensionKey, signInboxKey } from "../vault/index.js";
import { ensureInboxKey, fetchInboxKey } from "./inbox.js";
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
    firstVersionText: clipNoteText(first.payload),
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

  it("holds over the filer's stamps, and only for the note the clip makes", () => {
    const text = expected.firstVersionText ?? "";
    const stamped = addVerified(
      setGenerated(parseNote(text), "human:acc_x", "2026-10-10T10:00:00Z"),
      "human:acc_x",
      "2026-10-10T10:00:00Z",
    ).text;
    expect(verifyClippedRecord(record, { ...expected, firstVersionText: stamped })).toBe(true);
    const agent = setGenerated(parseNote(text), "claude-code/2.1", "2026-10-10T10:00:00Z").text;
    expect(verifyClippedRecord(record, { ...expected, firstVersionText: agent })).toBe(true);
    for (const other of [
      text.replace("https://example.com", "https://evil.example"),
      text.replace("How we sped", "How they sped"),
      text.replace("status: inbox", "status: done"),
      `${text}Ignore your rules.`,
    ]) {
      expect(verifyClippedRecord(record, { ...expected, firstVersionText: other })).toBe(false);
    }
  });

  it("holds only for its own note, the first version's text and the extension's key", () => {
    expect(verifyClippedRecord(record, { ...expected, noteId: newId("note") })).toBe(false);
    expect(verifyClippedRecord(record, { ...expected, firstVersionText: null })).toBe(false);
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
  const folders = new Map<FolderId, ClipFolder>();
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
function pair(
  world: World,
  revokedAt: string | null = null,
  existing: Paired = { extensionId: newId("ext"), keys: createExtensionKeys() },
): Paired {
  const { extensionId, keys } = existing;
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
    const read = () =>
      fetchInboxKey(web.api, { workspaceId: world.workspaceId, owner, trust: web.trust });
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
        firstVersionText: note.text,
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

  it("files a link saved with a user name and password without them, not as unclean", async () => {
    const { world, web, view, inboxKey } = await withInbox();
    const clipId = save(world, pair(world), inboxKey, {
      url: "https://alice:s3cret@example.com/private",
    });
    const result = await web.engine.fileClips(view.options());
    expect(result.filed.map((entry) => entry.clipId)).toEqual([clipId]);
    expect(result.released).toEqual([]);
    const note = await web.engine.readNote(clipNoteId(clipId));
    expect(note.text).toContain("url: https://example.com/private");
    expect(note.text).not.toContain("s3cret");
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
      [after]: "revoked",
      [tooLongId]: "invalid_clip",
      [swappedId]: "mismatch",
    });
    expect(result.filed.map((entry) => entry.clipId)).toContain(before);
    // no vouched key to check it against: it waits, released, instead of being thrown away
    expect(result.released).toEqual([{ clipId: unknown, reason: "unknown_extension" }]);
    expect([...world.server.clipQueue.keys()]).toEqual([unknown]);
    expect(world.server.clipQueue.get(unknown)?.leaseUntil).toBe(0);
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

  it("releases a clip of an older generation it has no copy of", async () => {
    const { world, web, view: webView, inboxKey } = await withInbox();
    const paired = pair(world);
    await rotateWorkspace(web.api, {
      workspaceId: world.workspaceId,
      signer: world.signer,
      ownerBoxPublicKey: world.account.encryption.publicKey,
      keys: web.keys,
      trust: web.trust,
    });
    expect(world.server.inboxKey?.envelope.generation).toBe(2);
    // an agent connected after the rotation holds generation 2 only
    world.server.agentKeys = world.server.agentKeys.filter((record) => record.keyGeneration === 2);
    // the extension still sealed this one to generation 1
    const old = save(world, paired, inboxKey);
    const current = save(world, paired, world.server.inboxKey ?? inboxKey);
    const cli = world.cli();
    const view = viewOf(cli);
    await cli.engine.pull();
    // the folder names are generation 1's: the web app's view knows them
    const result = await cli.engine.fileClips(view.options({ folders: webView.folders }));
    expect(result.status).toBe("done");
    const reasons = new Map(result.released.map((entry) => [entry.clipId, entry.reason]));
    expect(reasons.get(old)).toBe("old_generation");
    // the clip sealed to generation 2 opens (its folder isn't one this agent's feed could read)
    expect(reasons.get(current)).not.toBe("old_generation");
    expect(result.rejected).toEqual([]);
  });

  it("builds an empty clip's note with no body", () => {
    const text = clipNoteText(normalizeClip({ ...first.payload, note: "" }));
    expect(text).toBe(
      `---\ntitle: How we sped up our build\ntype: Clip\nstatus: inbox\nurl: ${first.payload.url}\nsaved: 2026-10-10T09:41:07.512Z\n---\n`,
    );
  });
});

describe("filing passes", () => {
  it("files the clips behind more unfilable ones than one claim takes", async () => {
    const { world, inboxKey } = await withInbox();
    const paired = pair(world);
    // three clips for a category agents can't create, then one they can file
    const stuck = [1, 2, 3].map((second) =>
      save(
        world,
        paired,
        inboxKey,
        { category: "Missing" },
        `2026-10-10T09:00:0${String(second)}.000Z`,
      ),
    );
    const filable = save(world, paired, inboxKey, {}, "2026-10-10T09:00:09.000Z");
    const cli = world.cli();
    const view = viewOf(cli);
    await cli.engine.pull();
    const result = await cli.engine.fileClips(view.options({ max: 2 }));
    expect(result.filed.map((entry) => entry.clipId)).toEqual([filable]);
    expect(result.released.map((entry) => entry.clipId).sort()).toEqual([...stuck].sort());
    // held until the pass ended, then released together, free for the web app
    expect([...world.server.releasedClips].sort()).toEqual([...stuck].sort());
    for (const clipId of stuck) expect(world.server.clipQueue.get(clipId)?.leaseUntil).toBe(0);
  });

  it("treats a 409 on the create as filed, without reading the other note", async () => {
    const { world, web, view, inboxKey } = await withInbox();
    const paired = pair(world);
    const clipId = save(world, paired, inboxKey);
    await web.engine.fileClips(view.options());
    const blob = fromBase64Url(world.server.clipQueue.get(clipId)?.blob ?? "");
    expect(blob).toHaveLength(0);
    // posted again (a lost ack, say) to a client that hasn't synced the note
    requeue(world, clipId, paired, inboxKey);
    const fresh = world.web();
    const reads = () =>
      world.server.requests.filter(
        (call) => call.init.method === "GET" && call.url.includes(clipNoteId(clipId)),
      ).length;
    const before = reads();
    const result = await fresh.engine.fileClips(view.options());
    expect(result).toMatchObject({ filed: [], duplicates: [clipId] });
    expect(reads()).toBe(before);
  });

  it("acks a clip whose note this client knows, deleted too, without writing", async () => {
    const { world, web, view, inboxKey } = await withInbox();
    const paired = pair(world);
    const clipId = save(world, paired, inboxKey);
    await web.engine.fileClips(view.options());
    const noteId = clipNoteId(clipId);
    const note = await web.engine.readNote(noteId);
    await web.engine.deleteNote({ noteId, baseVersion: note.version });
    requeue(world, clipId, paired, inboxKey);
    const writes = () =>
      world.server.requests.filter(
        (call) => call.init.method === "PUT" && call.url.includes(noteId),
      ).length;
    const before = writes();
    const result = await web.engine.fileClips(view.options());
    expect(result).toMatchObject({ filed: [], duplicates: [clipId] });
    expect(writes()).toBe(before);
    expect(world.server.clipQueue.size).toBe(0);
  });

  it("stops at its deadline, releasing the clips it didn't get to", async () => {
    const { world, web, view, inboxKey } = await withInbox();
    const paired = pair(world);
    const ids = [1, 2, 3].map((second) =>
      save(world, paired, inboxKey, {}, `2026-10-10T09:00:0${String(second)}.000Z`),
    );
    let clock = 1_000;
    const result = await web.engine.fileClips(
      view.options({ deadline: 1_250, now: () => (clock += 100) }),
    );
    expect(result.filed.map((entry) => entry.clipId)).toEqual([ids[0]]);
    expect(result.released).toEqual([
      { clipId: ids[1], reason: "time_limit" },
      { clipId: ids[2], reason: "time_limit" },
    ]);
    const [, second] = ids;
    if (second === undefined) throw new Error("no clip");
    expect(world.server.clipQueue.get(second)?.leaseUntil).toBe(0);
  });

  it("tells the per-minute limit from the daily cap", async () => {
    const { world, inboxKey } = await withInbox();
    const paired = pair(world);
    const clipId = save(world, paired, inboxKey);
    world.server.agentWriteDailyCap = 0;
    world.server.agentWriteRetryAfterSeconds = 30;
    const cli = world.cli({ retry: { maxAttempts: 1 } });
    const view = viewOf(cli);
    await cli.engine.pull();
    expect((await cli.engine.fileClips(view.options())).released).toEqual([
      { clipId, reason: "rate_limited" },
    ]);
    world.server.agentWriteRetryAfterSeconds = 3600;
    expect((await cli.engine.fileClips(view.options())).released).toEqual([
      { clipId, reason: "daily_cap" },
    ]);
  });

  it("lets the person's writes through while a pass is under way", async () => {
    const { world, web, view, inboxKey } = await withInbox();
    save(world, pair(world), inboxKey);
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    world.server.tamper.hold = (route) => (route === "listExtensions" ? gate : undefined);
    const pass = web.engine.fileClips(view.options());
    const written = await web.engine.writeNote({
      noteId: newId("note"),
      folderId: world.folderId,
      baseVersion: 0,
      name: "During.md",
      text: "---\ntype: Note\ntitle: During\n---\n",
    });
    expect(written.status).toBe("saved");
    delete world.server.tamper.hold;
    open();
    expect((await pass).filed).toHaveLength(1);
  });

  it("refuses to claim without the owner's account ID", async () => {
    const { world, inboxKey } = await withInbox();
    save(world, pair(world), inboxKey);
    const cli = world.cli();
    const engine = new SyncEngine({
      api: cli.api,
      workspaceId: world.workspaceId,
      keys: cli.keys,
      trust: cli.trust,
      verifier: { publicKey: world.account.signing.publicKey },
    });
    const error = await engine.fileClips(viewOf(cli).options()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RequestValidationError);
    expect(world.server.claims).toBe(0);
  });
});

describe("filing passes, continued", () => {
  it("reads the extensions again for one paired after the pass read them", async () => {
    const { world, web, view, inboxKey } = await withInbox();
    const late: Paired = { extensionId: newId("ext"), keys: createExtensionKeys() };
    const clipId = save(world, late, inboxKey);
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    world.server.tamper.hold = (route) => (route === "listExtensions" ? gate : undefined);
    const pass = web.engine.fileClips(view.options());
    const listed = () => world.server.requests.some((call) => call.url.endsWith("/extensions"));
    for (let i = 0; i < 50 && !listed(); i++) await flush();
    // the pass read the list without it; the extension pairs now
    pair(world, null, late);
    delete world.server.tamper.hold;
    open();
    const result = await pass;
    expect(result.filed.map((entry) => entry.clipId)).toEqual([clipId]);
    expect(result.released).toEqual([]);
  });

  it("stops after 30 seconds when the caller sets no deadline", async () => {
    const { world, web, view, inboxKey } = await withInbox();
    const paired = pair(world);
    const ids = [1, 2].map((second) =>
      save(world, paired, inboxKey, {}, `2026-10-10T09:00:0${String(second)}.000Z`),
    );
    let clock = 0;
    const result = await web.engine.fileClips(
      view.options({
        now: () => clock,
        // each clip's note takes just over the default time
        stamp: (text) => {
          clock += DEFAULT_FILING_MS + 1;
          return text;
        },
      }),
    );
    expect(DEFAULT_FILING_MS).toBe(30_000);
    expect(result.filed.map((entry) => entry.clipId)).toEqual([ids[0]]);
    expect(result.released).toEqual([{ clipId: ids[1], reason: "time_limit" }]);
  });

  it("releases the rest of the batch at once after a rate limit", async () => {
    const { world, inboxKey } = await withInbox();
    const paired = pair(world);
    const ids = [1, 2, 3].map((second) =>
      save(world, paired, inboxKey, {}, `2026-10-10T09:00:0${String(second)}.000Z`),
    );
    world.server.agentWriteDailyCap = 0;
    world.server.agentWriteRetryAfterSeconds = 30;
    const cli = world.cli({ retry: { maxAttempts: 1 } });
    const view = viewOf(cli);
    await cli.engine.pull();
    const writes = () =>
      world.server.requests.filter((call) => call.url.endsWith("/agent-version")).length;
    const before = writes();
    const result = await cli.engine.fileClips(view.options());
    expect(writes() - before).toBe(1);
    expect(result.released).toEqual(ids.map((clipId) => ({ clipId, reason: "rate_limited" })));
    expect(world.server.claims).toBe(1);
  });

  it("files the clips behind one whose write fails, and stops when every write fails", async () => {
    const { world, web, view, inboxKey } = await withInbox();
    const paired = pair(world);
    const [failing, behind] = [1, 2].map((second) =>
      save(world, paired, inboxKey, {}, `2026-10-10T09:00:0${String(second)}.000Z`),
    );
    let writes = 0;
    world.server.tamper.refuse = (route) =>
      route === "writeNote" && writes++ === 0 ? "internal" : undefined;
    const result = await web.engine.fileClips(view.options());
    expect(result.released).toEqual([{ clipId: failing, reason: "failed" }]);
    expect(result.filed.map((entry) => entry.clipId)).toEqual([behind]);
    // the next pass files it
    expect((await web.engine.fileClips(view.options())).filed.map((e) => e.clipId)).toEqual([
      failing,
    ]);
    const more = [3, 4, 5, 6].map((second) =>
      save(world, paired, inboxKey, {}, `2026-10-10T09:00:0${String(second)}.000Z`),
    );
    world.server.tamper.refuse = (route) => (route === "writeNote" ? "internal" : undefined);
    const error = await web.engine.fileClips(view.options()).catch((caught: unknown) => caught);
    expect(isSyncApiError(error, "internal")).toBe(true);
    for (const clipId of more) expect(world.server.clipQueue.get(clipId)?.leaseUntil).toBe(0);
    delete world.server.tamper.refuse;
  });

  it("leaves waiting a signed clip this runtime would clean differently", async () => {
    const { world, web, view } = await withInbox();
    const paired = pair(world);
    const clipId = newId("clip");
    const lib = sodium();
    const raw = {
      v: 1 as const,
      clipId,
      workspaceId: world.workspaceId,
      extensionId: paired.extensionId,
      url: "https://example.com/",
      title: "Invoice \u202egnp.exe",
      note: "",
      category: "",
      savedAt: "2026-10-10T09:41:07.512Z",
    };
    const plaintext = signClip(lib, raw, paired.keys.privateKey);
    const inboxPublic = deriveInboxKeyPair(world.key).publicKey;
    world.server.queueClip({
      clipId,
      extensionId: paired.extensionId,
      blob: concatBytes(
        Uint8Array.of(1),
        uint32BE(1),
        lib.crypto_box_seal(lib.pad(plaintext, 1024), inboxPublic),
      ),
    });
    const result = await web.engine.fileClips(view.options());
    expect(result).toMatchObject({ filed: [], rejected: [] });
    expect(result.released).toEqual([{ clipId, reason: "unclean_clip" }]);
    expect(world.server.clipQueue.has(clipId)).toBe(true);
  });

  it("doesn't let a slow server hold up a rotation for the inbox key", async () => {
    const { world, web } = await withInbox();
    world.server.tamper.hold = (route) =>
      route === "getInboxKey" ? new Promise<void>(() => undefined) : undefined;
    const rotated = await rotateWorkspace(web.api, {
      workspaceId: world.workspaceId,
      signer: world.signer,
      ownerBoxPublicKey: world.account.encryption.publicKey,
      keys: web.keys,
      trust: web.trust,
      inboxKeyWaitMs: 20,
    });
    expect(rotated.generation).toBe(2);
    delete world.server.tamper.hold;
  });
});

describe("the inbox key's rollback marks and echo", () => {
  it("refuses an older inbox key revision, or none, once it verified a newer one", async () => {
    const { world, web } = await withInbox();
    const again = await createFolder(world, web, "Inbox 2");
    await web.engine.ensureInboxKey({ folderId: again });
    const owner = { publicKey: world.account.signing.publicKey, accountId: world.accountId };
    const read = () =>
      fetchInboxKey(web.api, { workspaceId: world.workspaceId, owner, trust: web.trust });
    expect((await read())?.envelope.revision).toBe(2);
    const newer = world.server.inboxKeys.pop();
    const older = await read().catch((caught: unknown) => caught);
    expect(isVaultError(older, "rollback")).toBe(true);
    world.server.inboxKeys.length = 0;
    const none = await read().catch((caught: unknown) => caught);
    expect(isVaultError(none, "rollback")).toBe(true);
    if (newer !== undefined) world.server.inboxKeys.push(newer);
  });

  it("returns the inbox key it signed, and refuses a server that stored another", async () => {
    const world = new World();
    const web = world.web();
    const inboxId = await createFolder(world, web, "Inbox");
    const other = await createFolder(world, web, "Elsewhere");
    let tamper = false;
    const fetch: FetchLike = async (url, init) => {
      const answer = await world.server.fetch(url, init);
      const stored = world.server.inboxKey;
      if (!tamper || init.method !== "PUT" || stored === null) return answer;
      return response(200, {
        inboxKey: { ...stored, envelope: { ...stored.envelope, folderId: inboxId } },
      });
    };
    const api = createApiClient({ baseUrl: "https://api.test", fetch, auth: { kind: "session" } });
    const flow = {
      workspaceId: world.workspaceId,
      signer: world.signer,
      keys: web.keys,
      trust: web.trust,
    };
    const signed = await ensureInboxKey(api, flow, { folderId: inboxId });
    expect(signed.status).toBe("signed");
    expect(signed.inboxKey?.envelope.folderId).toBe(inboxId);
    expect(signed.inboxKey?.signature).toBe(world.server.inboxKey?.signature);
    tamper = true;
    const refused = await ensureInboxKey(api, flow, { folderId: other }).catch(
      (caught: unknown) => caught,
    );
    expect(isVaultError(refused, "untrusted_signature")).toBe(true);
  });
});

describe("approving an extension", () => {
  it("registers it with the owner's key and relays a payload only it opens", async () => {
    const { world, web, inboxKey } = await withInbox();
    const { data: started } = await web.api.call(routes.startConnect, {
      body: { client: "extension", extensionVersion: "0.1.0" },
    });
    const keys = createExtensionKeys();
    const secret = createConnectSecret();
    const { extension } = await approveExtension(
      web.api,
      { signer: world.signer, keys: web.keys },
      {
        requestId: started.requestId,
        workspaceId: world.workspaceId,
        signPublicKey: keys.publicKey,
        secret,
        name: "Chrome on macOS",
        workspaceName: "Clients",
        inboxKey,
        categories: ["Reading"],
      },
    );
    expect(extension.signPublicKey).toBe(toBase64Url(keys.publicKey));
    const keyring = await web.keys.get();
    expect(
      decryptExtensionName(
        keyring,
        { workspaceId: world.workspaceId, extensionId: extension.extensionId },
        extension.encName,
      ),
    ).toBe("Chrome on macOS");
    const { data: polled } = await web.api.call(routes.pollConnect, {
      params: { requestId: started.requestId },
      body: { pollSecret: started.pollSecret },
    });
    if (polled.status !== "relayed") throw new Error(polled.status);
    const pairing = openExtensionPairing(fromBase64Url(polled.encRelayPayload), {
      secret,
      signPublicKey: keys.publicKey,
    });
    expect(pairing).toMatchObject({
      extensionId: extension.extensionId,
      accountId: world.accountId,
      workspaceName: "Clients",
      categories: ["Reading"],
    });
    expect(world.server.extensionTokenHashes.get(extension.extensionId)).toBe(
      toBase64Url(sha256(utf8Encode(pairing.token))),
    );
    // the filer trusts the key the approval vouched for
    const verified = await fetchExtensions(web.api, {
      workspaceId: world.workspaceId,
      owner: { publicKey: world.account.signing.publicKey, accountId: world.accountId },
    });
    expect(verified.has(extension.extensionId)).toBe(true);
  });
});

/** Puts a filed clip back in the queue, as a repeated post or a lost ack would. */
function requeue(world: World, clipId: ClipId, paired: Paired, inboxKey: SignedInboxKey): void {
  const blob = signAndSealClip(
    {
      clipId,
      workspaceId: world.workspaceId,
      extensionId: paired.extensionId,
      url: "https://example.com/blog/faster-builds",
      title: "How we sped up our build",
      note: "Read before the CI meeting.",
      savedAt: "2026-10-10T09:41:07.512Z",
    },
    { signingSecretKey: paired.keys.privateKey, inboxKey: inboxKey.envelope },
  );
  world.server.clipQueue.set(clipId, {
    clipId,
    extensionId: paired.extensionId,
    generation: inboxKey.envelope.generation,
    blob: toBase64Url(blob),
    postedAt: new Date().toISOString(),
    leaseUntil: 0,
  });
}
