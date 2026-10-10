// Windows answers EPERM, EACCES or EBUSY for a moment where other systems don't: creating or
// opening a file another process has just deleted ("delete pending" until its last handle
// closes), renaming over a file another process has open, a virus scanner holding a file.
// These tests make `node:fs/promises` fail that way and pretend to be on Windows, so they run on
// every OS.
import * as fs from "node:fs/promises";
import { readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ready } from "../../crypto/index.js";
import { configureAgents } from "../agents/configure.js";
import { serverCommand } from "../agents/server-entry.js";
import { agentTargets } from "../agents/targets.js";
import { cliEnvironment } from "../env.js";
import { temporaryFolder } from "../testing/context.js";
import { Credentials } from "./credentials.js";
import { FileCacheAdapter } from "./file-cache.js";
import {
  isWindowsBusy,
  readIfExists,
  replaceFile,
  retryWhileBusy,
  writePrivateFile,
} from "./files.js";
import { withFileLock } from "./lock.js";
import { MemorySecretStore } from "./secret-store.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    readFile: vi.fn(actual.readFile),
    rename: vi.fn(actual.rename),
    rm: vi.fn(actual.rm),
  };
});

beforeAll(ready);

const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

type Mocked = "open" | "readFile" | "rename" | "rm";

/**
 * Every call of `fs[name]` on a path ending with `suffix` (or matching it) fails with the next
 * code, then works. Returns the paths it was called with, and when.
 */
function failNext(
  name: Mocked,
  suffix: string | RegExp,
  codes: readonly string[],
): { calls: string[]; times: number[] } {
  const queue = [...codes];
  const calls: string[] = [];
  const times: number[] = [];
  const original = actual[name] as (...args: unknown[]) => Promise<unknown>;
  vi.mocked(fs[name]).mockImplementation(((...args: unknown[]) => {
    // a rename by its destination, the file another process may have open
    const path = String(name === "rename" ? args[1] : args[0]);
    calls.push(path);
    times.push(Date.now());
    const matches = typeof suffix === "string" ? path.endsWith(suffix) : suffix.test(path);
    const code = matches ? queue.shift() : undefined;
    if (code !== undefined) {
      return Promise.reject(
        Object.assign(new Error(`${code}: operation not permitted, ${name} '${path}'`), { code }),
      );
    }
    return original(...args);
  }) as never);
  return { calls, times };
}

/** Every call of `fs[name]` on a path ending with `suffix` fails with `code`. */
const failAlways = (name: Mocked, suffix: string | RegExp, code: string) =>
  failNext(
    name,
    suffix,
    Array.from({ length: 10_000 }, () => code),
  );

const platform = Object.getOwnPropertyDescriptor(process, "platform");
const pretend = (value: NodeJS.Platform) => {
  Object.defineProperty(process, "platform", { ...platform, value });
};

let cleanup: (() => Promise<void>) | undefined;
async function folder(): Promise<string> {
  const created = await temporaryFolder();
  cleanup = created.cleanup;
  return created.path;
}

beforeEach(() => {
  pretend("win32");
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const name of ["open", "readFile", "rename", "rm"] as const) {
    vi.mocked(fs[name]).mockImplementation(actual[name] as never);
  }
  if (platform !== undefined) Object.defineProperty(process, "platform", platform);
  await cleanup?.();
  cleanup = undefined;
});

const busy = (code: string) => Object.assign(new Error(code), { code });

describe("Windows busy errors", () => {
  it("are EPERM, EACCES and EBUSY on Windows only", () => {
    for (const code of ["EPERM", "EACCES", "EBUSY"]) expect(isWindowsBusy(busy(code))).toBe(true);
    expect(isWindowsBusy(busy("EEXIST"))).toBe(false);
    expect(isWindowsBusy(busy("ENOENT"))).toBe(false);
    expect(isWindowsBusy(new Error("no code"))).toBe(false);
    expect(isWindowsBusy(null)).toBe(false);
    pretend("linux");
    expect(isWindowsBusy(busy("EPERM"))).toBe(false);
  });

  it("are retried until the deadline, then thrown as they are", async () => {
    let tries = 0;
    const flaky = () => (++tries < 3 ? Promise.reject(busy("EBUSY")) : Promise.resolve("done"));
    expect(await retryWhileBusy(flaky, Date.now() + 5_000)).toBe("done");
    expect(tries).toBe(3);

    tries = 0;
    const started = Date.now();
    const stuck = () => {
      tries++;
      return Promise.reject(busy("EACCES"));
    };
    await expect(retryWhileBusy(stuck, Date.now() + 100)).rejects.toMatchObject({
      code: "EACCES",
    });
    expect(tries).toBeGreaterThan(1);
    expect(Date.now() - started).toBeLessThan(1_000);

    // any other error at once
    tries = 0;
    const other = () => {
      tries++;
      return Promise.reject(busy("ENOSPC"));
    };
    await expect(retryWhileBusy(other, Date.now() + 5_000)).rejects.toMatchObject({
      code: "ENOSPC",
    });
    expect(tries).toBe(1);
  });
});

describe("the advisory lock on Windows", () => {
  it("waits while the lock file is being deleted, and never breaks a lock over it", async () => {
    const path = join(await folder(), "file");
    for (const code of ["EPERM", "EACCES", "EBUSY"]) {
      // a holder just released: its lock file is delete pending, so creating it fails a few times
      const opened = failNext("open", "file.lock", [code, code, code]);
      expect(await withFileLock(path, () => Promise.resolve(code), { timeoutMs: 5_000 })).toBe(
        code,
      );
      expect(opened.calls.filter((call) => call.endsWith("file.lock"))).toHaveLength(4);
      // no breaking: the break guard was never touched
      expect(opened.calls.some((call) => call.endsWith(".break"))).toBe(false);
      expect((await readdir(join(path, ".."))).filter((name) => name.includes(".lock"))).toEqual(
        [],
      );
    }
  });

  it("keeps a live holder's lock while Windows refuses the waiter, then takes it", async () => {
    const path = join(await folder(), "file");
    const order: string[] = [];
    let release: () => void = () => undefined;
    const first = withFileLock(path, async () => {
      order.push("a in");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push("a out");
    });
    await vi.waitFor(() => {
      expect(order).toEqual(["a in"]);
    });
    // the waiter sees EEXIST while a holds it, then EPERM while a's lock is being deleted
    const second = withFileLock(path, () => {
      order.push("b in");
      return Promise.resolve();
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    failNext("open", "file.lock", ["EPERM", "EPERM"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["a in", "a out", "b in"]);
  });

  it("gives up at the deadline with an error naming the code and the folder", async () => {
    const home = await folder();
    const path = join(home, "file");
    const opened = failAlways("open", "file.lock", "EPERM");
    const started = Date.now();
    const failure = withFileLock(path, () => Promise.resolve(1), { timeoutMs: 100 });
    await expect(failure).rejects.toThrow(/Windows kept answering EPERM/);
    await expect(failure).rejects.toThrow(home);
    await expect(failure).rejects.toMatchObject({ cause: { code: "EPERM" } });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(opened.calls.filter((call) => call.endsWith("file.lock")).length).toBeGreaterThan(1);
    expect(opened.calls.some((call) => call.endsWith(".break"))).toBe(false);
  });

  it("never judges a dead holder's lock while creating it is busy", async () => {
    const home = await folder();
    const path = join(home, "file");
    await writeFile(`${path}.lock`, "999999:dead");
    // while Windows refuses the lock file, nothing is read or broken, however dead it looks
    const opened = failAlways("open", "file.lock", "EPERM");
    await expect(withFileLock(path, () => Promise.resolve(1), { timeoutMs: 100 })).rejects.toThrow(
      /Windows kept answering EPERM/,
    );
    expect(opened.calls.some((call) => call.endsWith(".break"))).toBe(false);
    expect(await readFile(`${path}.lock`, "utf8")).toBe("999999:dead");
    // once it stops, the dead lock is broken as usual
    const later = failNext("open", "file.lock", ["EPERM", "EPERM"]);
    expect(await withFileLock(path, () => Promise.resolve(2), { timeoutMs: 5_000 })).toBe(2);
    const firstBreak = later.calls.findIndex((call) => call.endsWith(".break"));
    expect(firstBreak).toBeGreaterThan(2);
    expect(await readdir(home)).toEqual([]);
  });

  it("stops retrying removals under the break guard before the guard could look stale", async () => {
    const home = await folder();
    const path = join(home, "file");
    const lock = `${path}.lock`;
    const guard = `${lock}.break`;
    await writeFile(lock, "999999:dead");
    const opened = failNext("open", "never", []);
    // the dead lock can't be removed for now: breaker A retries under its guard
    const removals = failAlways("rm", "file.lock", "EPERM");
    const breakerA = withFileLock(path, () => Promise.resolve("A"), { timeoutMs: 2_500 });
    await vi.waitFor(() => {
      expect(removals.calls.filter((call) => call === lock).length).toBeGreaterThan(1);
    });
    // breaker B comes along later and, as breakLock does, takes A's guard once it looks stale
    // (two seconds) or finds none, and removes the dead lock; then waiter W takes the lock
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const info = await stat(guard).catch(() => null);
    let waiterHolds = false;
    if (info === null || Date.now() - info.mtimeMs > 2_000) {
      await actual.rm(guard, { force: true });
      if ((await actual.readFile(lock, "utf8").catch(() => null)) === "999999:dead") {
        await actual.rm(lock, { force: true });
      }
      const handle = await actual.open(lock, "wx").catch(() => null);
      if (handle !== null) {
        await handle.writeFile(`${String(process.ppid)}:waiter`);
        await handle.close();
        waiterHolds = true;
      }
    }
    // the removals work again: had A still been retrying, it would now remove W's live lock and
    // take it too
    vi.mocked(fs.rm).mockImplementation(actual.rm);
    if (waiterHolds) {
      await expect(breakerA).rejects.toThrow(/Another knowtarium process/);
      expect(await readFile(lock, "utf8")).toBe(`${String(process.ppid)}:waiter`);
    } else {
      expect(await breakerA).toBe("A");
    }

    // and A never retried a removal past the first half of its guard's two seconds
    const guards = opened.times.filter((_, index) => opened.calls[index] === guard);
    expect(guards.length).toBeGreaterThan(1);
    removals.calls.forEach((call, index) => {
      if (call !== lock) return;
      const at = removals.times[index] ?? 0;
      const taken = Math.max(...guards.filter((time) => time <= at));
      expect(at - taken).toBeLessThan(1_500);
    });
  }, 15_000);

  it("doesn't retry removing a stale break guard another breaker is removing", async () => {
    const home = await folder();
    const path = join(home, "file");
    const guard = `${path}.lock.break`;
    await writeFile(`${path}.lock`, "999999:dead");
    await writeFile(guard, "1");
    const old = new Date(Date.now() - 10_000);
    await utimes(guard, old, old);
    const removals = failAlways("rm", ".break", "EPERM");
    const started = Date.now();
    await expect(withFileLock(path, () => Promise.resolve(1), { timeoutMs: 300 })).rejects.toThrow(
      /Another knowtarium process/,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    // one removal per look, none of them retried for long
    expect(removals.calls.filter((call) => call === guard).length).toBeLessThan(40);
  });

  it("counts a break guard being deleted as another breaker at work", async () => {
    const home = await folder();
    const path = join(home, "file");
    await writeFile(`${path}.lock`, "999999:dead");
    const opened = failNext("open", "file.lock.break", ["EPERM", "EBUSY"]);
    expect(await withFileLock(path, () => Promise.resolve(2), { timeoutMs: 5_000 })).toBe(2);
    expect(opened.calls.filter((call) => call.endsWith(".break"))).toHaveLength(3);
    expect((await readdir(home)).filter((name) => name.includes(".lock"))).toEqual([]);
  });

  it("releases its own lock through a moment's busy read and removal", async () => {
    const home = await folder();
    const path = join(home, "file");
    await withFileLock(path, () => {
      failNext("readFile", "file.lock", ["EBUSY", "EPERM"]);
      failNext("rm", "file.lock", ["EPERM", "EACCES"]);
      return Promise.resolve();
    });
    expect(await readdir(home)).toEqual([]);
  });
});

describe("the lock's own files", () => {
  it("never let a release that fails replace the result or error, and say so once", async () => {
    const home = await folder();
    const path = join(home, "file");
    const warnings = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // still busy at the release's bound (one second, with a six-second stale time)
    const release = () => failAlways("rm", /file\.lock$/, "EPERM");
    const result = withFileLock(
      path,
      () => {
        release();
        return Promise.resolve(7);
      },
      { staleMs: 6_000 },
    );
    expect(await result).toBe(7);
    await actual.rm(`${path}.lock`, { force: true });
    const failure = withFileLock(
      path,
      () => {
        release();
        return Promise.reject(new Error("the run's own error"));
      },
      { staleMs: 6_000 },
    );
    await expect(failure).rejects.toThrow("the run's own error");
    // elsewhere a real permission error on release is kept quiet the same way
    pretend("linux");
    await actual.rm(`${path}.lock`, { force: true });
    expect(
      await withFileLock(path, () => {
        failAlways("rm", /file\.lock$/, "EACCES");
        return Promise.resolve(8);
      }),
    ).toBe(8);
    const said = warnings.mock.calls.map(([text]) => String(text));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/couldn't remove .*file\.lock \(EPERM\); it counts as free once/);
  });

  it("never remove a break guard another breaker has taken since", async () => {
    const home = await folder();
    const path = join(home, "file");
    const lock = `${path}.lock`;
    const guard = `${lock}.break`;
    await writeFile(lock, "999999:dead");
    // while this breaker removes the dead lock, another takes its guard as stale and writes its own
    const rm = actual.rm as (...args: unknown[]) => Promise<void>;
    vi.mocked(fs.rm).mockImplementation(async (...args: unknown[]) => {
      if (args[0] === lock && (await actual.readFile(guard, "utf8")) !== "2:other") {
        await actual.writeFile(guard, "2:other");
        throw busy("EPERM");
      }
      return rm(...args);
    });
    expect(await withFileLock(path, () => Promise.resolve(1), { timeoutMs: 5_000 })).toBe(1);
    expect(await readFile(guard, "utf8")).toBe("2:other");
    expect(await readdir(home)).toEqual(["file.lock.break"]);
  });

  it("never remove a stale break guard that was replaced while it was judged", async () => {
    const home = await folder();
    const path = join(home, "file");
    const guard = `${path}.lock.break`;
    await writeFile(`${path}.lock`, "999999:dead");
    await writeFile(guard, "1:stale");
    const old = new Date(Date.now() - 10_000);
    await utimes(guard, old, old);
    // between its stat and its removal, another breaker removed it and took a fresh one
    let reads = 0;
    const read = actual.readFile as (...args: unknown[]) => Promise<unknown>;
    vi.mocked(fs.readFile).mockImplementation((async (...args: unknown[]) => {
      if (args[0] === guard && ++reads === 2) await actual.writeFile(guard, "2:fresh");
      return read(...args);
    }) as never);
    const removals = failNext("rm", "never", []);
    pretend("linux");
    await expect(withFileLock(path, () => Promise.resolve(1), { timeoutMs: 300 })).rejects.toThrow(
      /Another knowtarium process/,
    );
    expect(removals.calls).not.toContain(guard);
    expect(await readFile(guard, "utf8")).toBe("2:fresh");
  });
});

describe("the lock elsewhere", () => {
  it("reports EPERM at once: there it is a real permission error", async () => {
    pretend("linux");
    const path = join(await folder(), "file");
    failNext("open", "file.lock", ["EPERM"]);
    const run = vi.fn(() => Promise.resolve(1));
    await expect(withFileLock(path, run, { timeoutMs: 5_000 })).rejects.toMatchObject({
      code: "EPERM",
    });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("file writes and reads on Windows", () => {
  it("retry a rename Windows refuses while another process has the file open", async () => {
    const home = await folder();
    const path = join(home, "trust.json");
    await writeFile(path, "old");
    const renamed = failNext("rename", "trust.json", ["EPERM", "EACCES", "EBUSY"]);
    await writePrivateFile(path, "new");
    expect(renamed.calls).toHaveLength(4);
    expect(await readFile(path, "utf8")).toBe("new");
    expect(await readdir(home)).toEqual(["trust.json"]);
  });

  it("give up on a rename at the deadline, keeping the old file and no temporary", async () => {
    const home = await folder();
    const path = join(home, "trust.json");
    await writeFile(path, "old");
    const renamed = failAlways("rename", "trust.json", "EPERM");
    // a clock that runs a second per look, so the five-second budget runs out in a few tries
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => (now += 1_000));
    await expect(writePrivateFile(path, "new")).rejects.toMatchObject({ code: "EPERM" });
    expect(renamed.calls.length).toBeGreaterThan(1);
    expect(await readFile(path, "utf8")).toBe("old");
    expect(await readdir(home)).toEqual(["trust.json"]);
  });

  it("report the write's own error when removing the temporary fails too", async () => {
    const home = await folder();
    const path = join(home, "trust.json");
    failAlways("rename", "trust.json", "ENOSPC");
    failAlways("rm", /\.tmp$/, "EIO");
    await expect(writePrivateFile(path, "new")).rejects.toMatchObject({ code: "ENOSPC" });
  });

  it("never retry a rename over another app's file, which it may be saving right then", async () => {
    const home = await folder();
    const path = join(home, "mcp.json");
    await writeFile(path, "theirs");
    const renamed = failNext("rename", "mcp.json", ["EPERM"]);
    await expect(replaceFile(path, "ours")).rejects.toMatchObject({ code: "EPERM" });
    expect(renamed.calls).toHaveLength(1);
    expect(await readFile(path, "utf8")).toBe("theirs");
    expect(await readdir(home)).toEqual(["mcp.json"]);
  });

  it("keep a backup of an agent's config that can't be removed, and go on", async () => {
    const home = await folder();
    const targets = agentTargets(cliEnvironment({}, "linux", home)).filter(
      (target) => target.id === "cursor",
    );
    await actual.mkdir(join(home, ".cursor"));
    await writeFile(join(home, ".cursor", "mcp.json"), "{}");
    failAlways("rm", /knowtarium-backup-/, "EBUSY");
    for (let version = 1; version <= 5; version++) {
      const results = await configureAgents(
        targets,
        serverCommand(`1.0.${String(version)}`, "linux"),
        {
          now: () => new Date(Date.UTC(2026, 9, 1, 12, version)),
        },
      );
      expect(results.map((result) => result.status)).toEqual([version === 1 ? "added" : "updated"]);
    }
    const backups = (await readdir(join(home, ".cursor"))).filter((name) =>
      name.includes("knowtarium-backup-"),
    );
    // one per run, none pruned
    expect(backups).toHaveLength(5);
    expect(await readFile(join(home, ".cursor", "mcp.json"), "utf8")).toContain("knowtarium@1.0.5");
  });

  it("skip an agent whose config is in use, and still configure the others", async () => {
    const home = await folder();
    const targets = agentTargets(cliEnvironment({}, "linux", home)).filter((target) =>
      ["cursor", "codex"].includes(target.id),
    );
    await actual.mkdir(join(home, ".cursor"));
    await actual.mkdir(join(home, ".codex"));
    await writeFile(join(home, ".cursor", "mcp.json"), "{}");
    failAlways("rename", join(".cursor", "mcp.json"), "EPERM");
    const results = await configureAgents(targets, serverCommand("1.0.0", "linux"));
    expect(results.map((result) => [result.agent, result.status])).toEqual([
      ["cursor", "skipped"],
      ["codex", "added"],
    ]);
    expect(results[0]?.reason).toBe(
      `couldn't write ${results[0]?.path ?? ""} (in use); run \`npx knowtarium agents\` again.`,
    );
    expect(results[0]?.path.endsWith(join(".cursor", "mcp.json"))).toBe(true);
    expect(await readFile(join(home, ".cursor", "mcp.json"), "utf8")).toBe("{}");
    expect(await readFile(join(home, ".codex", "config.toml"), "utf8")).toContain(
      "knowtarium@1.0.0",
    );
  });

  it("read a file being deleted as missing once it is gone", async () => {
    const home = await folder();
    failNext("readFile", "gone", ["EPERM", "EPERM"]);
    expect(await readIfExists(join(home, "gone"))).toBeNull();
    // elsewhere an EACCES is reported at once
    pretend("linux");
    failNext("readFile", "locked", ["EACCES"]);
    await expect(readIfExists(join(home, "locked"))).rejects.toMatchObject({ code: "EACCES" });
  });

  it("retry removing a cache entry or the credentials while the file is busy", async () => {
    const home = await folder();
    const cache = new FileCacheAdapter(join(home, "cache"));
    await cache.put("ws/ws_1/cursor", new Uint8Array([1]));
    failNext("rm", "cursor", ["EBUSY", "EPERM"]);
    await cache.delete("ws/ws_1/cursor");
    expect(await cache.get("ws/ws_1/cursor")).toBeUndefined();

    const credentials = new Credentials(join(home, "knowtarium"), new MemorySecretStore());
    await credentials.put({
      apiUrl: "https://api.test",
      workspaceId: "ws_00000000000000000000000001",
      tokenId: "tok_00000000000000000000000001",
      tokenSecret: `kta_${"s".repeat(43)}`,
      access: "read-write",
      folderIds: [],
      agentPrivateKey: "A".repeat(43),
      ownerId: "acc_00000000000000000000000001",
      ownerSignPublicKey: "B".repeat(43),
      connectedAt: "2026-10-01T12:00:00.000Z",
    });
    failNext("rm", "credentials.enc", ["EPERM"]);
    await credentials.remove("ws_00000000000000000000000001");
    expect(await readdir(join(home, "knowtarium"))).toEqual([]);
  });
});
