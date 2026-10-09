import { removeVerified } from "../../core/frontmatter/index.js";
import { parseNote } from "../../core/note/index.js";
import { claimsHuman, readProvenance } from "../../core/trust/index.js";

/** A `human:` entry's identity: who and when (the instant, so a reformatted time still matches). */
function entryKey(by: string, at: string | null): string {
  const time = at === null ? Number.NaN : Date.parse(at);
  return `${by} ${Number.isNaN(time) ? (at ?? "") : String(time)}`;
}

/**
 * A proposal's text without the `human:` entries in `verified` that its base version didn't have:
 * only a person signs as `human:`, and an agent's proposal can't add such an entry (the web app
 * runs it on the approve path, before adding the person's own entry). Entries the base already had
 * stay, and so does everything else in the text. `baseText` is null for a proposed new note.
 * Entries are read exactly like `readProvenance` reads them (trimmed, aliases resolved, a single
 * map as one entry); when they can't be removed one by one, the whole `verified` field goes.
 * Throws a `FrontmatterEditError` when not even that is possible (invalid YAML, a shared anchor).
 */
export function stripForeignHumanEntries(baseText: string | null, proposedText: string): string {
  const base = new Set(
    baseText === null
      ? []
      : readProvenance(parseNote(baseText).frontmatter?.data ?? {})
          .verified.filter((entry) => entry.kind === "human")
          .map((entry) => entryKey(entry.by, entry.at)),
  );
  const proposal = parseNote(proposedText);
  if (proposal.frontmatter === null) return proposedText;
  return removeVerified(
    proposal,
    (entry) =>
      entry.by !== null && claimsHuman(entry.by) && !base.has(entryKey(entry.by, entry.at)),
  ).text;
}
