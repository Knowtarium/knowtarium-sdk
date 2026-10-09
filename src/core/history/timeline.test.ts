import { describe, expect, it } from "vitest";

import { buildThreads, type CommentEntry, newComment, withStatus } from "./comments.js";
import { readHistoryEvent } from "./events.js";
import { buildTimeline, type HistoryEventEntry, lastFullyVerifiedVersion } from "./timeline.js";

const at = (minute: number) => `2026-09-30T12:${String(minute).padStart(2, "0")}:00.000Z`;

function event(
  id: string,
  seq: number,
  minute: number,
  source: Parameters<typeof readHistoryEvent>[0],
): HistoryEventEntry {
  const read = readHistoryEvent(source);
  return {
    id,
    seq,
    createdAt: at(minute),
    authorId: source.authorIsPerson ? "acc_1" : "tok_1",
    authorTokenId: source.authorIsPerson ? null : "tok_1",
    noteVersion: null,
    ...read,
  };
}

function comment(
  id: string,
  minute: number,
  record: CommentEntry["record"],
  signature: CommentEntry["signature"] = "verified",
): CommentEntry {
  return {
    id,
    noteId: "note_1",
    authorId: "acc_1",
    authorTokenId: null,
    createdAt: at(minute),
    updatedAt: at(minute),
    revision: 1,
    seq: minute,
    record,
    signature,
  };
}

describe("history events", () => {
  it("types every event kind and says how far to trust it", () => {
    const signed = (fields: object) =>
      readHistoryEvent({ signed: fields as never, signatureValid: true, authorIsPerson: true });
    expect(signed({ type: "edited", version: 2, folderId: "fld_1" })).toEqual({
      event: { type: "edited", version: 2, folderId: "fld_1" },
      signature: "verified",
    });
    expect(signed({ type: "deleted", version: 3 }).event).toEqual({ type: "deleted", version: 3 });
    expect(signed({ type: "approved", version: 4, pendingId: "pc_1" }).event).toEqual({
      type: "approved",
      version: 4,
      pendingId: "pc_1",
    });
    expect(signed({ type: "rejected", pendingId: "pc_2", commentId: "cmt_1" }).event).toEqual({
      type: "rejected",
      pendingId: "pc_2",
      commentId: "cmt_1",
    });

    const agent = (record: unknown) =>
      readHistoryEvent({ signed: null, signatureValid: false, record, authorIsPerson: false });
    const proposed = agent({
      type: "proposed",
      actor: "claude-code/2.1",
      at: at(1),
      baseVersion: 3,
    });
    expect(proposed).toMatchObject({
      event: { type: "proposed", baseVersion: 3 },
      actor: "claude-code/2.1",
      signature: "unsigned",
    });
    const checked = agent({
      type: "checked",
      actor: "claude-code/2.1",
      at: at(2),
      version: 3,
      result: "fail",
      scope: ["note_2"],
      conflicts: [{ noteId: "note_2", detail: "different price" }],
    });
    expect(checked.event).toMatchObject({
      type: "checked",
      result: "fail",
      conflicts: [{ noteId: "note_2" }],
    });

    // an agent's record claiming to be a person's is unconfirmed
    expect(
      agent({ type: "restored", actor: "human:a", at: at(3), fromVersion: 1, version: 5 }),
    ).toMatchObject({ event: { type: "restored" }, signature: "unconfirmed" });
    // a bad signature is invalid, a record that doesn't fit is unreadable
    expect(
      readHistoryEvent({
        signed: { type: "edited", version: 1 },
        signatureValid: false,
        authorIsPerson: true,
      }),
    ).toMatchObject({ signature: "invalid" });
    expect(agent({ type: "gossip" }).event).toEqual({ type: "unreadable" });
  });
});

describe("comment threads", () => {
  it("threads replies, counts open and resolved, and spots conflict flags", () => {
    const root = newComment({
      author: "human:a",
      at: at(1),
      noteId: "note_1",
      text: "Check the price",
    });
    const reply = newComment({
      author: "claude-code/2.1",
      at: at(2),
      noteId: "note_1",
      text: "Fixed",
      parent: "cmt_1",
    });
    const nested = newComment({
      author: "human:a",
      at: at(3),
      noteId: "note_1",
      text: "Thanks",
      parent: "cmt_2",
    });
    const conflict = {
      ...newComment({
        author: "claude-code/2.1",
        at: at(4),
        noteId: "note_1",
        text: "Disagrees with Q3",
      }),
      kind: "conflict" as const,
      conflictsWith: ["note_9"],
    };
    const threads = buildThreads([
      comment("cmt_3", 3, nested),
      comment("cmt_1", 1, withStatus(root, "resolved")),
      comment("cmt_2", 2, reply, "unsigned"),
      comment("cmt_4", 4, conflict, "unsigned"),
      comment("cmt_5", 5, { ...root, parent: "cmt_missing" }),
    ]);
    expect(threads.threads.map((thread) => thread.root.id)).toEqual(["cmt_1", "cmt_4", "cmt_5"]);
    expect(threads.threads[0]?.replies.map((entry) => entry.id)).toEqual(["cmt_2", "cmt_3"]);
    expect(threads).toMatchObject({ open: 2, resolved: 1, openConflicts: 1 });
  });
});

describe("timeline", () => {
  it("keeps versions whose content was removed after the history period, with their metadata", () => {
    const versions = [1, 2, 3].map((version) => ({
      version,
      authorId: version === 2 ? "tok_1" : "acc_1",
      createdAt: at(version * 10),
      deleted: false,
      fromPendingId: null,
      pruned: version < 3,
      prunedAt: version < 3 ? at(50) : null,
    }));
    const events = [1, 3].map((version) =>
      event(`evt_${String(version)}`, version * 10, version * 10, {
        signed: { type: "edited", version },
        signatureValid: true,
        authorIsPerson: true,
      }),
    );
    const timeline = buildTimeline({ versions, events });
    const entries = timeline.entries.filter((entry) => entry.kind === "version");
    expect(entries.map((entry) => [entry.version.version, entry.pruned])).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ]);
    // a removed version still shows who wrote it, when, and the signed event that made it
    expect(entries[0]).toMatchObject({
      at: at(10),
      version: { authorId: "acc_1", prunedAt: at(50) },
      signature: "verified",
      event: { id: "evt_1" },
    });
    expect(entries[1]).toMatchObject({ version: { authorId: "tok_1" }, signature: "unconfirmed" });
    expect(timeline.pruned).toBe(2);
    expect(timeline.latest?.version).toBe(3);
    // removing content changes no signature: only the version without a signed event is untrusted
    expect(timeline.untrusted).toBe(1);
  });

  it("reads a version listed without the pruned fields as kept", () => {
    const timeline = buildTimeline({
      versions: [
        { version: 1, authorId: "acc_1", createdAt: at(1), deleted: false, fromPendingId: null },
      ],
      events: [],
    });
    expect(timeline.entries[0]).toMatchObject({ kind: "version", pruned: false });
    expect(timeline.pruned).toBe(0);
  });

  it("orders versions, events, checks and comments, attaching each version's signed event", () => {
    const versions = [1, 2, 3].map((version) => ({
      version,
      authorId: "acc_1",
      createdAt: at(version * 10),
      deleted: false,
      fromPendingId: version === 3 ? "pc_1" : null,
    }));
    const events = [
      event("evt_1", 10, 10, {
        signed: { type: "edited", version: 1 },
        signatureValid: true,
        authorIsPerson: true,
      }),
      event("evt_2", 20, 20, {
        signed: { type: "edited", version: 2 },
        signatureValid: false,
        authorIsPerson: true,
      }),
      event("evt_3", 25, 25, {
        signed: null,
        signatureValid: false,
        record: {
          type: "proposed",
          actor: "claude-code/2.1",
          at: at(25),
          baseVersion: 2,
          pendingId: "pc_1",
        },
        authorIsPerson: false,
      }),
      event("evt_4", 30, 30, {
        signed: { type: "approved", version: 3, pendingId: "pc_1" },
        signatureValid: true,
        authorIsPerson: true,
      }),
    ];
    const timeline = buildTimeline({
      versions: [...versions].reverse(),
      events,
      comments: [
        comment(
          "cmt_1",
          15,
          newComment({ author: "human:a", at: at(15), noteId: "note_1", text: "?" }),
        ),
      ],
      checks: [
        {
          id: "chk_1",
          noteVersion: 3,
          authorId: "tok_1",
          authorTokenId: "tok_1",
          createdAt: at(35),
          status: "unapplied",
          seq: 35,
          findings: null,
          signature: "unsigned",
        },
      ],
    });
    expect(
      timeline.entries.map((entry) =>
        entry.kind === "version"
          ? `v${String(entry.version.version)}:${entry.signature}`
          : entry.kind === "event"
            ? entry.event.event.type
            : entry.kind,
      ),
    ).toEqual(["v1:verified", "comment", "v2:invalid", "proposed", "v3:verified", "check"]);
    expect(timeline.latest?.version).toBe(3);
    expect(timeline.untrusted).toBe(1);
    expect(timeline.threads.open).toBe(1);
  });

  it("attaches an agent's direct write to its version, then a person's undo after it", () => {
    const policySha256 = "b".repeat(64);
    const agentEdited = {
      type: "agent_edited",
      version: 2,
      folderId: "fld_1",
      tokenId: "tok_1",
      revision: 3,
      policySha256,
    };
    expect(
      readHistoryEvent({ signed: agentEdited, signatureValid: true, authorIsPerson: false }),
    ).toEqual({ event: agentEdited, signature: "verified" });
    // a signed write never carries a record; a bad signature is invalid
    expect(
      readHistoryEvent({
        signed: agentEdited,
        signatureValid: true,
        record: { type: "wrote" },
        authorIsPerson: false,
      }).signature,
    ).toBe("invalid");
    // missing the agent fields, it is unreadable
    expect(
      readHistoryEvent({
        signed: { type: "agent_edited", version: 2 },
        signatureValid: true,
        authorIsPerson: false,
      }).event,
    ).toEqual({ type: "unreadable" });

    const wrote = { type: "wrote", actor: "claude-code/2.1", at: at(20), version: 2, summary: "s" };
    const versions = [1, 2, 3].map((version) => ({
      version,
      authorId: version === 2 ? "tok_1" : "acc_1",
      createdAt: at(version * 10),
      deleted: false,
      fromPendingId: null,
    }));
    const timeline = buildTimeline({
      versions,
      events: [
        event("evt_1", 10, 10, {
          signed: { type: "edited", version: 1 },
          signatureValid: true,
          authorIsPerson: true,
        }),
        {
          ...event("evt_2", 20, 20, {
            signed: agentEdited,
            signatureValid: true,
            authorIsPerson: false,
          }),
          agent: { tokenId: "tok_1", revoked: false },
        },
        event("evt_3", 21, 20, {
          signed: null,
          signatureValid: false,
          record: wrote,
          authorIsPerson: false,
        }),
        event("evt_4", 30, 30, {
          signed: { type: "edited", version: 3 },
          signatureValid: true,
          authorIsPerson: true,
        }),
        event("evt_5", 31, 30, {
          signed: { type: "recorded", accountId: "acc_1" },
          signatureValid: true,
          record: {
            type: "restored",
            actor: "human:acc_1",
            at: at(30),
            fromVersion: 1,
            version: 3,
          },
          authorIsPerson: true,
        }),
      ],
    });
    expect(
      timeline.entries.map((entry) =>
        entry.kind === "version"
          ? `v${String(entry.version.version)}:${entry.event?.event.type ?? "none"}:${entry.signature}`
          : entry.kind === "event"
            ? `${entry.event.event.type}:${entry.event.signature}`
            : entry.kind,
      ),
    ).toEqual([
      "v1:edited:verified",
      "v2:agent_edited:verified",
      "wrote:unsigned",
      "v3:edited:verified",
      "restored:verified",
    ]);
    expect(timeline.entries[1]).toMatchObject({
      event: { agent: { tokenId: "tok_1", revoked: false } },
    });
    expect(timeline.untrusted).toBe(0);
  });

  it("marks a version without a signed event as unconfirmed", () => {
    const timeline = buildTimeline({
      versions: [
        { version: 1, authorId: "acc_1", createdAt: at(1), deleted: false, fromPendingId: null },
      ],
      events: [],
    });
    expect(timeline.entries[0]).toMatchObject({
      kind: "version",
      signature: "unconfirmed",
      event: null,
    });
  });

  it("finds the last fully verified version", () => {
    expect(
      lastFullyVerifiedVersion([
        { version: 1, fullyVerified: true },
        { version: 3, fullyVerified: true },
        { version: 4, fullyVerified: false },
      ]),
    ).toBe(3);
    expect(lastFullyVerifiedVersion([{ version: 1, fullyVerified: false }])).toBeNull();
  });
});

describe("review rules", () => {
  const record = { type: "restored", actor: "human:acc_1", at: at(1), fromVersion: 1, version: 2 };

  it("accepts a record only under a recorded envelope signed by the person it names", () => {
    const recorded = (accountId: string, valid = true) =>
      readHistoryEvent({
        signed: { type: "recorded", accountId },
        signatureValid: valid,
        record,
        authorIsPerson: true,
      }).signature;
    expect(recorded("acc_1")).toBe("verified");
    expect(recorded("acc_2")).toBe("invalid");
    expect(recorded("acc_1", false)).toBe("invalid");
    // a write type carries no record of its own
    expect(
      readHistoryEvent({
        signed: { type: "edited", version: 2, accountId: "acc_1" },
        signatureValid: true,
        record,
        authorIsPerson: true,
      }).signature,
    ).toBe("invalid");
    // a record's time must be an ISO date-time
    expect(
      readHistoryEvent({
        signed: null,
        signatureValid: false,
        record: { ...record, actor: "claude-code/2", at: "yesterday" },
        authorIsPerson: false,
      }).event,
    ).toEqual({ type: "unreadable" });
  });

  it("keeps fields a newer client wrote", () => {
    const read = readHistoryEvent({
      signed: null,
      signatureValid: false,
      record: { ...record, actor: "claude-code/2", reason: "undo" },
      authorIsPerson: false,
    });
    expect(read.event).toMatchObject({ type: "restored", reason: "undo" });
  });

  it("breaks parent cycles at their oldest comment", () => {
    const a = comment("cmt_a", 1, {
      ...newComment({ author: "human:a", at: at(1), noteId: "note_1", text: "a" }),
      parent: "cmt_b",
    });
    const b = comment("cmt_b", 2, {
      ...newComment({ author: "human:a", at: at(2), noteId: "note_1", text: "b" }),
      parent: "cmt_a",
    });
    const threads = buildThreads([b, a]);
    expect(
      threads.threads.map((thread) => [thread.root.id, thread.replies.map((reply) => reply.id)]),
    ).toEqual([["cmt_a", ["cmt_b"]]]);
  });

  it("orders by seq, whatever the clocks say, with unreadable dates last", () => {
    const version = (n: number, createdAt: string) => ({
      version: n,
      authorId: "acc_1",
      createdAt,
      deleted: false,
      fromPendingId: null,
    });
    const timeline = buildTimeline({
      versions: [version(1, at(50)), version(2, at(10)), version(3, "not a date")],
      events: [
        event("evt_1", 1, 50, {
          signed: { type: "edited", version: 1 },
          signatureValid: true,
          authorIsPerson: true,
        }),
        event("evt_2", 2, 10, {
          signed: { type: "edited", version: 2 },
          signatureValid: true,
          authorIsPerson: true,
        }),
      ],
      comments: [comment("cmt_1", 30, null)],
    });
    expect(
      timeline.entries.map((entry) =>
        entry.kind === "version" ? `v${String(entry.version.version)}` : entry.kind,
      ),
    ).toEqual(["v1", "v2", "comment", "v3"]);
  });
});
