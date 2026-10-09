import { SERVER_NAME, type ServerCommand } from "./server-entry.js";

/** How an agent's JSON config lists MCP servers. */
export type JsonLayout = "mcpServers" | "opencode";

/** The outcome of updating one config text. */
export type ConfigEdit =
  | { readonly status: "unchanged" }
  | { readonly status: "added" | "updated"; readonly text: string }
  | { readonly status: "invalid"; readonly reason: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a JSON text has line or block comments (outside strings), as JSONC files may. */
export function hasComments(text: string): boolean {
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "/" && (text[index + 1] === "/" || text[index + 1] === "*")) return true;
  }
  return false;
}

/**
 * Knowtarium's entry for a layout. The keys of an existing entry that this doesn't set (`env`,
 * `timeout` and the like) are kept, unless it pointed at a URL (then it is replaced whole).
 */
function entryFor(layout: JsonLayout, server: ServerCommand, existing: unknown): unknown {
  const kept = isRecord(existing) && !("url" in existing) ? existing : {};
  return layout === "opencode"
    ? {
        ...kept,
        type: "local",
        command: [server.command, ...server.args],
        enabled: true,
      }
    : { ...kept, command: server.command, args: [...server.args] };
}

/**
 * Adds (or updates) Knowtarium's server in an agent's JSON config, touching nothing else: other
 * servers and settings stay, and so do extra keys of Knowtarium's own entry, such as `env`.
 * `mcpServers` is Claude Code, Claude Desktop and Cursor; `opencode` is OpenCode's `mcp` map. A
 * file that isn't a JSON object (or has comments) is left alone (`invalid`).
 */
export function upsertJsonServer(
  text: string | null,
  layout: JsonLayout,
  server: ServerCommand,
): ConfigEdit {
  let config: unknown = {};
  if (text !== null && text.trim() !== "") {
    if (hasComments(text)) {
      return {
        status: "invalid",
        reason: "the file has comments, which an edit couldn't keep, so it wasn't changed.",
      };
    }
    try {
      config = JSON.parse(text);
    } catch {
      return {
        status: "invalid",
        reason:
          "the file isn't valid JSON (a typo, perhaps), so it wasn't changed. Fix it and run `knowtarium agents` again.",
      };
    }
  }
  if (!isRecord(config)) return { status: "invalid", reason: "the file isn't a JSON object." };
  const key = layout === "opencode" ? "mcp" : "mcpServers";
  const servers = config[key] ?? {};
  if (!isRecord(servers)) return { status: "invalid", reason: `\`${key}\` isn't a JSON object.` };
  const existing = servers[SERVER_NAME];
  const entry = entryFor(layout, server, existing);
  if (JSON.stringify(existing) === JSON.stringify(entry)) return { status: "unchanged" };
  const updated = { ...config, [key]: { ...servers, [SERVER_NAME]: entry } };
  return {
    status: existing === undefined ? "added" : "updated",
    text: `${JSON.stringify(updated, null, 2)}\n`,
  };
}
