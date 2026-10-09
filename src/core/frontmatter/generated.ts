import type { ParsedNote } from "../note/types.js";
import { type Actor, assertActor, formatTimestamp } from "./actor.js";
import { appendPair, commit, findPair, openForEdit } from "./edit.js";
import { type EntryFields, flowEntry, updateEntry } from "./entry.js";
import { replaceValue } from "./source.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Records who made the current change and when: sets `generated.by` and `generated.at`. An
 * existing `generated` mapping keeps its style, quoting, comments and any other keys; a missing one
 * is added as `generated: { by: ..., at: ... }` at the end of the frontmatter.
 */
export function setGenerated(note: ParsedNote, actor: Actor, at: Date | string): ParsedNote {
  const by = assertActor(actor);
  const time = formatTimestamp(at);
  const fields: EntryFields = [
    ["by", by],
    ["at", time],
  ];
  const context = openForEdit(note);
  const pair = findPair(context.map, "generated");
  const splices =
    pair === undefined
      ? [appendPair(context, "generated", flowEntry(fields))]
      : (updateEntry(context.source, pair.value, fields, context.eol) ?? [
          replaceValue(context.source, pair, flowEntry(fields)),
        ]);
  return commit(context, splices, ["generated"], (data) => {
    const generated = data["generated"];
    return isRecord(generated) && generated["by"] === by && generated["at"] === time;
  });
}
