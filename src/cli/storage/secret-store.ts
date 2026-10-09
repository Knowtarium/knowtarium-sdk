import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import { readIfExists, writePrivateFile } from "./files.js";

/** Where the CLI keeps small secrets: the OS keychain, or a private file where there is none. */
export interface SecretStore {
  /** `keychain` or `file`, for `knowtarium status`. */
  readonly kind: "keychain" | "file" | "memory";
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

const SERVICE = "knowtarium";

interface KeyringEntry {
  getPassword(): string | null | undefined;
  setPassword(password: string): void;
  deletePassword(): boolean;
}
interface KeyringModule {
  Entry: new (service: string, account: string) => KeyringEntry;
}

/**
 * The keychain account names are scoped by the CLI's folder (`KNOWTARIUM_HOME`), so two setups on
 * one machine (a test run, a second profile) never share or overwrite each other's keys.
 */
function scopeOf(home: string): string {
  return createHash("sha256").update(resolve(home)).digest("hex").slice(0, 16);
}

/**
 * The OS keychain (macOS Keychain, Windows Credential Manager, the Secret Service on Linux) via
 * `@napi-rs/keyring`, which ships prebuilt binaries, so nothing is compiled on install.
 */
export class KeychainSecretStore implements SecretStore {
  readonly kind = "keychain";

  private constructor(
    private readonly keyring: KeyringModule,
    private readonly scope: string,
  ) {}

  /**
   * The keychain, or null when it can't be loaded or used (no Secret Service, a container). It
   * finds out by reading this setup's own entry, never by writing a probe.
   */
  static async open(home: string): Promise<KeychainSecretStore | null> {
    try {
      const keyring = (await import("@napi-rs/keyring")) as unknown as KeyringModule;
      const store = new KeychainSecretStore(keyring, scopeOf(home));
      store.entry("credentials-key").getPassword();
      return store;
    } catch {
      return null;
    }
  }

  private entry(name: string): KeyringEntry {
    return new this.keyring.Entry(SERVICE, `${name}@${this.scope}`);
  }

  get(name: string): Promise<string | null> {
    try {
      return Promise.resolve(this.entry(name).getPassword() ?? null);
    } catch {
      return Promise.resolve(null);
    }
  }

  set(name: string, value: string): Promise<void> {
    this.entry(name).setPassword(value);
    return Promise.resolve();
  }

  delete(name: string): Promise<void> {
    try {
      this.entry(name).deletePassword();
    } catch {
      // already gone
    }
    return Promise.resolve();
  }
}

/**
 * The fallback where no keychain works: a JSON file readable only by the user (mode 0600) in the
 * CLI's folder. It protects against other users on the machine, not against the user's own
 * processes; `knowtarium status` says when it is in use.
 */
export class FileSecretStore implements SecretStore {
  readonly kind = "file";
  private readonly path: string;

  constructor(home: string) {
    this.path = join(home, "secrets.json");
  }

  private async read(): Promise<Record<string, string>> {
    const bytes = await readIfExists(this.path);
    if (bytes === null) return {};
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, string>) : {};
  }

  async get(name: string): Promise<string | null> {
    return (await this.read())[name] ?? null;
  }

  async set(name: string, value: string): Promise<void> {
    await writePrivateFile(this.path, JSON.stringify({ ...(await this.read()), [name]: value }));
  }

  async delete(name: string): Promise<void> {
    const rest = Object.entries(await this.read()).filter(([key]) => key !== name);
    await writePrivateFile(this.path, JSON.stringify(Object.fromEntries(rest)));
  }
}

/** A store in memory, for tests. */
export class MemorySecretStore implements SecretStore {
  readonly kind = "memory";
  readonly values = new Map<string, string>();

  get(name: string): Promise<string | null> {
    return Promise.resolve(this.values.get(name) ?? null);
  }

  set(name: string, value: string): Promise<void> {
    this.values.set(name, value);
    return Promise.resolve();
  }

  delete(name: string): Promise<void> {
    this.values.delete(name);
    return Promise.resolve();
  }
}

/**
 * The keychain when it works, else the private file. `KNOWTARIUM_KEYCHAIN=off` forces the file
 * (for servers and containers without a keychain).
 */
export async function openSecretStore(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SecretStore> {
  if (env["KNOWTARIUM_KEYCHAIN"] !== "off") {
    const keychain = await KeychainSecretStore.open(home);
    if (keychain !== null) return keychain;
  }
  return new FileSecretStore(home);
}
