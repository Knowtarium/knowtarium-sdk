import { type Actor, addVerified, removeVerified, setGenerated } from "../frontmatter/index.js";
import { parseNote } from "../note/index.js";
import { claimsHuman } from "../trust/index.js";

/** How a restore marks the person's change. */
export interface RestoreOptions {
  /**
   * Whether the save adds the person's `verified` entry too, like any edit of theirs in a folder
   * that asks for review (default true). Pass false where agents apply changes directly: the
   * restore is still the person's change (`generated`), without a check of its own.
   */
  readonly verify?: boolean;
  /**
   * Whether the old version's `human:` entries in `verified` go (default false). Pass true when no
   * person wrote that version (an agent's): the person signing the restore never signed those
   * entries, so their write must not carry them. Agents' entries stay.
   */
  readonly stripHumanEntries?: boolean;
}

/**
 * The text a person saves to restore an old version: the old version as it was, marked as the
 * person's change (`generated` set to them now, and, unless `verify` is false, their `verified`
 * entry added in the same save, like any edit of theirs), without its `human:` `verified`
 * entries when `stripHumanEntries` says so. Save it as a new signed version on top of the current
 * one; the old versions stay in history. Throws `FrontmatterEditError` when the old frontmatter
 * can't be edited.
 */
export function restoreText(
  oldText: string,
  actor: Actor,
  at: Date | string,
  options: RestoreOptions = {},
): string {
  const old = parseNote(oldText);
  const kept =
    options.stripHumanEntries === true
      ? removeVerified(old, (entry) => entry.by !== null && claimsHuman(entry.by))
      : old;
  const note = setGenerated(kept, actor, at);
  return options.verify === false ? note.text : addVerified(note, actor, at).text;
}
