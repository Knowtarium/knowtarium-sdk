import { verifyEnvelopeFor } from "../../crypto/index.js";
import type { NoteEvent, NoteId, SignedEvent } from "../../protocol/index.js";
import { isVersionWrite, type TrustedSigner, toSignedEnvelope } from "../vault/verify.js";

/**
 * A person's signed write of a note (`edited` or `approved`), verified against the trusted key:
 * it confirms the `human:<by>` entry at exactly `at` in that version and every later one (the rule
 * the web app and the CLI share). An applied check (`check_applied`) is never one.
 */
export interface Confirmation {
  /** The version the write made. */
  readonly version: number;
  /** The account that signed it. */
  readonly by: string;
  /** The envelope's `createdAt`. */
  readonly at: string;
}

/**
 * The most signed writes kept per note (the newest), in memory and in the cache: a person's, and
 * apart from them the applied checks and agents' writes.
 */
const KEPT_PER_NOTE = 50;

/**
 * The confirmation a signed write gives, once its signature verifies against `signer` for this
 * workspace and note: an `edited` or `approved` envelope (never `check_applied`). Null otherwise.
 */
export function confirmationOf(
  signed: SignedEvent | null | undefined,
  expected: {
    readonly workspaceId: string;
    readonly noteId: string;
    readonly signer: TrustedSigner;
  },
): Confirmation | null {
  if (signed == null) return null;
  const fields = signed.envelope;
  if (fields.type !== "edited" && fields.type !== "approved") return null;
  const ok = verifyEnvelopeFor(toSignedEnvelope(signed), expected.signer.publicKey, {
    type: fields.type,
    workspaceId: expected.workspaceId,
    noteId: expected.noteId,
    ...(expected.signer.accountId === undefined ? {} : { accountId: expected.signer.accountId }),
  });
  return ok ? { version: fields.version, by: fields.accountId, at: fields.createdAt } : null;
}

/**
 * What made a version besides a person's write, as far as the engine can tell: a person's applied
 * check (`check_applied`, verified) or an agent's direct write (`agent_edited`, kept unverified on
 * purpose: it can only take confirmations away, never add one).
 */
type VersionMark = "check" | "agent";

interface KeptWrite {
  readonly signed: SignedEvent;
  readonly confirmation: Confirmation;
}

interface KeptMark {
  readonly signed: SignedEvent;
  readonly version: number;
  readonly mark: VersionMark;
}

/** Adds `value` under `key`, dropping the entry with the lowest version past `KEPT_PER_NOTE`. */
function keep<T>(
  map: Map<string, T>,
  key: string,
  value: T,
  versionOf: (entry: T) => number,
): void {
  map.set(key, value);
  if (map.size <= KEPT_PER_NOTE) return;
  const oldest = [...map.entries()].sort((a, b) => versionOf(a[1]) - versionOf(b[1]))[0];
  if (oldest !== undefined) map.delete(oldest[0]);
}

/**
 * Every verified signed write the engine has seen, per note, so a version an applied check made
 * (`check_applied`) still shows the person's earlier entries as confirmed, and which earlier
 * versions an applied check or an agent made, so an applied check on top of an agent's version
 * confirms no one. Kept with the note in the encrypted cache as the signed events themselves,
 * verified again when loaded.
 */
export class Confirmations {
  private readonly writes = new Map<NoteId, Map<string, KeptWrite>>();
  /** Kept apart from `writes`, so an agent's many versions never push a person's write out. */
  private readonly marks = new Map<NoteId, Map<string, KeptMark>>();

  constructor(
    private readonly workspaceId: string,
    private readonly signer: TrustedSigner,
  ) {}

  /**
   * Adds a signed version write: a person's (`edited`, `approved`) if it verifies, returning
   * true. Else it records what made that version, an applied check that verifies
   * (`check_applied`) or an agent's `agent_edited` for this note, and returns false: neither is a
   * person's write.
   */
  add(noteId: NoteId, signed: SignedEvent | null | undefined): boolean {
    if (signed == null) return false;
    const confirmation = confirmationOf(signed, {
      workspaceId: this.workspaceId,
      noteId,
      signer: this.signer,
    });
    if (confirmation === null) {
      this.addMark(noteId, signed);
      return false;
    }
    const known = this.writes.get(noteId) ?? new Map<string, KeptWrite>();
    keep(
      known,
      `${String(confirmation.version)} ${confirmation.at}`,
      { signed, confirmation },
      (entry) => entry.confirmation.version,
    );
    this.writes.set(noteId, known);
    return true;
  }

  private addMark(noteId: NoteId, signed: SignedEvent): void {
    const fields = signed.envelope;
    const marked =
      (fields.type === "agent_edited" && fields.noteId === noteId) ||
      (fields.type === "check_applied" && this.checkVerifies(noteId, signed));
    if (!marked) return;
    const mark: VersionMark = fields.type === "agent_edited" ? "agent" : "check";
    const known = this.marks.get(noteId) ?? new Map<string, KeptMark>();
    keep(
      known,
      `${mark} ${String(fields.version)} ${fields.createdAt}`,
      { signed, version: fields.version, mark },
      (entry) => entry.version,
    );
    this.marks.set(noteId, known);
  }

  private checkVerifies(noteId: NoteId, signed: SignedEvent): boolean {
    return verifyEnvelopeFor(toSignedEnvelope(signed), this.signer.publicKey, {
      type: "check_applied",
      workspaceId: this.workspaceId,
      noteId,
      ...(this.signer.accountId === undefined ? {} : { accountId: this.signer.accountId }),
    });
  }

  /**
   * Adds the signed version writes among history events (each matched to its event's note and
   * version): a person's writes, applied checks and agents' direct writes.
   */
  addEvents(events: readonly NoteEvent[]): void {
    for (const event of events) {
      const signed = event.signed;
      if (signed === null || event.ciphertext !== null) continue;
      const fields = signed.envelope;
      if (!isVersionWrite(fields.type) || !("version" in fields)) continue;
      if (event.noteVersion !== fields.version) continue;
      this.add(event.noteId, signed);
    }
  }

  /**
   * The confirmations of a note up to a version, oldest first. For a snapshot use
   * `confirmationsOf`: a version an agent wrote gets none.
   */
  forNote(noteId: NoteId, version: number): Confirmation[] {
    return [...(this.writes.get(noteId)?.values() ?? [])]
      .map((entry) => entry.confirmation)
      .filter((confirmation) => confirmation.version <= version)
      .sort((a, b) => a.version - b.version);
  }

  /**
   * The confirmations a snapshot of `version` shows, decided by the version's own verified event
   * (`event`, the one accepted for it):
   *
   * - an agent wrote it (`agent_edited`): none, whatever person's frontmatter it kept;
   * - an applied check made it (`check_applied`, which only writes an agent's passing check in,
   *   possibly on its own): it endorses nothing, so it shows what the last real write below it
   *   would (past consecutive applied checks). That must be a person's verified `edited` or
   *   `approved`; an agent's version there, or one the engine can't tell (no event known, or
   *   rows that disagree), gives none;
   * - else every verified person's write at or below it. A person's later signed version on top
   *   of an agent's endorses it, so its confirmations count again.
   */
  confirmationsOf(
    noteId: NoteId,
    version: number,
    event: { readonly signed: SignedEvent | null } | undefined,
  ): Confirmation[] {
    const type = event?.signed?.envelope.type;
    if (type === "agent_edited") return [];
    if (type === "check_applied" && !this.personWroteBelow(noteId, version)) return [];
    return this.forNote(noteId, version);
  }

  /**
   * Whether a person wrote the content of `version`, given its own verified event (`event`): a
   * person's `edited` or `approved`, or an applied check on top of one (as `confirmationsOf`
   * decides). False for an agent's version and whenever the engine can't tell.
   */
  personWrote(
    noteId: NoteId,
    version: number,
    event: { readonly signed: SignedEvent | null } | undefined,
  ): boolean {
    const type = event?.signed?.envelope.type;
    if (type === "edited" || type === "approved") return true;
    return type === "check_applied" && this.personWroteBelow(noteId, version);
  }

  /**
   * Whether the last version below `version` that isn't an applied check is a person's write.
   * Fails closed: an agent's row at that version (or at an applied check's on the way), a version
   * with both a person's write and an applied check, or one with neither, answers false.
   */
  private personWroteBelow(noteId: NoteId, version: number): boolean {
    const writes = [...(this.writes.get(noteId)?.values() ?? [])];
    const marks = [...(this.marks.get(noteId)?.values() ?? [])];
    for (let below = version - 1; below >= 1; below -= 1) {
      const atVersion = marks.filter((entry) => entry.version === below);
      if (atVersion.some((entry) => entry.mark === "agent")) return false;
      const person = writes.some((entry) => entry.confirmation.version === below);
      const check = atVersion.length > 0;
      if (person === check) return false;
      if (person) return true;
    }
    return false;
  }

  /** The signed events behind a note's confirmations and version marks, to keep in the cache. */
  signedFor(noteId: NoteId): SignedEvent[] {
    return [
      ...[...(this.writes.get(noteId)?.values() ?? [])].map((entry) => entry.signed),
      ...[...(this.marks.get(noteId)?.values() ?? [])].map((entry) => entry.signed),
    ];
  }
}
