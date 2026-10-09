import { isCryptoError } from "../../crypto/index.js";
import type { NoteId } from "../../protocol/index.js";
import type { QuarantineEntry } from "../cache/index.js";
import { isVaultError } from "../errors/index.js";
import type { SyncContext } from "./context.js";

/** Whether an error means the data failed a check (as opposed to the network or the server). */
export function isIntegrityError(error: unknown): boolean {
  return isVaultError(error) || isCryptoError(error);
}

function reasonOf(error: unknown): string {
  return isVaultError(error) || isCryptoError(error) ? error.code : "unknown";
}

/**
 * Notes whose newest version failed verification. They are never shown as current; the engine
 * reports the set (`quarantine` events and `SyncEngine.quarantined`), keeps it in the cache, and
 * tries each note again on every pull until a verified version arrives.
 */
export class Quarantine {
  private readonly notes = new Map<NoteId, QuarantineEntry>();

  constructor(private readonly context: Omit<SyncContext, "quarantine">) {}

  /** The quarantined notes. */
  list(): QuarantineEntry[] {
    return [...this.notes.values()];
  }

  has(noteId: NoteId): boolean {
    return this.notes.has(noteId);
  }

  /** Restores the set kept in the cache. */
  async load(): Promise<void> {
    const cached = await this.context.cache?.quarantine(this.context.workspaceId);
    for (const entry of cached ?? []) this.notes.set(entry.noteId, entry);
    if (this.notes.size > 0) this.report();
  }

  /** Quarantines a note version that failed a check, and reports the error. */
  async add(noteId: NoteId, version: number, error: unknown): Promise<void> {
    this.notes.set(noteId, { noteId, version, reason: reasonOf(error) });
    this.context.emitter.emit({ type: "error", error, noteId });
    await this.save();
  }

  /** Releases a note once a verified version of it was accepted. */
  async release(noteId: NoteId): Promise<void> {
    if (!this.notes.delete(noteId)) return;
    await this.save();
  }

  private async save(): Promise<void> {
    await this.context.cache?.setQuarantine(this.context.workspaceId, this.list());
    this.report();
  }

  private report(): void {
    this.context.emitter.emit({ type: "quarantine", notes: this.list() });
  }
}
