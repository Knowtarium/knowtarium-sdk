import { lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";

import { parse } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";

import { mcpCommand } from "../commands/mcp.js";
import { cliEnvironment } from "../env.js";
import { COMMANDS } from "../run.js";
import { temporaryFolder } from "../testing/context.js";
import { configureAgents, detectAgents } from "./configure.js";
import { handAdd } from "../commands/agents.js";
import { upsertJsonServer } from "./json-config.js";
import { MCP_COMMAND, serverCommand } from "./server-entry.js";
import { agentTargets } from "./targets.js";
import { upsertCodexServer } from "./toml-config.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const server = serverCommand("1.2.3", "linux");
const ARGS = ["-y", "knowtarium@1.2.3", "mcp"];

async function userHome() {
  const created = await temporaryFolder();
  cleanup = created.cleanup;
  const env = cliEnvironment({}, "linux", created.path);
  return { home: created.path, targets: agentTargets(env) };
}

async function write(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

describe("the server command", () => {
  it("pins this CLI version, runs a command that exists, and goes through cmd on Windows", () => {
    expect(server).toEqual({ command: "npx", args: ARGS });
    expect(COMMANDS[MCP_COMMAND]).toBe(mcpCommand);
    expect(server.args.at(-1)).toBe(MCP_COMMAND);
    expect(serverCommand("1.2.3", "win32")).toEqual({
      command: "cmd",
      args: ["/c", "npx", ...ARGS],
    });
  });
});

describe("JSON configs", () => {
  it("adds the server beside the others, and changes nothing the second time", () => {
    const first = upsertJsonServer(
      JSON.stringify({ theme: "dark", mcpServers: { other: { command: "other" } } }),
      "mcpServers",
      server,
    );
    if (first.status !== "added") throw new Error("expected an add");
    expect(JSON.parse(first.text)).toEqual({
      theme: "dark",
      mcpServers: {
        other: { command: "other" },
        knowtarium: { command: "npx", args: ARGS },
      },
    });
    expect(upsertJsonServer(first.text, "mcpServers", server)).toEqual({ status: "unchanged" });
    expect(upsertJsonServer("// comment\n{}", "mcpServers", server).status).toBe("invalid");
    expect(upsertJsonServer("[]", "mcpServers", server).status).toBe("invalid");
  });

  it("keeps the entry's own extra keys, such as env", () => {
    const existing = JSON.stringify({
      mcpServers: {
        knowtarium: { command: "npx", args: ["knowtarium", "mcp"], env: { HTTPS_PROXY: "p" } },
      },
    });
    const edit = upsertJsonServer(existing, "mcpServers", server);
    if (edit.status !== "updated") throw new Error("expected an update");
    expect(JSON.parse(edit.text)).toEqual({
      mcpServers: { knowtarium: { command: "npx", args: ARGS, env: { HTTPS_PROXY: "p" } } },
    });
  });

  it("writes OpenCode's local server form", () => {
    const edit = upsertJsonServer(
      JSON.stringify({ mcp: { knowtarium: { type: "local", environment: { A: "1" } } } }),
      "opencode",
      server,
    );
    if (edit.status !== "updated") throw new Error("expected an update");
    expect(JSON.parse(edit.text)).toEqual({
      mcp: {
        knowtarium: {
          type: "local",
          command: ["npx", ...ARGS],
          enabled: true,
          environment: { A: "1" },
        },
      },
    });
  });
});

describe("Codex's TOML", () => {
  const entry = (text: string) =>
    (parse(text) as { mcp_servers: Record<string, unknown> }).mcp_servers["knowtarium"];

  it("adds its own table, replaces only command and args, and keeps everything else", () => {
    const base = 'model = "o3"\n\n[mcp_servers.other]\ncommand = "other"\n';
    const added = upsertCodexServer(base, server);
    if (added.status !== "added") throw new Error("expected an add");
    expect(added.text).toBe(
      `${base}\n[mcp_servers.knowtarium]\ncommand = "npx"\nargs = ["-y", "knowtarium@1.2.3", "mcp"]\n`,
    );
    expect(upsertCodexServer(added.text, server)).toEqual({ status: "unchanged" });

    const stale =
      '[mcp_servers."knowtarium"] # ours\nargs = [\n  "knowtarium",\n  "serve",\n]\ncommand = "npx"\nenv = { A = "1" }\n\n[mcp_servers.knowtarium.env2]\nB = "2"\n\n[profiles.x]\nmodel = "y"\n';
    const updated = upsertCodexServer(stale, server);
    if (updated.status !== "updated") throw new Error("expected an update");
    expect(updated.text).toBe(
      '[mcp_servers."knowtarium"] # ours\ncommand = "npx"\nargs = ["-y", "knowtarium@1.2.3", "mcp"]\nenv = { A = "1" }\n\n[mcp_servers.knowtarium.env2]\nB = "2"\n\n[profiles.x]\nmodel = "y"\n',
    );
  });

  it("finds an inline entry under [mcp_servers] and keeps its env", () => {
    const text =
      '[mcp_servers]\nother = { command = "x" }\nknowtarium = { command = "old", env = { A = "1" } } # note\n';
    const edit = upsertCodexServer(text, server);
    if (edit.status !== "updated") throw new Error("expected an update");
    expect(entry(edit.text)).toEqual({ command: "npx", args: ARGS, env: { A: "1" } });
    expect(edit.text.startsWith('[mcp_servers]\nother = { command = "x" }\n')).toBe(true);
    expect(upsertCodexServer(edit.text, server)).toEqual({ status: "unchanged" });
  });

  it("never writes what it can't edit safely", () => {
    expect(upsertCodexServer('mcp_servers = { other = { command = "x" } }\n', server)).toEqual({
      status: "invalid",
      reason: "its MCP servers are written in a form this can't edit safely.",
    });
    expect(upsertCodexServer("[mcp_servers\n", server).status).toBe("invalid");
    expect(upsertCodexServer('[mcp_servers]\nknowtarium.command = "x"\n', server).status).toBe(
      "invalid",
    );
  });
});

describe("configuring agents", () => {
  it("detects installed agents, backs files up, and never clobbers", async () => {
    const { home, targets } = await userHome();
    await write(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "x" } } }),
    );
    await write(join(home, ".codex", "config.toml"), 'model = "o3"\n');
    await write(join(home, ".claude.json"), "{ not json");
    const found = await detectAgents(targets);
    expect(found.map((target) => target.id)).toEqual(["claude-code", "cursor", "codex"]);

    const dry = await configureAgents(found, server, { dryRun: true });
    expect(dry.map((result) => result.status)).toEqual(["skipped", "added", "added"]);
    expect(await readFile(join(home, ".codex", "config.toml"), "utf8")).toBe('model = "o3"\n');

    const results = await configureAgents(found, server, {
      now: () => new Date("2026-10-01T12:00:00Z"),
    });
    expect(results.map((result) => result.status)).toEqual(["skipped", "added", "added"]);
    expect(await readFile(join(home, ".claude.json"), "utf8")).toBe("{ not json");
    const cursor = JSON.parse(await readFile(join(home, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(cursor.mcpServers)).toEqual(["other", "knowtarium"]);
    expect(await readdir(join(home, ".cursor"))).toContain(
      "mcp.json.knowtarium-backup-2026-10-01T12-00-00-000Z",
    );

    const again = await configureAgents(found, server);
    expect(again.map((result) => result.status)).toEqual(["skipped", "unchanged", "unchanged"]);
  });

  // creating symlinks needs extra rights on Windows
  it.skipIf(process.platform === "win32")(
    "keeps three backups, follows symlinks and uses opencode.jsonc",
    async () => {
      const { home, targets } = await userHome();
      const real = join(home, "dotfiles", "mcp.json");
      await write(real, "{}");
      await mkdir(join(home, ".cursor"));
      await symlink(real, join(home, ".cursor", "mcp.json"));
      await write(join(home, ".config", "opencode", "opencode.jsonc"), "{}");
      const chosen = targets.filter((target) => ["cursor", "opencode"].includes(target.id));
      for (let version = 1; version <= 5; version++) {
        const results = await configureAgents(
          chosen,
          serverCommand(`1.0.${String(version)}`, "linux"),
          {
            now: () => new Date(Date.UTC(2026, 9, 1, 12, version)),
          },
        );
        expect(results.map((result) => result.status)).toEqual(
          version === 1 ? ["added", "added"] : ["updated", "updated"],
        );
      }
      expect((await lstat(join(home, ".cursor", "mcp.json"))).isSymbolicLink()).toBe(true);
      expect(await readFile(real, "utf8")).toContain("knowtarium@1.0.5");
      const backups = (await readdir(join(home, "dotfiles"))).filter((name) =>
        name.includes(".knowtarium-backup-"),
      );
      expect(backups).toHaveLength(3);
      expect(backups.sort()[0]).toContain("12-03");
      const opencode = await readdir(join(home, ".config", "opencode"));
      expect(opencode).not.toContain("opencode.json");
      expect(await readFile(join(home, ".config", "opencode", "opencode.jsonc"), "utf8")).toContain(
        "knowtarium@1.0.5",
      );
    },
  );

  it("finds Claude Desktop's config where each platform keeps it", () => {
    const find = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}) =>
      agentTargets(cliEnvironment(env, platform, "/u")).find(
        (target) => target.id === "claude-desktop",
      )?.configPath;
    expect(find("darwin")).toBe(
      join("/u", "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    );
    expect(find("linux")).toBe(join("/u", ".config", "Claude", "claude_desktop_config.json"));
    expect(find("win32", { APPDATA: "/roaming" })).toBe(
      join("/roaming", "Claude", "claude_desktop_config.json"),
    );
  });

  it("finds the Microsoft Store build of Claude Desktop", async () => {
    const { home } = await userHome();
    const local = join(home, "local");
    const store = join(local, "Packages", "Claude_abc123", "LocalCache", "Roaming", "Claude");
    await mkdir(store, { recursive: true });
    const targets = agentTargets(
      cliEnvironment({ APPDATA: join(home, "roaming"), LOCALAPPDATA: local }, "win32", home),
    );
    const desktop = targets.find((target) => target.id === "claude-desktop");
    expect(desktop?.otherConfigPaths).toEqual([join(store, "claude_desktop_config.json")]);
    expect((await detectAgents(targets)).map((target) => target.id)).toEqual(["claude-desktop"]);
    const [result] = await configureAgents(desktop === undefined ? [] : [desktop], server, {
      dryRun: true,
    });
    expect(result?.path).toBe(join(home, "roaming", "Claude", "claude_desktop_config.json"));
  });
});

describe("configs it can't edit", () => {
  it("says why (comments, or broken JSON) and how to add the server by hand", async () => {
    const { home, targets } = await userHome();
    const desktop = targets.find((target) => target.id === "claude-desktop");
    const opencode = targets.find((target) => target.id === "opencode");
    if (desktop === undefined || opencode === undefined) throw new Error("expected the targets");
    await write(desktop.configPath, '{ "mcpServers": { } ');
    await write(
      join(home, ".config", "opencode", "opencode.jsonc"),
      '{\n  // my settings\n  "theme": "dark"\n}\n',
    );
    const [broken, commented] = await configureAgents([desktop, opencode], server);
    expect(broken).toMatchObject({ status: "skipped" });
    expect(broken?.reason).toMatch(/isn't valid JSON/);
    expect(commented).toMatchObject({ status: "skipped" });
    expect(commented?.reason).toMatch(/has comments/);
    if (broken === undefined || commented === undefined) throw new Error("expected results");
    expect(handAdd(broken, server)).toBe(
      `in ${broken.path}, under "mcpServers": "knowtarium": { "command": "npx", "args": ["-y","knowtarium@1.2.3","mcp"] }`,
    );
    expect(handAdd(commented, server)).toContain('under "mcp": "knowtarium": { "type": "local"');
    expect(handAdd({ ...broken, agent: "claude-code", name: "Claude Code" }, server)).toBe(
      "claude mcp add --scope user knowtarium -- npx -y knowtarium@1.2.3 mcp",
    );

    // a .jsonc without comments is edited like JSON
    await write(join(home, ".config", "opencode", "opencode.jsonc"), '{ "theme": "dark" }\n');
    const [edited] = await configureAgents([opencode], server);
    expect(edited).toMatchObject({ status: "added" });
  });
});
