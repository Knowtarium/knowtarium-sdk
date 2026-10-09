// Editing a list of strings (such as `tags`) item by item: unchanged items keep their text, their
// quoting and their comments; only added and removed items change lines.
import { isScalar, type YAMLSeq } from "yaml";

import type { LineEnding } from "../note/types.js";
import { renderScalar } from "./scalar.js";
import { columnOf, lineEndAfter, lineStart, rangeOf, type Splice } from "./source.js";

type Step =
  | { readonly kind: "keep"; readonly index: number }
  | { readonly kind: "drop"; readonly index: number }
  | { readonly kind: "add"; readonly value: string };

/** A shortest edit script from the current items to the wanted values (longest common subsequence). */
function editScript(current: readonly unknown[], wanted: readonly string[]): Step[] {
  const rows = current.length;
  const width = wanted.length + 1;
  // table[i * width + j]: the longest common subsequence of current[i..] and wanted[j..]
  const table = new Array<number>((rows + 1) * width).fill(0);
  const at = (i: number, j: number): number => table[i * width + j] ?? 0;
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = wanted.length - 1; j >= 0; j--) {
      table[i * width + j] =
        current[i] === wanted[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const steps: Step[] = [];
  let i = 0;
  let j = 0;
  for (;;) {
    const value = wanted[j];
    if (i < rows && value !== undefined && current[i] === value) {
      steps.push({ kind: "keep", index: i });
      i++;
      j++;
    } else if (value !== undefined && (i === rows || at(i, j + 1) >= at(i + 1, j))) {
      steps.push({ kind: "add", value });
      j++;
    } else if (i < rows) {
      steps.push({ kind: "drop", index: i });
      i++;
    } else {
      return steps;
    }
  }
}

const LIST_ITEM_PREFIX = /^[ \t]*-[ \t]+$/;

function itemValues(list: YAMLSeq): unknown[] {
  return list.items.map((item) => (isScalar(item) ? item.value : undefined));
}

/**
 * The splice for a non-empty block list. Each item owns its lines plus any comment lines just
 * above it; kept items are copied as they are, new items get the list's own `- ` prefix.
 */
export function spliceBlockList(
  source: string,
  list: YAMLSeq,
  values: readonly string[],
  eol: LineEnding,
): Splice {
  const items = list.items;
  const fallbackPrefix = `${" ".repeat(columnOf(source, rangeOf(list)[0]))}- `;
  const prefixOf = (index: number): string => {
    const [start] = rangeOf(items[index]);
    const prefix = source.slice(lineStart(source, start), start);
    return LIST_ITEM_PREFIX.test(prefix) ? prefix : fallbackPrefix;
  };
  const ends = items.map((item) => lineEndAfter(source, rangeOf(item)[1]));
  // the first item owns the comment lines right above it, like every other item
  let regionStart = lineStart(source, rangeOf(items[0])[0]);
  while (regionStart > 0) {
    const previous = lineStart(source, regionStart - 1);
    if (!source.slice(previous, regionStart).trimStart().startsWith("#")) break;
    regionStart = previous;
  }
  const chunk = (index: number) =>
    source.slice(index === 0 ? regionStart : ends[index - 1], ends[index]);

  let text = "";
  let near = 0;
  for (const step of editScript(itemValues(list), values)) {
    if (step.kind === "add") {
      text += `${prefixOf(near)}${renderScalar(step.value)}${eol}`;
      continue;
    }
    near = step.index;
    if (step.kind === "keep") text += chunk(step.index);
  }
  return { start: regionStart, end: ends[ends.length - 1] ?? regionStart, text };
}

/** The splice for a flow list: kept items keep their text, new items are added in order. */
export function spliceFlowList(source: string, list: YAMLSeq, values: readonly string[]): Splice {
  const [start, end] = rangeOf(list);
  const spaced = source[start + 1] === " " && list.items.length > 0;
  const parts: string[] = [];
  for (const step of editScript(itemValues(list), values)) {
    if (step.kind === "add") parts.push(renderScalar(step.value, { flow: true }));
    else if (step.kind === "keep") {
      const [itemStart, itemEnd] = rangeOf(list.items[step.index]);
      parts.push(source.slice(itemStart, itemEnd));
    }
  }
  const inner = parts.join(", ");
  return { start, end, text: spaced ? `[ ${inner} ]` : `[${inner}]` };
}
