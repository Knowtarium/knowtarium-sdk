import { beforeAll, describe, expect, it } from "vitest";

import { newComment, type TimelineEntry, withStatus } from "../../core/history/index.js";
import { parseNote } from "../../core/note/index.js";
import { readProvenance } from "../../core/trust/index.js";
import { ready } from "../../crypto/index.js";
import type { FolderId, NoteId } from "../../protocol/index.js";
import { routes } from "../../protocol/index.js";
import { isVaultError, isVersionPruned, RequestValidationError } from "../errors/index.js";
import { newId } from "../platform/ids.js";
import { type Client, World } from "../testing/world.js";
import {
  encryptCheck,
  encryptEvent,
  prepareFolder,
  signingHeaders,
  signRevocation,
} from "../vault/index.js";

beforeAll(ready);

const at = "2026-09-30T12:00:00Z";
const note = (body: string) =>
  `---\ntitle: Pricing\ngenerated: { by: human:a, at: ${at} }\n---\n${body}\n`;

function describeEntry(entry: TimelineEntry): string {
  switch (entry.kind) {
    case "version":
      return `v${String(entry.version.version)}:${entry.signature}`;
    case "event":
      return `${entry.event.event.type}:${entry.event.signature}`;
    case "comment":
      return `comment:${entry.comment.signature}`;
    case "check":
      return `check:${entry.check.findings?.result ?? "unreadable"}`;
  }
}

/** An agent appends an encrypted event record (unsigned, as agents do). */
async function agentEvent(world: World, cli: Client, noteId: NoteId, record: object) {
  const id = newId("evt");
  const sealed = encryptEvent(world.key, { workspaceId: world.workspaceId, id }, record);
  await cli.api.call(routes.addEvent, {
    params: { workspaceId: world.workspaceId },
    body: { id, noteId, noteVersion: null, ciphertext: sealed.ciphertext },
  });
}

describe("note history", () => {
  it("builds a verified timeline of versions, events, checks and comments", async () => {
    const world = new World();
    const web = world.web();
    const cli = world.cli();
    const noteId: NoteId = newId("note");
    const folderId = world.folderId;
    await web.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 0,
      name: "note.md",
      text: note("v1"),
    });
    await web.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 1,
      name: "note.md",
      text: note("v2"),
    });
    const proposal = await cli.engine.submitPending({
      noteId,
      folderId,
      baseVersion: 2,
      name: "note.md",
      text: note("v3"),
    });
    if (proposal.status !== "submitted") throw new Error("expected a submission");
    await agentEvent(world, cli, noteId, {
      type: "proposed",
      actor: "claude-code/2.1",
      at,
      baseVersion: 2,
      pendingId: proposal.pending.id,
    });
    await web.engine.approvePending(
      proposal.pending,
      { name: "note.md", text: note("v3") },
      { takenNames: [] },
    );
    const checkId = newId("chk");
    await cli.api.call(routes.recordCheck, {
      params: { workspaceId: world.workspaceId },
      body: {
        id: checkId,
        noteId,
        noteVersion: 3,
        ciphertext: encryptCheck(
          world.key,
          { workspaceId: world.workspaceId, id: checkId },
          { actor: "claude-code/2.1", at, result: "pass", scope: [noteId] },
        ).ciphertext,
      },
    });
    const question = await web.engine.addComment(
      noteId,
      newComment({ author: `human:${world.accountId}`, at, noteId, text: "Is $20 right?" }),
    );
    await cli.engine.addComment(
      noteId,
      newComment({ author: "claude-code/2.1", at, noteId, text: "Yes", parent: question.id }),
    );
    const resolved = await web.engine.updateComment(
      question,
      withStatus(question.record ?? newComment({ author: "x", at, noteId, text: "" }), "resolved"),
    );
    expect(resolved).toMatchObject({ revision: 2, signature: "verified" });

    const timeline = await web.engine.readHistory(noteId);
    expect(timeline.entries.map(describeEntry)).toEqual([
      "v1:verified",
      "v2:verified",
      "proposed:unsigned",
      "v3:verified",
      "check:pass",
      // by seq: the question moved after the reply when it was resolved
      "comment:unsigned",
      "comment:verified",
    ]);
    expect(timeline.threads).toMatchObject({ open: 0, resolved: 1 });
    expect(timeline.threads.threads[0]?.replies[0]?.record?.text).toBe("Yes");
    expect(timeline.untrusted).toBe(0);
    expect(timeline.latest?.version).toBe(3);

    // the agent sees the same history (it trusts the owner key it pinned)
    const seenByAgent = await cli.engine.readHistory(noteId);
    expect(seenByAgent.entries.map(describeEntry)).toEqual(timeline.entries.map(describeEntry));
  });

  it("shows an agent's claim to be a person as unconfirmed, and a bad signature as invalid", async () => {
    const world = new World();
    const web = world.web();
    const cli = world.cli();
    const noteId: NoteId = newId("note");
    await web.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 0,
      name: "note.md",
      text: "v1",
    });
    await agentEvent(world, cli, noteId, {
      type: "restored",
      actor: `human:${world.accountId}`,
      at,
      fromVersion: 1,
      version: 1,
    });
    await cli.engine.addComment(
      noteId,
      newComment({ author: `human:${world.accountId}`, at, noteId, text: "I approve" }),
    );
    world.server.tamper.events = (events) =>
      events.map((event) =>
        event.signed === null
          ? event
          : { ...event, signed: { ...event.signed, signature: "A".repeat(86) } },
      );
    const timeline = await web.engine.readHistory(noteId);
    expect(timeline.entries.map(describeEntry)).toEqual([
      "v1:invalid",
      "restored:unconfirmed",
      "comment:unconfirmed",
    ]);
    expect(timeline.untrusted).toBe(3);
  });

  it("keeps both writers' comments when a person and an agent comment at once", async () => {
    const world = new World();
    const web = world.web();
    const cli = world.cli();
    const noteId: NoteId = newId("note");
    await web.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 0,
      name: "note.md",
      text: "v1",
    });
    await Promise.all([
      web.engine.addComment(noteId, newComment({ author: "human:a", at, noteId, text: "one" })),
      cli.engine.addComment(
        noteId,
        newComment({ author: "claude-code/2", at, noteId, text: "two" }),
      ),
    ]);
    const timeline = await web.engine.readHistory(noteId);
    expect(timeline.threads.threads.map((thread) => thread.root.record?.text).sort()).toEqual([
      "one",
      "two",
    ]);
  });
});

describe("restore", () => {
  it("restores an old version as a new signed version with a signed restored event", async () => {
    const world = new World();
    const web = world.web();
    const noteId: NoteId = newId("note");
    await web.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 0,
      name: "note.md",
      text: note("first"),
    });
    await web.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 1,
      name: "note.md",
      text: note("second"),
    });
    const restored = await web.engine.restoreVersion(noteId, 1, { takenNames: [] });
    if (restored.status !== "saved") throw new Error("expected a save");
    expect(restored.note.version).toBe(3);
    const text = restored.note.text ?? "";
    expect(parseNote(text).body).toBe(parseNote(note("first")).body);
    const provenance = readProvenance(parseNote(text).frontmatter?.data ?? {});
    expect(provenance.generated?.by).toBe(`human:${world.accountId}`);

    const timeline = await web.engine.readHistory(noteId);
    expect(timeline.entries.map(describeEntry)).toEqual([
      "v1:verified",
      "v2:verified",
      "v3:verified",
      "restored:verified",
    ]);
    expect(await web.engine.readVersion(noteId, 1)).toMatchObject({
      version: 1,
      text: note("first"),
    });
  });
});

describe("restore without the person's check", () => {
  it("restores with verify false: person-signed, no new verified entry", async () => {
    const world = new World();
    const web = world.web();
    const noteId: NoteId = newId("note");
    for (const [baseVersion, body] of [
      [0, "first"],
      [1, "second"],
    ] as const) {
      await web.engine.writeNote({
        noteId,
        folderId: world.folderId,
        baseVersion,
        name: "note.md",
        text: note(body),
      });
    }
    const restored = await web.engine.restoreVersion(noteId, 1, {
      baseVersion: 2,
      takenNames: [],
      verify: false,
    });
    if (restored.status !== "saved") throw new Error("expected a save");
    const text = restored.note.text ?? "";
    expect(parseNote(text).body).toBe(parseNote(note("first")).body);
    const provenance = readProvenance(parseNote(text).frontmatter?.data ?? {});
    expect(provenance.generated?.by).toBe(`human:${world.accountId}`);
    expect(provenance.verified).toEqual([]);
    expect(restored.note.signedWrite).toMatchObject({ by: world.accountId });

    // a retry after it got through saves nothing twice
    const again = await web.engine.restoreVersion(noteId, 1, {
      baseVersion: 2,
      takenNames: [],
      verify: false,
    });
    expect(again).toMatchObject({ status: "saved", note: { version: 3 } });
    const timeline = await web.engine.readHistory(noteId);
    expect(timeline.entries.map(describeEntry)).toEqual([
      "v1:verified",
      "v2:verified",
      "v3:verified",
      "restored:verified",
    ]);

    // by default the restore still adds the person's verified entry
    const verified = await web.engine.restoreVersion(noteId, 2, { takenNames: [] });
    if (verified.status !== "saved") throw new Error("expected a save");
    const stamped = readProvenance(parseNote(verified.note.text ?? "").frontmatter?.data ?? {});
    expect(stamped.verified.map((entry) => entry.by)).toEqual([`human:${world.accountId}`]);
  });
});

/** A folder the owner creates through the API, so the server knows its place in the tree. */
async function agentsFolder(world: World, web: Client): Promise<FolderId> {
  const request = prepareFolder(world.signer, world.key, {
    workspaceId: world.workspaceId,
    parentId: null,
    name: "Agents",
    rootFolderId: null,
  });
  await web.api.call(routes.createFolder, {
    params: { workspaceId: world.workspaceId },
    body: request,
  });
  return request.id;
}

/** The agent writes directly (it pulls first, so it knows the folder). */
async function agentWrites(
  cli: Client,
  write: { noteId: NoteId; folderId: FolderId; baseVersion: number; text: string },
  summary?: string,
) {
  await cli.engine.pull();
  const result = await cli.engine.writeAsAgent({
    ...write,
    name: "note.md",
    ...(summary === undefined ? {} : { record: { actor: "claude-code/2.1", summary } }),
  });
  if (result.status !== "saved") throw new Error(`expected a save, got ${result.status}`);
  return result;
}

const agentNote = (body: string) =>
  `---\ntitle: Pricing\ngenerated: { by: claude-code/2.1, at: ${at} }\n---\n${body}\n`;

describe("an agent's direct write", () => {
  it("shows in the timeline as a verified agent version, with its wrote record", async () => {
    const world = new World();
    const web = world.web();
    const cli = world.cli();
    const folderId = await agentsFolder(world, web);
    const noteId: NoteId = newId("note");
    await web.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 0,
      name: "note.md",
      text: note("v1"),
    });
    await agentWrites(cli, { noteId, folderId, baseVersion: 1, text: agentNote("v2") }, "Fixed it");

    const timeline = await web.engine.readHistory(noteId);
    expect(timeline.entries.map(describeEntry)).toEqual([
      "v1:verified",
      "v2:verified",
      "wrote:unsigned",
    ]);
    const version = timeline.entries[1];
    if (version?.kind !== "version") throw new Error("expected a version");
    expect(version.version).toMatchObject({ authorId: world.tokenId });
    expect(version.event).toMatchObject({
      event: { type: "agent_edited", version: 2, tokenId: world.tokenId, revision: 0 },
      agent: { tokenId: world.tokenId, revoked: false },
      signature: "verified",
    });
    expect(timeline.entries[2]).toMatchObject({
      event: {
        event: { type: "wrote", version: 2, summary: "Fixed it" },
        authorTokenId: world.tokenId,
      },
    });
    expect(timeline.untrusted).toBe(0);
    // the agent sees the same
    const seenByAgent = await cli.engine.readHistory(noteId);
    expect(seenByAgent.entries.map(describeEntry)).toEqual(timeline.entries.map(describeEntry));
  });

  it("is invalid in the timeline under an unvouched key, and flagged once the agent is revoked", async () => {
    const world = new World();
    const web = world.web();
    const cli = world.cli();
    const folderId = await agentsFolder(world, web);
    const noteId: NoteId = newId("note");
    await agentWrites(cli, { noteId, folderId, baseVersion: 0, text: agentNote("v1") });
    const revocation = signRevocation(world.signer, {
      workspaceId: world.workspaceId,
      tokenId: world.tokenId,
      recipientPublicKey: world.agent.publicKey,
    });
    await web.api.call(routes.revokeToken, {
      params: { tokenId: world.tokenId },
      headers: signingHeaders(revocation),
    });
    const flagged = await world.web().engine.readHistory(noteId);
    expect(flagged.entries[0]).toMatchObject({
      signature: "verified",
      event: { agent: { tokenId: world.tokenId, revoked: true } },
    });
    world.server.agentKeyRecords.length = 0;
    const unvouched = await world.web().engine.readHistory(noteId);
    expect(unvouched.entries.map(describeEntry)).toEqual(["v1:invalid"]);
    expect(unvouched.untrusted).toBe(1);
  });
});

describe("undoing an agent's change", () => {
  it("restores the version before as a new person-signed version with a restored event", async () => {
    const world = new World();
    const web = world.web();
    const cli = world.cli();
    const folderId = await agentsFolder(world, web);
    const noteId: NoteId = newId("note");
    await web.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 0,
      name: "note.md",
      text: note("mine"),
    });
    await agentWrites(cli, { noteId, folderId, baseVersion: 1, text: agentNote("the agent's") });
    await web.engine.pull();

    const undone = await web.engine.undoAgentVersion(noteId, 2, { takenNames: [] });
    if (undone.status !== "saved") throw new Error("expected a save");
    expect(undone.note).toMatchObject({ version: 3, agentWrite: null });
    const text = undone.note.text ?? "";
    expect(parseNote(text).body).toBe(parseNote(note("mine")).body);
    expect(readProvenance(parseNote(text).frontmatter?.data ?? {}).generated?.by).toBe(
      `human:${world.accountId}`,
    );
    expect(undone.note.signedWrite).toMatchObject({ by: world.accountId });
    expect(
      readProvenance(parseNote(text).frontmatter?.data ?? {}).verified.map((entry) => entry.by),
    ).toEqual([`human:${world.accountId}`]);
    const timeline = await web.engine.readHistory(noteId);
    expect(timeline.entries.map(describeEntry)).toEqual([
      "v1:verified",
      "v2:verified",
      "v3:verified",
      "restored:verified",
    ]);
    expect(timeline.entries.at(-1)).toMatchObject({
      event: { event: { type: "restored", fromVersion: 1, version: 3 } },
    });
    // a retry after it got through saves nothing twice
    const again = await web.engine.undoAgentVersion(noteId, 2, { takenNames: [] });
    expect(again).toMatchObject({ status: "saved", note: { version: 3 } });
    expect(world.server.notes.get(noteId)?.versions).toHaveLength(3);
  });

  it("undoes without the person's verified entry with verify false", async () => {
    const world = new World();
    const web = world.web();
    const cli = world.cli();
    const folderId = await agentsFolder(world, web);
    const noteId: NoteId = newId("note");
    await web.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 0,
      name: "note.md",
      text: note("mine"),
    });
    await agentWrites(cli, { noteId, folderId, baseVersion: 1, text: agentNote("the agent's") });
    await web.engine.pull();

    const undone = await web.engine.undoAgentVersion(noteId, 2, { takenNames: [], verify: false });
    if (undone.status !== "saved") throw new Error("expected a save");
    const text = undone.note.text ?? "";
    expect(parseNote(text).body).toBe(parseNote(note("mine")).body);
    const provenance = readProvenance(parseNote(text).frontmatter?.data ?? {});
    expect(provenance.generated?.by).toBe(`human:${world.accountId}`);
    expect(provenance.verified).toEqual([]);
    expect(undone.note.signedWrite).toMatchObject({ by: world.accountId });
    const again = await web.engine.undoAgentVersion(noteId, 2, { takenNames: [], verify: false });
    expect(again).toMatchObject({ status: "saved", note: { version: 3 } });
    expect(world.server.notes.get(noteId)?.versions).toHaveLength(3);
  });

  it("drops the human entries of a version an agent wrote, and keeps a person's", async () => {
    const world = new World();
    const web = world.web();
    const cli = world.cli();
    const folderId = await agentsFolder(world, web);
    const owner = `human:${world.accountId}`;
    const signedAt = new Date().toISOString();
    const withEntries = (body: string) =>
      `---\ntitle: Pricing\ngenerated: { by: "${owner}", at: "${signedAt}" }\nverified:\n  - { by: "${owner}", at: "${signedAt}" }\n  - { by: claude-code/2.1, at: ${at} }\n---\n${body}\n`;
    /** The human entries of a snapshot's text, and those its confirmations back. */
    const humanEntries = (snapshot: {
      text: string | null;
      confirmations: readonly { by: string; at: string }[];
    }) => {
      const entries = readProvenance(parseNote(snapshot.text ?? "").frontmatter?.data ?? {})
        .verified.filter((entry) => entry.kind === "human")
        .map((entry) => `${entry.by} ${entry.at ?? ""}`);
      const backed = new Set(
        snapshot.confirmations.map((write) => `human:${write.by} ${write.at}`),
      );
      return { entries, confirmed: entries.filter((entry) => backed.has(entry)) };
    };
    /** The person's v1 (their entry signed at `signedAt`), then `second`, then the agent's v3. */
    const setup = async (agentSecond: boolean) => {
      const noteId: NoteId = newId("note");
      await web.engine.writeNote({
        noteId,
        folderId,
        baseVersion: 0,
        name: "note.md",
        text: withEntries("$20"),
        signedAt,
      });
      // the agent keeps the person's entry (which v1's signed write confirms) on its own body
      if (agentSecond) {
        await agentWrites(cli, { noteId, folderId, baseVersion: 1, text: withEntries("$2000") });
      } else {
        await web.engine.writeNote({
          noteId,
          folderId,
          baseVersion: 1,
          name: "note.md",
          text: withEntries("$30"),
        });
      }
      await agentWrites(cli, { noteId, folderId, baseVersion: 2, text: agentNote("v3") });
      await web.engine.pull();
      const undone = await web.engine.undoAgentVersion(noteId, 3, {
        takenNames: [],
        verify: false,
      });
      if (undone.status !== "saved") throw new Error("expected a save");
      return undone.note;
    };

    const onAgent = await setup(true);
    expect(parseNote(onAgent.text ?? "").body).toBe(parseNote(withEntries("$2000")).body);
    expect(humanEntries(onAgent)).toEqual({ entries: [], confirmed: [] });
    const kept = readProvenance(parseNote(onAgent.text ?? "").frontmatter?.data ?? {});
    expect(kept.verified.map((entry) => entry.by)).toEqual(["claude-code/2.1"]);
    expect(kept.generated?.by).toBe(owner);

    const onPerson = await setup(false);
    expect(humanEntries(onPerson)).toEqual({
      entries: [`${owner} ${signedAt}`],
      confirmed: [`${owner} ${signedAt}`],
    });
  });

  it("restoring an agent's version drops its human entries, a person's version keeps them", async () => {
    const world = new World();
    const web = world.web();
    const cli = world.cli();
    const folderId = await agentsFolder(world, web);
    const owner = `human:${world.accountId}`;
    const signedAt = new Date().toISOString();
    const withEntries = (body: string) =>
      `---\ntitle: Pricing\ngenerated: { by: "${owner}", at: "${signedAt}" }\nverified:\n  - { by: "${owner}", at: "${signedAt}" }\n  - { by: claude-code/2.1, at: ${at} }\n---\n${body}\n`;
    const verifiedBy = (text: string | null) =>
      readProvenance(parseNote(text ?? "").frontmatter?.data ?? {}).verified.map(
        (entry) => entry.by,
      );
    const noteId: NoteId = newId("note");
    await web.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 0,
      name: "note.md",
      text: withEntries("$20"),
      signedAt,
    });
    // the agent keeps the person's entry (which v1's signed write confirms) on its own body
    await agentWrites(cli, { noteId, folderId, baseVersion: 1, text: withEntries("$2000") });
    await agentWrites(cli, { noteId, folderId, baseVersion: 2, text: agentNote("v3") });
    await web.engine.pull();

    // the caller asks for nothing special: stripping isn't the caller's choice
    const fromAgent = await web.engine.restoreVersion(noteId, 2, { takenNames: [], verify: false });
    if (fromAgent.status !== "saved") throw new Error("expected a save");
    expect(parseNote(fromAgent.note.text ?? "").body).toBe(parseNote(withEntries("$2000")).body);
    expect(verifiedBy(fromAgent.note.text)).toEqual(["claude-code/2.1"]);
    // a retry after it got through saves nothing twice
    const again = await web.engine.restoreVersion(noteId, 2, {
      baseVersion: 3,
      takenNames: [],
      verify: false,
    });
    expect(again).toMatchObject({ status: "saved", note: { version: 4 } });

    const fromPerson = await web.engine.restoreVersion(noteId, 1, {
      takenNames: [],
      verify: false,
    });
    if (fromPerson.status !== "saved") throw new Error("expected a save");
    expect(verifiedBy(fromPerson.note.text)).toEqual([owner, "claude-code/2.1"]);
    expect(fromPerson.note.confirmations).toContainEqual({
      version: 1,
      by: world.accountId,
      at: signedAt,
    });
  });

  it("never adds the person's verified entry onto a version an agent wrote, even with verify true", async () => {
    const world = new World();
    const web = world.web();
    const cli = world.cli();
    const folderId = await agentsFolder(world, web);
    const noteId: NoteId = newId("note");
    await web.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 0,
      name: "note.md",
      text: note("mine"),
    });
    await agentWrites(cli, { noteId, folderId, baseVersion: 1, text: agentNote("first") });
    await agentWrites(cli, { noteId, folderId, baseVersion: 2, text: agentNote("second") });
    await web.engine.pull();

    const undone = await web.engine.undoAgentVersion(noteId, 3, { takenNames: [], verify: true });
    if (undone.status !== "saved") throw new Error("expected a save");
    const text = undone.note.text ?? "";
    expect(parseNote(text).body).toBe(parseNote(agentNote("first")).body);
    expect(readProvenance(parseNote(text).frontmatter?.data ?? {}).verified).toEqual([]);
    expect(undone.note.signedWrite).toMatchObject({ by: world.accountId });
    // a retry after it got through saves nothing twice
    const again = await web.engine.undoAgentVersion(noteId, 3, { takenNames: [], verify: true });
    expect(again).toMatchObject({ status: "saved", note: { version: 4 } });
    expect(world.server.notes.get(noteId)?.versions).toHaveLength(4);
  });

  it("looks past an applied check to who wrote the version an undo brings back", async () => {
    const world = new World();
    const web = world.web();
    const cli = world.cli();
    const folderId = await agentsFolder(world, web);
    const verifiedBy = (text: string) =>
      readProvenance(parseNote(text).frontmatter?.data ?? {}).verified.map((entry) => entry.by);
    /** The person's v1, `second` (a person's or an agent's), a check applied on it, the agent's. */
    const setup = async (agentSecond: boolean) => {
      const noteId: NoteId = newId("note");
      await web.engine.writeNote({
        noteId,
        folderId,
        baseVersion: 0,
        name: "note.md",
        text: note("v1"),
      });
      if (agentSecond) {
        await agentWrites(cli, { noteId, folderId, baseVersion: 1, text: agentNote("v2") });
        await web.engine.pull();
      } else {
        await web.engine.writeNote({
          noteId,
          folderId,
          baseVersion: 1,
          name: "note.md",
          text: note("v2"),
        });
      }
      const checkId = newId("chk");
      await cli.api.call(routes.recordCheck, {
        params: { workspaceId: world.workspaceId },
        body: {
          id: checkId,
          noteId,
          noteVersion: 2,
          ciphertext: encryptCheck(
            world.key,
            { workspaceId: world.workspaceId, id: checkId },
            { actor: "claude-code/2.1", at, result: "pass", scope: [] },
          ).ciphertext,
        },
      });
      const applied = await web.engine.writeNote({
        noteId,
        folderId,
        baseVersion: 2,
        name: "note.md",
        text: note("v2, checked"),
        checkId,
      });
      if (applied.status !== "saved") throw new Error("expected the check applied");
      await agentWrites(cli, { noteId, folderId, baseVersion: 3, text: agentNote("v4") });
      return noteId;
    };

    // a fresh device, which learns the earlier versions' events when it undoes
    const onAgent = await setup(true);
    const undoneAgent = await world
      .web()
      .engine.undoAgentVersion(onAgent, 4, { takenNames: [], verify: true });
    if (undoneAgent.status !== "saved") throw new Error("expected a save");
    expect(verifiedBy(undoneAgent.note.text ?? "")).toEqual([]);

    const onPerson = await setup(false);
    const undonePerson = await world
      .web()
      .engine.undoAgentVersion(onPerson, 4, { takenNames: [], verify: true });
    if (undonePerson.status !== "saved") throw new Error("expected a save");
    expect(verifiedBy(undonePerson.note.text ?? "")).toEqual([`human:${world.accountId}`]);
  });

  it("returns a conflict when the note moved past the agent's version", async () => {
    const world = new World();
    const web = world.web();
    const cli = world.cli();
    const folderId = await agentsFolder(world, web);
    const noteId: NoteId = newId("note");
    await web.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 0,
      name: "note.md",
      text: note("v1"),
    });
    await agentWrites(cli, { noteId, folderId, baseVersion: 1, text: agentNote("v2") });
    await web.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 2,
      name: "note.md",
      text: note("v3"),
    });
    const result = await web.engine.undoAgentVersion(noteId, 2, { takenNames: [] });
    expect(result).toMatchObject({
      status: "conflict",
      mine: { baseVersion: 2 },
      theirs: { version: 3, text: note("v3") },
    });
    expect(world.server.notes.get(noteId)?.versions).toHaveLength(3);
  });

  it("deletes a note the agent created, signed by the person", async () => {
    const world = new World();
    const web = world.web();
    const cli = world.cli();
    const folderId = await agentsFolder(world, web);
    const noteId: NoteId = newId("note");
    await agentWrites(cli, { noteId, folderId, baseVersion: 0, text: agentNote("new") });
    const undone = await web.engine.undoAgentVersion(noteId, 1, { takenNames: [] });
    expect(undone).toMatchObject({ status: "saved", note: { version: 2, text: null } });
    const deleted = world.server.events.find((event) => event.noteVersion === 2)?.signed;
    expect(deleted?.envelope).toMatchObject({ type: "deleted", accountId: world.accountId });
    const timeline = await web.engine.readHistory(noteId);
    expect(timeline.entries.map(describeEntry)).toEqual(["v1:verified", "v2:verified"]);
    // retried: the delete already stands
    expect(await web.engine.undoAgentVersion(noteId, 1, { takenNames: [] })).toMatchObject({
      status: "saved",
      note: { version: 2, text: null },
    });
  });

  it("refuses to undo into a delete or a restore the versions list made up", async () => {
    const world = new World();
    const web = world.web();
    const cli = world.cli();
    const folderId = await agentsFolder(world, web);
    const noteId: NoteId = newId("note");
    await web.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 0,
      name: "note.md",
      text: note("v1"),
    });
    await agentWrites(cli, { noteId, folderId, baseVersion: 1, text: agentNote("v2") });
    const undo = () =>
      web.engine.undoAgentVersion(noteId, 2, { takenNames: [] }).catch((error: unknown) => error);
    // version 1 flipped to a delete marker: no signed delete backs it
    world.server.tamper.versions = (versions) =>
      versions.map((entry) => (entry.version === 1 ? { ...entry, deleted: true } : entry));
    expect(isVaultError(await undo(), "untrusted_signature")).toBe(true);
    // version 1 left out
    world.server.tamper.versions = (versions) => versions.filter((entry) => entry.version !== 1);
    expect(isVaultError(await undo(), "untrusted_signature")).toBe(true);
    // its bytes swapped: the signature doesn't cover them
    delete world.server.tamper.versions;
    world.server.tamper.versionBlob = (id, version, blob) =>
      id === noteId && version === 1
        ? blob.map((byte, i) => (i === blob.length - 1 ? byte ^ 1 : byte))
        : blob;
    expect(isVaultError(await undo())).toBe(true);
    expect(world.server.notes.get(noteId)?.versions).toHaveLength(2);
    delete world.server.tamper.versionBlob;
    expect(await undo()).toMatchObject({ status: "saved", note: { version: 3 } });
  });

  it("moves the note back when the agent moved it", async () => {
    const world = new World();
    const web = world.web();
    const cli = world.cli();
    const home = await agentsFolder(world, web);
    const request = prepareFolder(world.signer, world.key, {
      workspaceId: world.workspaceId,
      parentId: null,
      name: "Elsewhere",
      rootFolderId: null,
    });
    await web.api.call(routes.createFolder, {
      params: { workspaceId: world.workspaceId },
      body: request,
    });
    const elsewhere = request.id;
    const noteId: NoteId = newId("note");
    await web.engine.writeNote({
      noteId,
      folderId: home,
      baseVersion: 0,
      name: "note.md",
      text: note("v1"),
    });
    await agentWrites(cli, { noteId, folderId: elsewhere, baseVersion: 1, text: agentNote("v2") });
    const asked: string[] = [];
    const undone = await web.engine.undoAgentVersion(noteId, 2, {
      takenNames: (folderId) => {
        asked.push(folderId);
        return ["note.md"];
      },
    });
    expect(asked).toEqual([home]);
    expect(undone).toMatchObject({ status: "saved", note: { version: 3, folderId: home } });
    // a name taken in that folder meanwhile isn't reused
    expect(undone.status === "saved" ? undone.note.name : null).not.toBe("note.md");
    expect(world.server.notes.get(noteId)?.folderId).toBe(home);
  });

  it.each([
    { home: "review", elsewhere: "direct", stamped: true },
    { home: "direct", elsewhere: "review", stamped: false },
  ] as const)(
    "asks verify about the folder the undo writes to ($home there, $elsewhere now)",
    async ({ home: homeMode, stamped }) => {
      const world = new World();
      const web = world.web();
      const cli = world.cli();
      const home = await agentsFolder(world, web);
      const request = prepareFolder(world.signer, world.key, {
        workspaceId: world.workspaceId,
        parentId: null,
        name: "Elsewhere",
        rootFolderId: null,
      });
      await web.api.call(routes.createFolder, {
        params: { workspaceId: world.workspaceId },
        body: request,
      });
      const elsewhere = request.id;
      const reviewed = homeMode === "review" ? home : elsewhere;
      const noteId: NoteId = newId("note");
      await web.engine.writeNote({
        noteId,
        folderId: home,
        baseVersion: 0,
        name: "note.md",
        text: note("v1"),
      });
      await agentWrites(cli, {
        noteId,
        folderId: elsewhere,
        baseVersion: 1,
        text: agentNote("v2"),
      });
      const asked: string[] = [];
      const options = {
        takenNames: [],
        verify: (folderId: FolderId) => {
          asked.push(folderId);
          return folderId === reviewed;
        },
      };
      const undone = await web.engine.undoAgentVersion(noteId, 2, options);
      if (undone.status !== "saved") throw new Error("expected a save");
      expect(undone.note).toMatchObject({ version: 3, folderId: home });
      expect(asked).toEqual([home]);
      const provenance = readProvenance(parseNote(undone.note.text ?? "").frontmatter?.data ?? {});
      expect(provenance.generated?.by).toBe(`human:${world.accountId}`);
      expect(provenance.verified.map((entry) => entry.by)).toEqual(
        stamped ? [`human:${world.accountId}`] : [],
      );
      expect(undone.note.signedWrite).toMatchObject({ by: world.accountId });

      // a retry finds the stored undo and its signed event: nothing asked or saved twice
      const again = await web.engine.undoAgentVersion(noteId, 2, options);
      expect(again).toMatchObject({ status: "saved", note: { version: 3 } });
      expect(asked).toEqual([home]);
      expect(world.server.notes.get(noteId)?.versions).toHaveLength(3);
      const timeline = await web.engine.readHistory(noteId);
      expect(timeline.entries.map(describeEntry)).toEqual([
        "v1:verified",
        "v2:verified",
        "v3:verified",
        "restored:verified",
      ]);
    },
  );

  it("only undoes an agent's version, and only for a person", async () => {
    const world = new World();
    const web = world.web();
    const cli = world.cli();
    const folderId = await agentsFolder(world, web);
    const noteId: NoteId = newId("note");
    await web.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 0,
      name: "note.md",
      text: note("v1"),
    });
    await expect(web.engine.undoAgentVersion(noteId, 1, { takenNames: [] })).rejects.toBeInstanceOf(
      RequestValidationError,
    );
    await expect(cli.engine.undoAgentVersion(noteId, 1, { takenNames: [] })).rejects.toBeInstanceOf(
      RequestValidationError,
    );
  });
});

describe("conflict merge", () => {
  it("merges a 409's two sides with the base version", async () => {
    const world = new World();
    const laptop = world.web();
    const phone = world.web();
    const noteId: NoteId = newId("note");
    const folderId = world.folderId;
    const base = note("Line one\nLine two\nLine three");
    await laptop.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 0,
      name: "note.md",
      text: base,
    });
    await laptop.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 1,
      name: "note.md",
      text: base.replace("Line one", "Line ONE"),
    });
    const mine = base.replace("Line three", "Line THREE");
    const result = await phone.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 1,
      name: "note.md",
      text: mine,
    });
    if (result.status !== "conflict") throw new Error("expected a conflict");
    const merge = await phone.engine.mergeConflict(result, { takenNames: [] });
    expect(merge.text).toBe(note("Line ONE\nLine two\nLine THREE"));
    const saved = await phone.engine.writeNote({
      noteId,
      folderId,
      baseVersion: result.theirs.version,
      name: "note.md",
      text: merge.text ?? "",
    });
    expect(saved).toMatchObject({ status: "saved", note: { version: 3 } });
  });
});

describe("review fixes", () => {
  it("signs a restore at the time its verified entry names, and retries without saving twice", async () => {
    const world = new World();
    const web = world.web();
    const noteId: NoteId = newId("note");
    const folderId = world.folderId;
    await web.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 0,
      name: "note.md",
      text: note("first"),
    });
    await web.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 1,
      name: "note.md",
      text: note("second"),
    });
    const first = await web.engine.restoreVersion(noteId, 1, { baseVersion: 2, takenNames: [] });
    if (first.status !== "saved") throw new Error("expected a save");
    const provenance = readProvenance(parseNote(first.note.text ?? "").frontmatter?.data ?? {});
    const write = world.server.events.find(
      (event) => event.noteVersion === 3 && event.ciphertext === null,
    );
    expect(provenance.verified.at(-1)?.at).toBe(write?.signed?.envelope.createdAt);

    // the same restore again (a retry after a lost answer): nothing is saved twice
    const again = await web.engine.restoreVersion(noteId, 1, { baseVersion: 2, takenNames: [] });
    expect(again).toMatchObject({ status: "saved", note: { version: 3 } });
    const timeline = await web.engine.readHistory(noteId);
    expect(timeline.entries.map(describeEntry)).toEqual([
      "v1:verified",
      "v2:verified",
      "v3:verified",
      "restored:verified",
    ]);
  });

  it("refuses a write event that carries a record or names another version", async () => {
    const world = new World();
    const web = world.web();
    const noteId: NoteId = newId("note");
    await web.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 0,
      name: "note.md",
      text: "v1",
    });
    await web.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 1,
      name: "note.md",
      text: "v2",
    });
    world.server.tamper.events = (events) =>
      events.map((event) =>
        event.noteVersion === 1
          ? { ...event, ciphertext: "A".repeat(80) }
          : { ...event, noteVersion: 7 },
      );
    const timeline = await web.engine.readHistory(noteId);
    expect(timeline.entries.map(describeEntry)).toEqual(["v1:invalid", "v2:invalid"]);
  });

  it("refuses a comment signed by one person but naming another, or anchored elsewhere", async () => {
    const world = new World();
    const web = world.web();
    const noteId: NoteId = newId("note");
    const otherNote: NoteId = newId("note");
    await web.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 0,
      name: "note.md",
      text: "v1",
    });
    const impostor = await web.engine.addComment(
      noteId,
      newComment({ author: "human:someone-else", at, noteId, text: "not me" }),
    );
    expect(impostor.signature).toBe("invalid");
    const elsewhere = await web.engine.addComment(
      noteId,
      newComment({ author: `human:${world.accountId}`, at, noteId: otherNote, text: "moved" }),
    );
    expect(elsewhere.signature).toBe("invalid");
  });
});

describe("file names through history", () => {
  it("renames as a write, restores the old name, reviews a proposed rename and merges names", async () => {
    const world = new World();
    const web = world.web();
    const cli = world.cli();
    const noteId: NoteId = newId("note");
    const folderId = world.folderId;
    await web.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 0,
      name: "pricing.md",
      text: note("v1"),
    });
    const renamed = await web.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 1,
      name: "prices.md",
      text: note("v1"),
    });
    expect(renamed).toMatchObject({ status: "saved", note: { version: 2, name: "prices.md" } });
    expect((await cli.engine.readVersion(noteId, 1)).name).toBe("pricing.md");

    // another note took the old name meanwhile: the restore picks a free one
    const clash = await web.engine.restoreVersion(noteId, 1, { takenNames: ["Pricing.md"] });
    expect(clash).toMatchObject({ status: "saved", note: { version: 3 } });
    if (clash.status !== "saved") throw new Error("expected a save");
    expect(clash.note.name).toMatch(/^pricing \(.+\)\.md$/);
    const restored = await web.engine.restoreVersion(noteId, 1, { takenNames: [] });
    expect(restored).toMatchObject({ status: "saved", note: { version: 4, name: "pricing.md" } });

    const proposal = await cli.engine.submitPending({
      noteId,
      folderId,
      baseVersion: 4,
      name: "pricing-2026.md",
      text: note("v4"),
    });
    if (proposal.status !== "submitted") throw new Error("expected a submission");
    const review = await web.engine.readPending(proposal.pending.id);
    expect(review.proposedName).toBe("pricing-2026.md");
    expect(review.base?.name).toBe("pricing.md");

    const approved = await web.engine.approvePending(
      proposal.pending,
      { name: "pricing-2026.md", text: note("v5") },
      { takenNames: ["pricing-2026.md"] },
    );
    if (approved.status !== "approved") throw new Error("expected an approval");
    expect(approved.note.name).toMatch(/^pricing-2026 \(.+\)\.md$/);

    // a 409: the other side renamed, this side only edited the text
    await web.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 5,
      name: "tarifs.md",
      text: note("v5"),
    });
    const conflict = await web.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 5,
      name: approved.note.name ?? "",
      text: note("edited"),
    });
    if (conflict.status !== "conflict") throw new Error("expected a conflict");
    expect((await web.engine.mergeConflict(conflict, { takenNames: [] })).name).toBe("tarifs.md");
  });
});

describe("undo and restore next to the history cleanup", () => {
  /** Drops the current version's content as a lying server would (the cleanup never does). */
  function pruneCurrent(world: World, noteId: NoteId): void {
    const current = world.server.notes.get(noteId)?.versions.at(-1);
    if (current === undefined) throw new Error("no such note");
    current.blob = null;
    current.prunedAt = "2026-10-31T00:00:00.000Z";
  }

  /** A person's v1 under an agent's direct v2, in a folder where agents write directly. */
  async function agentOnTop(world: World) {
    const web = world.web();
    const cli = world.cli();
    const folderId = await agentsFolder(world, web);
    const noteId: NoteId = newId("note");
    await web.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 0,
      name: "note.md",
      text: note("mine"),
    });
    await agentWrites(cli, { noteId, folderId, baseVersion: 1, text: agentNote("the agent's") });
    await web.engine.pull();
    return { web, folderId, noteId };
  }

  it("quarantines an undo whose agent version the server says was removed while current", async () => {
    const world = new World();
    const { web, noteId } = await agentOnTop(world);
    pruneCurrent(world, noteId);
    const error = await web.engine
      .undoAgentVersion(noteId, 2, { takenNames: [] })
      .catch((caught: unknown) => caught);
    expect(isVaultError(error, "version_mismatch")).toBe(true);
    expect(isVersionPruned(error)).toBe(false);
    expect(world.server.notes.get(noteId)?.versions).toHaveLength(2);
  });

  it("quarantines a restore whose moved-on current version the server says was removed", async () => {
    const world = new World();
    const web = world.web();
    const noteId: NoteId = newId("note");
    for (const [index, body] of ["first", "second", "third"].entries()) {
      await web.engine.writeNote({
        noteId,
        folderId: world.folderId,
        baseVersion: index,
        name: "note.md",
        text: note(body),
      });
    }
    pruneCurrent(world, noteId);
    const error = await web.engine
      .restoreVersion(noteId, 1, { baseVersion: 2, takenNames: [] })
      .catch((caught: unknown) => caught);
    expect(isVaultError(error, "version_mismatch")).toBe(true);
    expect(isVersionPruned(error)).toBe(false);
    expect(world.server.notes.get(noteId)?.versions).toHaveLength(3);
  });

  it("answers a retried undo as saved once it got through, though the versions before were removed since", async () => {
    const world = new World();
    const { web, noteId } = await agentOnTop(world);
    const first = await web.engine.undoAgentVersion(noteId, 2, { takenNames: [] });
    expect(first).toMatchObject({ status: "saved", note: { version: 3 } });
    // the answer was lost; meanwhile the cleanup removed what nothing protects any more
    world.server.pruneVersion(noteId, 1);
    world.server.pruneVersion(noteId, 2);

    const again = await web.engine.undoAgentVersion(noteId, 2, { takenNames: [] });
    expect(again).toMatchObject({
      status: "saved",
      note: { version: 3, text: first.status === "saved" ? first.note.text : "" },
    });
    expect(world.server.notes.get(noteId)?.versions).toHaveLength(3);
    const restored = world.server.events.filter(
      (event) => event.noteVersion === 3 && event.ciphertext !== null,
    );
    expect(restored).toHaveLength(1);
  });

  it("still quarantines a retried undo whose current version the server says was removed", async () => {
    const world = new World();
    const { web, noteId } = await agentOnTop(world);
    await web.engine.undoAgentVersion(noteId, 2, { takenNames: [] });
    pruneCurrent(world, noteId);
    const error = await web.engine
      .undoAgentVersion(noteId, 2, { takenNames: [] })
      .catch((caught: unknown) => caught);
    expect(isVaultError(error, "version_mismatch")).toBe(true);
  });

  it("keeps a removed agent version a pruned error once a person's write replaced it", async () => {
    const world = new World();
    const { web, folderId, noteId } = await agentOnTop(world);
    await web.engine.writeNote({
      noteId,
      folderId,
      baseVersion: 2,
      name: "note.md",
      text: note("later"),
    });
    world.server.pruneVersion(noteId, 2);
    const error = await web.engine
      .undoAgentVersion(noteId, 2, { takenNames: [] })
      .catch((caught: unknown) => caught);
    expect(isVersionPruned(error)).toBe(true);
    expect(world.server.notes.get(noteId)?.versions).toHaveLength(3);
  });
});
