import { describe, expect, it } from "vitest";

import {
  CheckRecord,
  NewCheck,
  NewComment,
  NewEvent,
  NoteComment,
  NoteEvent,
  PendingChange,
  RejectPendingRequest,
  ResolveCheckRequest,
  UpdateCommentRequest,
} from "./index.js";
import { b64, ct, id, now } from "./test-fixtures.js";

describe("pending changes", () => {
  const pending = {
    id: id("pc"),
    workspaceId: id("ws"),
    noteId: id("note"),
    folderId: id("fld"),
    baseVersion: 3,
    clientNonce: b64(16),
    sizeBytes: 1200,
    submittedBy: id("tok"),
    authorTokenId: id("tok"),
    createdAt: now,
    status: "open",
    decidedAt: null,
    resultingVersion: null,
    rejectionCommentId: null,
    seq: 9,
  };

  it("describes a pending change by ids, versions and sizes", () => {
    expect(PendingChange.safeParse(pending).success).toBe(true);
    expect(PendingChange.safeParse({ ...pending, status: "merged" }).success).toBe(false);
    expect(PendingChange.safeParse({ ...pending, submittedBy: id("acc") }).success).toBe(false);
    expect(PendingChange.safeParse({ ...pending, authorTokenId: null }).success).toBe(false);
  });

  it("rejects with an encrypted comment, always signed", () => {
    const body = { commentId: id("cmt"), ciphertext: ct, signedAt: now, signature: b64(64) };
    expect(RejectPendingRequest.safeParse(body).success).toBe(true);
    expect(RejectPendingRequest.safeParse({ ...body, signature: undefined }).success).toBe(false);
    expect(RejectPendingRequest.safeParse({ ...body, text: "Wrong number" }).success).toBe(false);
  });
});

describe("events, comments and checks", () => {
  it("takes an event as ciphertext with an optional signature", () => {
    const event = { id: id("evt"), noteId: id("note"), noteVersion: 4, ciphertext: ct };
    const signing = { signedAt: now, signature: b64(64) };
    expect(NewEvent.safeParse(event).success).toBe(true);
    expect(NewEvent.safeParse({ ...event, ...signing }).success).toBe(true);
    expect(NewEvent.safeParse({ ...event, signature: b64(64) }).success).toBe(false);
    expect(NewEvent.safeParse({ ...event, signedAt: now }).success).toBe(false);
    expect(NewEvent.safeParse({ ...event, ...signing, signature: b64(32) }).success).toBe(false);
    expect(NewEvent.safeParse({ ...event, type: "approved" }).success).toBe(false);
  });

  it("takes comments and comment updates as ciphertext", () => {
    expect(
      NewComment.safeParse({ id: id("cmt"), noteId: id("note"), ciphertext: ct }).success,
    ).toBe(true);
    expect(UpdateCommentRequest.safeParse({ baseRevision: 1, ciphertext: ct }).success).toBe(true);
    expect(UpdateCommentRequest.safeParse({ baseRevision: 0, ciphertext: ct }).success).toBe(false);
    expect(
      NewComment.safeParse({ id: id("cmt"), noteId: id("note"), ciphertext: ct, signedAt: now })
        .success,
    ).toBe(false);
  });

  it("records a check against a note version", () => {
    const check = { id: id("chk"), noteId: id("note"), noteVersion: 2, ciphertext: ct };
    expect(NewCheck.safeParse(check).success).toBe(true);
    expect(NewCheck.safeParse({ ...check, noteVersion: 0 }).success).toBe(false);
    expect(NewCheck.safeParse({ ...check, result: "pass" }).success).toBe(false);
  });

  it("resolves a check as applied (with its version) or dismissed", () => {
    expect(ResolveCheckRequest.safeParse({ status: "applied", appliedVersion: 5 }).success).toBe(
      true,
    );
    expect(ResolveCheckRequest.safeParse({ status: "dismissed" }).success).toBe(true);
    expect(ResolveCheckRequest.safeParse({ status: "applied" }).success).toBe(false);
    expect(ResolveCheckRequest.safeParse({ status: "unapplied" }).success).toBe(false);
  });
});

describe("server-asserted agent attribution", () => {
  const base = {
    workspaceId: id("ws"),
    noteId: id("note"),
    createdAt: now,
    seq: 4,
    ciphertext: ct,
  };
  const comment = {
    ...base,
    id: id("cmt"),
    authorId: id("tok"),
    authorTokenId: id("tok"),
    updatedAt: now,
    revision: 1,
    signed: null,
  };
  const event = {
    ...base,
    id: id("evt"),
    noteVersion: 2,
    authorId: id("tok"),
    authorTokenId: id("tok"),
    signed: null,
  };
  const check = {
    ...base,
    id: id("chk"),
    noteVersion: 2,
    authorId: id("tok"),
    authorTokenId: id("tok"),
    status: "unapplied",
    appliedVersion: null,
    resolvedAt: null,
  };

  it("names the posting token on agents' comments, events and checks, null for a person's", () => {
    expect(NoteComment.safeParse(comment).success).toBe(true);
    expect(NoteEvent.safeParse(event).success).toBe(true);
    expect(CheckRecord.safeParse(check).success).toBe(true);
    const person = { authorId: id("acc"), authorTokenId: null };
    expect(NoteComment.safeParse({ ...comment, ...person }).success).toBe(true);
    expect(NoteEvent.safeParse({ ...event, ...person }).success).toBe(true);
    expect(CheckRecord.safeParse({ ...check, authorTokenId: null }).success).toBe(false);
    expect(NoteComment.safeParse({ ...comment, authorTokenId: undefined }).success).toBe(false);
    expect(NoteEvent.safeParse({ ...event, authorTokenId: id("acc") }).success).toBe(false);
  });
});
