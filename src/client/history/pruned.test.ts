import { beforeAll, describe, expect, it } from "vitest";

import { utf8Decode } from "../../crypto/encoding.js";
import { ready } from "../../crypto/index.js";
import { type FolderId, historyFreedAt, type NoteId, routes } from "../../protocol/index.js";
import {
  isVaultError,
  isVersionPruned,
  RequestValidationError,
  SyncApiError,
  VersionPrunedError,
} from "../errors/index.js";
import { newId } from "../platform/ids.js";
import { readHistoryRetention } from "../sync/index.js";
import { type Client, World } from "../testing/world.js";
import { prepareFolder } from "../vault/index.js";

beforeAll(ready);

const at = "2026-09-30T12:00:00Z";
const note = (body: string) =>
  `---\ntitle: Pricing\ngenerated: { by: human:a, at: ${at} }\n---\n${body}\n`;

/** Writes `bodies` as versions 1, 2, ... of a new note. */
async function writeVersions(world: World, client: Client, bodies: readonly string[]) {
  const noteId: NoteId = newId("note");
  for (const [index, body] of bodies.entries()) {
    await client.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: index,
      name: "note.md",
      text: note(body),
    });
  }
  return noteId;
}

describe("a version removed after the history period", () => {
  it("reads as a typed pruned error, not a failure to retry", async () => {
    const world = new World();
    const web = world.web();
    const noteId = await writeVersions(world, web, ["first", "second"]);
    world.server.pruneVersion(noteId, 1);

    const error = await web.engine.readVersion(noteId, 1).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VersionPrunedError);
    expect(isVersionPruned(error)).toBe(true);
    expect(error).toMatchObject({ noteId, version: 1 });
    expect(error).not.toBeInstanceOf(SyncApiError);
    // the current version still reads, and the agent reads it too
    expect(await web.engine.readVersion(noteId, 2)).toMatchObject({ text: note("second") });
    expect(await world.cli().engine.readNote(noteId)).toMatchObject({ text: note("second") });
  });

  it("can't be restored: the restore fails with the same error and saves nothing", async () => {
    const world = new World();
    const web = world.web();
    const noteId = await writeVersions(world, web, ["first", "second"]);
    world.server.pruneVersion(noteId, 1);
    const error = await web.engine
      .restoreVersion(noteId, 1, { takenNames: [] })
      .catch((caught: unknown) => caught);
    expect(isVersionPruned(error)).toBe(true);
    expect(await web.engine.readNote(noteId)).toMatchObject({ version: 2 });
  });

  it("stays in the timeline with its author, time and verified signed event", async () => {
    const world = new World();
    const web = world.web();
    const noteId = await writeVersions(world, web, ["first", "second", "third"]);
    world.server.pruneVersion(noteId, 1, "2026-10-31T00:00:00.000Z");
    world.server.pruneVersion(noteId, 2, "2026-10-31T00:00:00.000Z");

    const timeline = await web.engine.readHistory(noteId);
    const versions = timeline.entries.filter((entry) => entry.kind === "version");
    expect(versions.map((entry) => [entry.version.version, entry.pruned, entry.signature])).toEqual(
      [
        [1, true, "verified"],
        [2, true, "verified"],
        [3, false, "verified"],
      ],
    );
    expect(versions[0]?.version).toMatchObject({
      authorId: world.accountId,
      prunedAt: "2026-10-31T00:00:00.000Z",
    });
    expect(versions[0]?.event?.event).toMatchObject({ type: "edited", version: 1 });
    expect(timeline).toMatchObject({ pruned: 2, untrusted: 0 });
  });
});

describe("a conflict whose base was removed", () => {
  it("merges two-way, showing every difference for the person to choose", async () => {
    const world = new World();
    const laptop = world.web();
    const phone = world.web();
    const base = "Line one\nLine two\nLine three";
    const noteId = await writeVersions(world, laptop, [base]);
    await laptop.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 1,
      name: "note.md",
      text: note(base.replace("Line one", "Line ONE")),
    });
    // the phone's edit started from version 1, superseded long enough ago to be removed
    world.server.pruneVersion(noteId, 1);
    const conflict = await phone.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 1,
      name: "note.md",
      text: note(base.replace("Line three", "Line THREE")),
    });
    if (conflict.status !== "conflict") throw new Error("expected a conflict");

    const merge = await phone.engine.mergeConflict(conflict, { takenNames: [] });
    expect(merge.basePruned).toBe(true);
    // without the base, neither side's change can be taken for granted
    expect(merge.text).toBeNull();
    expect(merge.conflicts.length).toBeGreaterThan(0);
    const sides = merge.conflicts
      .map((hunk) => `${String(hunk.mine)}|${String(hunk.theirs)}`)
      .join("\n");
    expect(sides).toContain("Line THREE");
    expect(sides).toContain("Line ONE");
    expect(merge.name).toBe("note.md");
  });

  it("takes no frontmatter field or name one side lacks for granted, since either side may have changed it", async () => {
    const world = new World();
    const laptop = world.web();
    const phone = world.web();
    const withFields = (fields: string, body: string) =>
      `---\ntitle: Pricing\n${fields}generated: { by: human:a, at: ${at} }\n---\n${body}\n`;
    const noteId = await writeVersions(world, laptop, []);
    await laptop.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 0,
      name: "note.md",
      text: withFields("status: draft\n", "Same body"),
    });
    // the laptop removes `status` and renames the note; the phone, from version 1, adds `tags`
    await laptop.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 1,
      name: "pricing.md",
      text: withFields("", "Same body"),
    });
    world.server.pruneVersion(noteId, 1);
    const conflict = await phone.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 1,
      name: "note.md",
      text: withFields("status: draft\ntags: [x]\n", "Same body"),
    });
    if (conflict.status !== "conflict") throw new Error("expected a conflict");

    const merge = await phone.engine.mergeConflict(conflict, { takenNames: [] });
    expect(merge.basePruned).toBe(true);
    // a three-way merge against nothing would quietly keep `status` and add `tags`
    expect(merge.text).toBeNull();
    expect(merge.conflicts.map((hunk) => [hunk.field, hunk.base, hunk.mine, hunk.theirs])).toEqual([
      ["status", null, "status: draft\n", null],
      ["tags", null, "tags: [x]\n", null],
    ]);
    expect(merge.nameConflict).toEqual({ mine: "note.md", theirs: "pricing.md" });
    expect(merge.name).toBe("pricing.md");
  });

  it("merges three-way as before when the base is still there", async () => {
    const world = new World();
    const laptop = world.web();
    const phone = world.web();
    const base = "Line one\nLine two\nLine three";
    const noteId = await writeVersions(world, laptop, [base]);
    await laptop.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 1,
      name: "note.md",
      text: note(base.replace("Line one", "Line ONE")),
    });
    const conflict = await phone.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 1,
      name: "note.md",
      text: note(base.replace("Line three", "Line THREE")),
    });
    if (conflict.status !== "conflict") throw new Error("expected a conflict");
    const merge = await phone.engine.mergeConflict(conflict, { takenNames: [] });
    expect(merge).toMatchObject({
      basePruned: false,
      text: note("Line ONE\nLine two\nLine THREE"),
    });
  });

  it("still fails on any other error reading the base", async () => {
    const world = new World();
    const laptop = world.web();
    const phone = world.web();
    const noteId = await writeVersions(world, laptop, ["one", "two"]);
    const conflict = await phone.engine.writeNote({
      noteId,
      folderId: world.folderId,
      baseVersion: 1,
      name: "note.md",
      text: note("mine"),
    });
    if (conflict.status !== "conflict") throw new Error("expected a conflict");
    world.server.tamper.refuse = (route) => (route === "getVersion" ? "unavailable" : undefined);
    const error = await phone.engine
      .mergeConflict(conflict, { takenNames: [] })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SyncApiError);
    expect(isVersionPruned(error)).toBe(false);
  });
});

describe("a pull that meets a removed version", () => {
  it("reads the note's current version instead of stopping", async () => {
    const world = new World();
    const web = world.web();
    const noteId = await writeVersions(world, web, ["first", "second"]);
    world.server.pruneVersion(noteId, 1);
    // a feed page that still names version 1 (read before version 2 replaced it)
    world.server.tamper.changesPage = (page) => ({
      ...page,
      changes: page.changes.map((change) =>
        change.kind === "note" && change.noteId === noteId ? { ...change, version: 1 } : change,
      ),
    });
    const cli = world.cli();
    const seen: number[] = [];
    cli.engine.on("note", (event) => {
      if (event.note.noteId === noteId) seen.push(event.note.version);
    });
    await cli.engine.pull();
    expect(seen).toEqual([2]);
    expect(await cli.engine.readNote(noteId)).toMatchObject({ version: 2, text: note("second") });
  });
});

describe("a server that says a version was removed when it can't have been", () => {
  /** Drops the current version's content as a lying server would (the cleanup never does). */
  function pruneCurrent(world: World, noteId: NoteId): void {
    const current = world.server.notes.get(noteId)?.versions.at(-1);
    if (current === undefined) throw new Error("no such note");
    current.blob = null;
    current.prunedAt = "2026-10-31T00:00:00.000Z";
  }

  it("quarantines the note instead of skipping its newest version", async () => {
    const world = new World();
    const web = world.web();
    const noteId = await writeVersions(world, web, ["first", "second"]);
    pruneCurrent(world, noteId);
    const cli = world.cli();
    const seen: number[] = [];
    cli.engine.on("note", (event) => {
      if (event.note.noteId === noteId) seen.push(event.note.version);
    });
    await cli.engine.pull();
    expect(seen).toEqual([]);
    expect(cli.engine.quarantined).toEqual([{ noteId, version: 2, reason: "version_mismatch" }]);
  });

  it("refuses to read a note's current version as removed", async () => {
    const world = new World();
    const web = world.web();
    const noteId = await writeVersions(world, web, ["first"]);
    pruneCurrent(world, noteId);
    const error = await web.engine.readNote(noteId).catch((caught: unknown) => caught);
    expect(isVaultError(error, "version_mismatch")).toBe(true);
    expect(isVersionPruned(error)).toBe(false);
  });

  it("is believed in the timeline only for a superseded version with content", async () => {
    const world = new World();
    const web = world.web();
    const noteId = await writeVersions(world, web, ["first", "second"]);
    world.server.tamper.versions = (versions) =>
      versions.map((entry) => ({ ...entry, pruned: true, prunedAt: "2026-10-31T00:00:00.000Z" }));
    const timeline = await web.engine.readHistory(noteId);
    const versions = timeline.entries.filter((entry) => entry.kind === "version");
    expect(versions.map((entry) => [entry.version.version, entry.pruned])).toEqual([
      [1, true],
      [2, false],
    ]);
    expect(timeline.pruned).toBe(1);
  });
});

describe("the history setting", () => {
  it("is read and set by the owner, and a shorter period removes older versions at once", async () => {
    const world = new World();
    const web = world.web();
    const noteId = await writeVersions(world, web, ["first", "second", "third"]);
    const before = await web.engine.readHistorySettings();
    expect(before).toMatchObject({ retentionDays: 30, lastCleanupAt: null });
    // versions 1 and 2 were superseded just now: the youngest bucket
    expect(before.breakdown.buckets[0]).toMatchObject({ minAgeDays: 0, versions: 2 });
    expect(historyFreedAt(before.breakdown, 1)).toEqual({ versions: 0, bytes: 0 });

    const saved = await web.engine.setHistorySettings(7);
    expect(saved).toMatchObject({ retentionDays: 7, freed: { versions: 0, bytes: 0 } });
    const put = world.server.requests.findLast(
      (call) => call.init.method === "PUT" && call.url.endsWith("/history-settings"),
    );
    const body = put?.init.body;
    expect(
      JSON.parse(typeof body === "string" ? body : utf8Decode(body ?? new Uint8Array())),
    ).toEqual({
      retentionDays: 7,
    });
    expect(await web.engine.readHistorySettings()).toMatchObject({ retentionDays: 7 });
    expect(await web.engine.readVersion(noteId, 1)).toMatchObject({ version: 1 });
  });

  it("is read-only for an agent: the period alone, and no settings", async () => {
    const world = new World();
    const cli = world.cli();
    const sentBefore = () =>
      world.server.requests.filter((call) => call.url.includes("/history-settings")).length;
    world.server.historyRetentionDays = 90;
    expect(await cli.engine.readHistoryRetention()).toBe(90);
    expect(await readHistoryRetention({ api: cli.api, workspaceId: world.workspaceId })).toBe(90);
    for (const call of [
      () => cli.engine.readHistorySettings(),
      () => cli.engine.setHistorySettings(1),
    ]) {
      // the client refuses a session route on an agent token before anything is sent
      const error = await call().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RequestValidationError);
      expect(error).toMatchObject({ part: "auth" });
    }
    expect(sentBefore()).toBe(0);
    expect(world.server.historyRetentionDays).toBe(90);
  });

  it("is unknown (null) on a server that doesn't answer it", async () => {
    const world = new World();
    const cli = world.cli();
    world.server.tamper.refuse = (route) =>
      route === "getHistoryRetention" ? "not_found" : undefined;
    expect(await cli.engine.readHistoryRetention()).toBeNull();
  });
});

describe("the fake server's history cleanup, as the sync API runs it", () => {
  const DAY = 86_400_000;

  /** Makes version `version` of a note superseded `days` ago (when its next version came). */
  function supersededDaysAgo(world: World, noteId: NoteId, version: number, days: number): void {
    const next = world.server.notes.get(noteId)?.versions.find((v) => v.version === version + 1);
    if (next === undefined) throw new Error("no next version");
    Object.assign(next, { createdAt: new Date(Date.now() - days * DAY).toISOString() });
  }

  const stored = (world: World, noteId: NoteId) =>
    world.server.notes.get(noteId)?.versions.map((entry) => [entry.version, entry.blob !== null]);

  /** A folder where agents write directly. */
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

  it("refuses a period that isn't one of the steps", async () => {
    const world = new World();
    const web = world.web();
    await web.engine.setHistorySettings(30);
    const put = world.server.requests.findLast((call) => call.init.method === "PUT");
    if (put === undefined) throw new Error("no request");
    for (const retentionDays of [2, 0, 31, 30.5, "30"]) {
      const answer = await world.server.fetch(put.url, {
        ...put.init,
        body: JSON.stringify({ retentionDays }),
      });
      expect(answer.status, String(retentionDays)).toBe(400);
    }
    expect(world.server.historyRetentionDays).toBe(30);
  });

  it("cleans up only when the period gets shorter, and records every pass", async () => {
    const world = new World();
    const web = world.web();
    const noteId = await writeVersions(world, web, ["first", "second"]);
    supersededDaysAgo(world, noteId, 1, 100);

    // longer or the same: no pass, nothing removed
    for (const days of [90, 365, 365] as const) {
      expect(await web.engine.setHistorySettings(days)).toMatchObject({
        freed: { versions: 0, bytes: 0 },
        more: false,
      });
    }
    expect(world.server.historyCleanupAt).toBeNull();
    expect(stored(world, noteId)).toEqual([
      [1, true],
      [2, true],
    ]);
    // shorter but nothing old enough: a pass all the same
    await web.engine.setHistorySettings(180);
    expect(world.server.historyCleanupAt).not.toBeNull();
    expect((await web.engine.readHistorySettings()).lastCleanupAt).toBe(
      world.server.historyCleanupAt,
    );
    expect(stored(world, noteId)).toEqual([
      [1, true],
      [2, true],
    ]);
    const saved = await web.engine.setHistorySettings(90);
    expect(saved).toMatchObject({ retentionDays: 90, freed: { versions: 1 }, more: false });
    expect(stored(world, noteId)).toEqual([
      [1, false],
      [2, true],
    ]);
  });

  it("removes a version superseded exactly the period ago, not one a little younger", async () => {
    const world = new World();
    const web = world.web();
    const old = await writeVersions(world, web, ["first", "second"]);
    const young = await writeVersions(world, web, ["first", "second"]);
    // a minute of slack for the time the test takes
    supersededDaysAgo(world, old, 1, 7 + 1 / 1440);
    supersededDaysAgo(world, young, 1, 7 - 1 / 1440);
    const before = await web.engine.readHistorySettings();
    expect(historyFreedAt(before.breakdown, 7)).toMatchObject({ versions: 1 });
    expect(await web.engine.setHistorySettings(7)).toMatchObject({ freed: { versions: 1 } });
    expect(stored(world, old)?.[0]).toEqual([1, false]);
    expect(stored(world, young)?.[0]).toEqual([1, true]);
  });

  it("never removes current versions, delete markers, an open proposal's base or what undo brings back", async () => {
    const world = new World();
    const web = world.web();
    const cli = world.cli();
    // a deleted note brought back: its delete marker is superseded too
    const deleted = await writeVersions(world, web, ["first"]);
    await web.engine.deleteNote({ noteId: deleted, baseVersion: 1 });
    await web.engine.writeNote({
      noteId: deleted,
      folderId: world.folderId,
      baseVersion: 2,
      name: "note.md",
      text: note("back"),
    });
    // an open proposal on version 2
    const proposed = await writeVersions(world, web, ["first", "second"]);
    await cli.engine.pull();
    const proposal = await cli.engine.submitPending({
      noteId: proposed,
      folderId: world.folderId,
      baseVersion: 2,
      name: "note.md",
      text: note("proposed"),
    });
    expect(proposal.status).toBe("submitted");
    // the person writes on, so the proposal's base is superseded (the proposal stays open)
    await web.engine.writeNote({
      noteId: proposed,
      folderId: world.folderId,
      baseVersion: 2,
      name: "note.md",
      text: note("third"),
    });
    // an agent's direct write on top of version 1
    const folderId = await agentsFolder(world, web);
    const agentNote: NoteId = newId("note");
    await web.engine.writeNote({
      noteId: agentNote,
      folderId,
      baseVersion: 0,
      name: "note.md",
      text: note("mine"),
    });
    await cli.engine.pull();
    const written = await cli.engine.writeAsAgent({
      noteId: agentNote,
      folderId,
      baseVersion: 1,
      name: "note.md",
      text: `---
title: Pricing
generated: { by: claude-code/2.1, at: ${at} }
---
agent
`,
    });
    expect(written.status).toBe("saved");
    for (const noteId of [deleted, proposed, agentNote]) {
      const versions = world.server.notes.get(noteId)?.versions ?? [];
      for (const entry of versions.slice(0, -1))
        supersededDaysAgo(world, noteId, entry.version, 400);
    }

    const before = await web.engine.readHistorySettings();
    // the proposal's base (proposed v2) and the version under the agent's write
    expect(before.breakdown.protected).toMatchObject({ versions: 2 });
    const saved = await web.engine.setHistorySettings(1);
    expect(saved.freed).toEqual(historyFreedAt(before.breakdown, 1));
    expect(saved.freed.versions).toBe(2);
    expect(stored(world, deleted)).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
    expect(world.server.notes.get(deleted)?.versions[1]).toMatchObject({
      deleted: true,
      prunedAt: null,
    });
    expect(stored(world, proposed)).toEqual([
      [1, false],
      [2, true],
      [3, true],
    ]);
    expect(stored(world, agentNote)).toEqual([
      [1, true],
      [2, true],
    ]);
  });
});
