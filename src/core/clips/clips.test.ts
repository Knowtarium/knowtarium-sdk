import { describe, expect, it } from "vitest";

import { parseNote } from "../note/index.js";
import { readHistoryEvent } from "../history/index.js";
import { CLIP_NOTE_TYPE, clipNoteText, clipNoteTitle } from "./index.js";

const clip = {
  url: "https://example.com/blog/faster-builds",
  title: "How we sped up our build",
  note: "Read before the CI meeting.",
  savedAt: "2026-10-10T09:41:07.512Z",
};

describe("a clip's note", () => {
  it("has the title, type, status, link and time, and the note as its body", () => {
    expect(clipNoteText(clip)).toBe(
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
    expect(CLIP_NOTE_TYPE).toBe("Clip");
  });

  it("names the link's host when the clip has no title", () => {
    expect(clipNoteTitle({ url: "https://user@docs.example.org:8443/a?b#c", title: " " })).toBe(
      "docs.example.org",
    );
    expect(clipNoteTitle({ url: "http://[::1]/x", title: "" })).toBe("[::1]");
    const text = clipNoteText({ ...clip, title: "", note: "" });
    expect(parseNote(text).frontmatter?.data["title"]).toBe("example.com");
    expect(parseNote(text).body).toBe("");
  });

  it("keeps every value in its own field, whatever it holds", () => {
    const hostile = {
      url: "https://example.com/a?x=1#--- b: 'c'",
      title: 'a: b" # [c] {d} | > ! & * %',
      note: "---\ntitle: other\n---",
      savedAt: clip.savedAt,
    };
    const parsed = parseNote(clipNoteText(hostile));
    expect(parsed.problems).toEqual([]);
    expect(parsed.frontmatter?.data).toEqual({
      title: hostile.title,
      type: "Clip",
      status: "inbox",
      url: hostile.url,
      saved: clip.savedAt,
    });
    expect(parsed.body).toBe(hostile.note);
  });
});

describe("the clipped history record", () => {
  const record = {
    type: "clipped",
    actor: "claude-code/2.1",
    at: "2026-10-10T09:42:00.000Z",
    version: 1,
    clipId: "clip_1248h248h248h248h248h248h2",
    extensionId: "ext_0h248h248h248h248h248h248h",
    payload: "{}",
    signature: "c2ln",
  };

  it("reads as an agent's unsigned record, or a person's signed one", () => {
    const unsigned = readHistoryEvent({
      signed: null,
      signatureValid: false,
      record,
      authorIsPerson: false,
    });
    expect(unsigned).toMatchObject({ event: { type: "clipped" }, signature: "unsigned" });
    const person = { ...record, actor: "human:acc_1" };
    const signed = readHistoryEvent({
      signed: { type: "recorded", accountId: "acc_1" },
      signatureValid: true,
      record: person,
      authorIsPerson: true,
    });
    expect(signed.signature).toBe("verified");
  });

  it("is unreadable without its payload or signature", () => {
    const partial = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "payload"));
    const read = readHistoryEvent({
      signed: null,
      signatureValid: false,
      record: partial,
      authorIsPerson: false,
    });
    expect(read.event.type).toBe("unreadable");
  });
});
