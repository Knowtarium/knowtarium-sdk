import { parseNote } from "../note/index.js";
import type { ParsedNote } from "../note/index.js";
import { type DiffLimits, mergeLines } from "./diff3.js";
import { mergeFrontmatter } from "./frontmatter-merge.js";
import { splitLines } from "./lines.js";

/** A part of the note that both sides changed differently. */
export interface MergeConflict {
  /** Where: a frontmatter field, or lines of the body (or of the whole note when it has no usable frontmatter). */
  readonly region: "frontmatter" | "body";
  /** The frontmatter field, for a field conflict. */
  readonly field?: string;
  /** The text on each side; `null` where a field is absent. */
  readonly base: string | null;
  readonly mine: string | null;
  readonly theirs: string | null;
}

/** A stretch of the merged note, in order: agreed text, or a conflict. */
export type NoteMergeHunk =
  | { readonly kind: "resolved"; readonly text: string }
  | ({ readonly kind: "conflict" } & MergeConflict);

/** The three-way merge of a note, for the 409 conflict screen. */
export interface NoteMerge {
  readonly hunks: readonly NoteMergeHunk[];
  /** The conflicts, in order (the same objects as in `hunks`). */
  readonly conflicts: readonly (NoteMergeHunk & { kind: "conflict" })[];
  /** The merged note when nothing conflicts, else null. */
  readonly text: string | null;
}

/** The three sides of a 409: the version the edit started from, the edit, and the current one. */
export interface MergeInput {
  /** The version both sides started from; null when both created the note. */
  readonly base: string | null;
  /** This client's edit. */
  readonly mine: string;
  /** The version now current on the server. */
  readonly theirs: string;
  /**
   * True when the sides had a base that can't be read any more (its content was removed after the
   * workspace's history period): `base` is ignored and the merge is two-way. Nothing one side has
   * is taken for granted, so every difference is a conflict (with `base` null in it).
   */
  readonly baseUnknown?: boolean;
}

function linesHunks(
  base: string | null,
  mine: string,
  theirs: string,
  limits: DiffLimits,
): NoteMergeHunk[] {
  // an unknown base merges against nothing: whatever differs is one conflict, nothing is taken
  return mergeLines(splitLines(base ?? ""), splitLines(mine), splitLines(theirs), limits).map(
    (hunk) =>
      hunk.kind === "resolved"
        ? hunk
        : { ...hunk, region: "body" as const, ...(base === null ? { base: null } : {}) },
  );
}

/** A note is merged field by field only when all three have readable, closed frontmatter. */
function usable(note: ParsedNote | null): boolean {
  return note === null || (note.frontmatter !== null && note.problems.length === 0);
}

function finish(hunks: NoteMergeHunk[]): NoteMerge {
  const joined: NoteMergeHunk[] = [];
  for (const hunk of hunks) {
    const last = joined.at(-1);
    if (hunk.kind === "resolved" && last?.kind === "resolved") {
      joined[joined.length - 1] = { kind: "resolved", text: last.text + hunk.text };
    } else if (hunk.kind === "conflict" || hunk.text !== "") joined.push(hunk);
  }
  const conflicts = joined.filter(
    (hunk): hunk is NoteMergeHunk & { kind: "conflict" } => hunk.kind === "conflict",
  );
  const text =
    conflicts.length === 0
      ? joined.map((hunk) => (hunk.kind === "resolved" ? hunk.text : "")).join("")
      : null;
  return { hunks: joined, conflicts, text };
}

/**
 * Merges the two sides of a 409 against their common base. The frontmatter is merged field by
 * field (see `mergeFrontmatter`: one-sided changes are taken byte for byte, both sides' new
 * `verified` checks are kept), and the body line by line (diff3). Where the frontmatter can't be
 * read on some side, the whole note is merged line by line. The result keeps theirs' fences and
 * line endings; conflicts are left for the person to resolve (`resolveMerge`). Lines that differ
 * only in their line ending don't conflict. Merged fields that together don't parse as YAML make
 * the whole frontmatter one conflict. A diff too large for `limits` makes its region one
 * conflict; run merges of long notes in a Web Worker so the page stays responsive. With
 * `baseUnknown` the merge is two-way: fields that differ or that one side lacks, and the body
 * where it differs, are conflicts.
 */
export function mergeNotes(input: MergeInput, limits: DiffLimits = {}): NoteMerge {
  const unknown = input.baseUnknown === true;
  const mine = parseNote(input.mine);
  const theirs = parseNote(input.theirs);
  const base = input.base === null || unknown ? null : parseNote(input.base);
  // the text the whole note merges against when it isn't merged field by field
  const baseText = unknown ? null : (input.base ?? "");
  const theirsFrontmatter = theirs.frontmatter;
  if (
    !usable(base) ||
    !usable(mine) ||
    theirsFrontmatter === null ||
    theirs.problems.length > 0 ||
    mine.frontmatter === null
  ) {
    return finish(linesHunks(baseText, input.mine, input.theirs, limits));
  }
  const fields = mergeFrontmatter(
    unknown ? null : (base?.frontmatter?.source ?? ""),
    mine.frontmatter.source,
    theirsFrontmatter.source,
    theirs.eol,
  );
  if (fields === null) return finish(linesHunks(baseText, input.mine, input.theirs, limits));
  const mergedFields: NoteMergeHunk[] = fields.map((field) =>
    field.kind === "resolved" ? field : { ...field, region: "frontmatter" },
  );
  // fields that merged cleanly must still make valid YAML together (no duplicate keys, say)
  const clean = mergedFields.every((field) => field.kind === "resolved");
  const mergedSource = mergedFields
    .map((field) => (field.kind === "resolved" ? field.text : ""))
    .join("");
  const frontmatterHunks: NoteMergeHunk[] =
    clean && parseNote(`---${theirs.eol}${mergedSource}---${theirs.eol}`).problems.length > 0
      ? [
          {
            kind: "conflict",
            region: "frontmatter",
            base: base?.frontmatter?.source ?? null,
            mine: mine.frontmatter.source,
            theirs: theirsFrontmatter.source,
          },
        ]
      : mergedFields;
  const fenceEnd = theirsFrontmatter.offset + theirsFrontmatter.source.length;
  const hunks: NoteMergeHunk[] = [
    { kind: "resolved", text: theirs.text.slice(0, theirsFrontmatter.offset) },
    ...frontmatterHunks,
    { kind: "resolved", text: theirs.text.slice(fenceEnd, theirs.bodyOffset) },
    ...linesHunks(unknown ? null : (base?.body ?? ""), mine.body, theirs.body, limits),
  ];
  return finish(hunks);
}

/** How to settle one conflict: one side's text, or text the person wrote. */
export type ConflictChoice = "mine" | "theirs" | "base" | { readonly text: string };

/**
 * The note with every conflict settled by `choose` (called once per conflict, in order). For a
 * frontmatter field, a side where the field is absent leaves it out. Parse the result before
 * saving: text the person wrote can still be invalid YAML.
 */
export function resolveMerge(
  merge: NoteMerge,
  choose: (conflict: MergeConflict, index: number) => ConflictChoice,
): string {
  let index = 0;
  return merge.hunks
    .map((hunk) => {
      if (hunk.kind === "resolved") return hunk.text;
      const choice = choose(hunk, index++);
      const text = typeof choice === "string" ? hunk[choice] : choice.text;
      return text ?? "";
    })
    .join("");
}

/**
 * The note with git-style conflict markers around each conflict (mine, base, theirs), for an
 * editor that shows the conflicts inline.
 */
export function withConflictMarkers(merge: NoteMerge, eol = "\n"): string {
  const block = (text: string | null) =>
    text === null || text === "" ? "" : text.endsWith("\n") ? text : text + eol;
  return merge.hunks
    .map((hunk) =>
      hunk.kind === "resolved"
        ? hunk.text
        : `<<<<<<< mine${eol}${block(hunk.mine)}||||||| base${eol}${block(hunk.base)}=======${eol}${block(hunk.theirs)}>>>>>>> theirs${eol}`,
    )
    .join("");
}
