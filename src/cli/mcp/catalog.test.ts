import { describe, expect, it } from "vitest";

import { toolCatalog } from "./catalog.js";

describe("the tool catalog", () => {
  it("lists every tool the server can offer, connect last, each with a description", async () => {
    const tools = await toolCatalog();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "connect",
      "create_note",
      "flag_conflict",
      "get_conventions",
      "list_comments",
      "list_folders",
      "list_notes",
      "list_pending_checks",
      "list_stale",
      "list_workspaces",
      "my_pending_changes",
      "note_history",
      "propose_edit",
      "read_note",
      "record_check",
      "related_notes",
      "reply_comment",
      "resolve_link",
      "search_notes",
    ]);
    expect(tools.at(-1)?.name).toBe("connect");
    for (const tool of tools) expect(tool.description?.length, tool.name).toBeGreaterThan(20);
  });

  it("marks every tool but connect as talking only to Knowtarium, and no change as destructive", async () => {
    const tools = await toolCatalog();
    for (const tool of tools) {
      // connect opens the browser on the sign-in page
      expect(tool.annotations?.openWorldHint, tool.name).toBe(tool.name === "connect");
      expect(tool.annotations?.destructiveHint, tool.name).not.toBe(true);
    }
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of ["propose_edit", "create_note"]) {
      expect(byName.get(name)?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      });
    }
    for (const name of ["search_notes", "my_pending_changes", "list_pending_checks"]) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true);
    }
  });
});
