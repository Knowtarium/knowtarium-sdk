import { parse } from "smol-toml";

import { type ConfigEdit, isRecord } from "./json-config.js";
import { SERVER_NAME, type ServerCommand } from "./server-entry.js";

const TABLE = `[mcp_servers.${SERVER_NAME}]`;
// a key as TOML may spell it: bare, "basic" or 'literal'
const key = (name: string) => `(?:${name}|"${name}"|'${name}')`;
const TABLE_HEADER = new RegExp(
  `^\\s*\\[\\s*${key("mcp_servers")}\\s*\\.\\s*${key(SERVER_NAME)}\\s*\\]\\s*(?:#.*)?$`,
);
const ANY_HEADER = /^\s*\[/;
const COMMAND_OR_ARGS = new RegExp(`^\\s*(?:${key("command")}|${key("args")})\\s*=`);
const INLINE_ENTRY = new RegExp(
  `^(\\s*(?:${key("mcp_servers")}\\s*\\.\\s*)?${key(SERVER_NAME)})\\s*=\\s*\\{`,
);

/** A TOML value written inline (strings, numbers, booleans, dates, arrays, inline tables). */
function tomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (isRecord(value)) {
    const pairs = Object.entries(value).map(
      ([name, inner]) =>
        `${/^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name)} = ${tomlValue(inner)}`,
    );
    return pairs.length === 0 ? "{}" : `{ ${pairs.join(", ")} }`;
  }
  throw new Error("a value TOML can't write inline");
}

function commandLines(server: ServerCommand): string[] {
  return [`command = ${tomlValue(server.command)}`, `args = ${tomlValue([...server.args])}`];
}

function parses(text: string): Record<string, unknown> | null {
  try {
    return parse(text);
  } catch {
    return null;
  }
}

/** How many lines from `start` one statement spans (a value may run over several lines). */
function statementLength(lines: readonly string[], start: number, limit: number): number | null {
  for (let end = start + 1; end <= limit; end++) {
    if (parses(lines.slice(start, end).join("\n")) !== null) return end - start;
  }
  return null;
}

/** A value with its keys sorted, to compare parsed configs whatever the key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    isRecord(inner) && !(inner instanceof Date)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  );
}

/** Appends `[mcp_servers.knowtarium]` at the end of the file. */
function appendTable(source: string, eol: string, server: ServerCommand): string {
  const separator =
    source === "" || source.endsWith(eol + eol) ? "" : source.endsWith(eol) ? eol : eol + eol;
  return source + separator + [TABLE, ...commandLines(server)].join(eol) + eol;
}

/**
 * Rewrites `command` and `args` inside an existing `[mcp_servers.knowtarium]` table (however its
 * header is spelled), keeping every other key, comment and sub-table.
 */
function editTable(lines: string[], eol: string, server: ServerCommand): string | null {
  const start = lines.findIndex((line) => TABLE_HEADER.test(line));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !ANY_HEADER.test(lines[end] ?? "")) end++;
  const body: string[] = [];
  for (let index = start + 1; index < end;) {
    const line = lines[index] ?? "";
    if (!COMMAND_OR_ARGS.test(line)) {
      body.push(line);
      index++;
      continue;
    }
    const length = statementLength(lines, index, end);
    if (length === null) return null;
    index += length;
  }
  return [...lines.slice(0, start + 1), ...commandLines(server), ...body, ...lines.slice(end)].join(
    eol,
  );
}

/** Rewrites an inline `knowtarium = { ... }` entry (under `[mcp_servers]` or dotted). */
function editInline(lines: string[], eol: string, entry: unknown): string | null {
  const start = lines.findIndex((line) => INLINE_ENTRY.test(line));
  if (start === -1) return null;
  const length = statementLength(lines, start, lines.length);
  const prefix = INLINE_ENTRY.exec(lines[start] ?? "")?.[1];
  if (length === null || prefix === undefined) return null;
  return [
    ...lines.slice(0, start),
    `${prefix} = ${tomlValue(entry)}`,
    ...lines.slice(start + length),
  ].join(eol);
}

/**
 * Adds (or updates) Knowtarium's server in Codex's `config.toml`, touching nothing else. The file
 * is parsed first (a real TOML parser), so an entry is found however it is written: its own
 * table, a quoted key, an inline table under `[mcp_servers]` or a dotted key. Only `command` and
 * `args` change; other keys such as `env` stay. The result must parse back to the same config
 * plus that change, or nothing is written (`invalid`).
 */
export function upsertCodexServer(text: string | null, server: ServerCommand): ConfigEdit {
  const source = text ?? "";
  const config = parses(source);
  if (config === null) return { status: "invalid", reason: "the file isn't valid TOML." };
  const servers = config["mcp_servers"] ?? {};
  if (!isRecord(servers)) return { status: "invalid", reason: "`mcp_servers` isn't a table." };
  const existing = servers[SERVER_NAME];
  if (existing !== undefined && !isRecord(existing)) {
    return { status: "invalid", reason: `\`mcp_servers.${SERVER_NAME}\` isn't a table.` };
  }
  const entry = { ...existing, command: server.command, args: [...server.args] };
  if (existing !== undefined && canonical(existing) === canonical(entry)) {
    return { status: "unchanged" };
  }
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  let next: string | null;
  try {
    next =
      existing === undefined
        ? appendTable(source, eol, server)
        : (editTable(lines, eol, server) ?? editInline(lines, eol, entry));
  } catch {
    next = null;
  }
  const expected = { ...config, mcp_servers: { ...servers, [SERVER_NAME]: entry } };
  const check = next === null ? null : parses(next);
  if (next === null || check === null || canonical(check) !== canonical(expected)) {
    return {
      status: "invalid",
      reason: "its MCP servers are written in a form this can't edit safely.",
    };
  }
  return { status: existing === undefined ? "added" : "updated", text: next };
}
