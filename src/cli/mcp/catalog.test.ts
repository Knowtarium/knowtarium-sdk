import { describe, expect, it } from "vitest";

import { toolCatalog } from "./catalog.js";

describe("the tool catalog", () => {
  it("lists every tool the server can offer, connect last, each with a description", async () => {
    const tools = await toolCatalog();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "connect",
      "create_folder",
      "create_note",
      "delete_folder",
      "delete_note",
      "flag_conflict",
      "get_conventions",
      "list_comments",
      "list_folders",
      "list_inbox",
      "list_notes",
      "list_pending_checks",
      "list_stale",
      "list_workspaces",
      "move_folder",
      "move_note",
      "my_pending_changes",
      "note_history",
      "propose_edit",
      "read_note",
      "record_check",
      "related_notes",
      "rename_folder",
      "reply_comment",
      "resolve_link",
      "search_notes",
    ]);
    expect(tools.at(-1)?.name).toBe("connect");
    for (const tool of tools) expect(tool.description?.length, tool.name).toBeGreaterThan(20);
  });

  it("marks every tool but connect as talking only to Knowtarium, and only the deletes as destructive", async () => {
    const tools = await toolCatalog();
    for (const tool of tools) {
      // connect opens the browser on the sign-in page
      expect(tool.annotations?.openWorldHint, tool.name).toBe(tool.name === "connect");
      expect(tool.annotations?.destructiveHint === true, tool.name).toBe(
        tool.name === "delete_note" || tool.name === "delete_folder",
      );
    }
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of [
      "propose_edit",
      "create_note",
      "move_note",
      "create_folder",
      "rename_folder",
      "move_folder",
    ]) {
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
