import { appendPair, commit, findPair, openForEdit } from "../frontmatter/edit.js";
import { flowEntry } from "../frontmatter/entry.js";
import {
  hasOnlyRepeatedKeys,
  removeVerified,
  type VerifiedEntryFields,
} from "../frontmatter/verified.js";
import { documentOf } from "../note/document.js";
import { parseNote } from "../note/parse.js";
import { claimsHuman } from "../trust/provenance.js";

/** A `human:` entry a signed write confirms: who and when. */
export interface ConfirmedEntry {
  readonly by: string;
  readonly at: string;
}

/** What to do with a `human:` entry nothing signed: drop it, or keep it apart, marked. */
export type UnconfirmedHumanEntries = "strip" | "annotate";

/** The key `annotate` keeps unconfirmed entries under (OKF readers ignore it). */
export const UNCONFIRMED_KEY = "unconfirmed_verified";

const key = (by: string, at: string | null): string => {
  const time = at === null ? Number.NaN : Date.parse(at);
  return `${by} ${Number.isNaN(time) ? (at ?? "") : String(time)}`;
};

/**
 * A note text without the `human:` entries in `verified` that `confirmed` doesn't list (matched by
 * actor and instant): stripped, or with `annotate` moved to an `unconfirmed_verified` list so the
 * text still shows them without an OKF reader trusting them. Entries are read exactly like
 * `readProvenance` reads them; when they can't be removed one by one, the whole `verified` field
 * goes (`removeVerified`), and frontmatter with a key written twice loses every `verified` pair
 * (then nothing is annotated). Everything else stays as written. Only a note whose frontmatter
 * can't be parsed at all (invalid YAML beyond a repeated key) is returned as it is: no OKF reader
 * can read its entries either. One whose `verified` can't be removed (another field shares its
 * anchor) throws a `FrontmatterEditError`; `exportBundle` leaves such a note out and reports it.
 */
export function withoutUnconfirmedHumanEntries(
  text: string,
  confirmed: readonly ConfirmedEntry[],
  mode: UnconfirmedHumanEntries,
): string {
  const note = parseNote(text);
  if (note.frontmatter === null || !hasOnlyRepeatedKeys(documentOf(note.frontmatter))) return text;
  const known = new Set(confirmed.map((entry) => key(entry.by, entry.at)));
  const dropped: VerifiedEntryFields[] = [];
  const stripped = removeVerified(note, (entry) => {
    const drop = entry.by !== null && claimsHuman(entry.by) && !known.has(key(entry.by, entry.at));
    if (drop) dropped.push(entry);
    return drop;
  });
  if (mode === "strip" || dropped.length === 0) return stripped.text;
  // a key written twice still: the entries are only stripped (an edit can't add a field there)
  if (stripped.frontmatter === null || documentOf(stripped.frontmatter).errors.length > 0) {
    return stripped.text;
  }
  const context = openForEdit(stripped);
  // an existing list is left alone: the entries are then only stripped
  if (findPair(context.map, UNCONFIRMED_KEY) !== undefined) return stripped.text;
  const list = `[${dropped
    .map((entry) =>
      flowEntry([
        ["by", entry.by ?? ""],
        ["at", entry.at ?? ""],
      ]),
    )
    .join(", ")}]`;
  return commit(
    context,
    [appendPair(context, UNCONFIRMED_KEY, list)],
    [UNCONFIRMED_KEY],
    (data) =>
      Array.isArray(data[UNCONFIRMED_KEY]) && data[UNCONFIRMED_KEY].length === dropped.length,
  ).text;
}
