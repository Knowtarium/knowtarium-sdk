// A large, deterministic workspace for performance tests: notes in folders, with OKF frontmatter,
// tags, wikilinks between notes and bodies of a few hundred words drawn from a skewed vocabulary
// (tens of thousands of distinct terms at 3,000 notes). No randomness, so every run (and every
// runtime) indexes exactly the same text.
import type { NoteInput } from "../src/core/index.js";

const WORDS = (
  "pricing churn revenue plan annual monthly customer segment report forecast budget hiring " +
  "roadmap feature release incident review policy refund contract vendor security audit " +
  "latency uptime storage quota invoice payment trial onboarding activation retention cohort " +
  "survey interview research market competitor partner launch campaign signup conversion " +
  "support ticket escalation handbook process decision meeting agenda summary metric target"
).split(" ");
/** Syllables for made-up words: 48^3 (about 110,000) possible words of three syllables. */
const SYLLABLES = (
  "ba be bi bo bu da de di do du fa fe fi fo ka ke ki ko ku la le li lo lu " +
  "ma me mi mo mu na ne ni no nu ra re ri ro ru sa se si so su ta te ti to tu"
).split(" ");

/** The made-up vocabulary: word `i` of up to 110,592 (48 cubed). */
export function syntheticWord(i: number): string {
  const n = SYLLABLES.length;
  return `${SYLLABLES[i % n] ?? ""}${SYLLABLES[Math.floor(i / n) % n] ?? ""}${SYLLABLES[Math.floor(i / n / n) % n] ?? ""}`;
}

/** How many made-up words the notes draw from: about 60,000 distinct terms at 3,000 notes. */
const VOCABULARY = 64_000;

/** A skewed pick (a few words are common, most are rare), like word use in real text. */
function vocabularyWord(next: () => number): string {
  const r = next();
  return syntheticWord(Math.floor(VOCABULARY * r * r * r));
}

const TYPES = ["Concept", "Decision", "Metric", "Meeting", "Policy", "Topic"];
const TAGS = ["finance", "growth", "product", "ops", "sales", "people", "legal", "infra"];

/** A small deterministic generator (a linear congruential sequence). */
function sequence(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function pick<T>(list: readonly T[], next: () => number): T {
  return list[Math.floor(next() * list.length)] as T;
}

export function syntheticTitle(i: number): string {
  return `Note ${String(i)} ${WORDS[i % WORDS.length] ?? ""}`;
}

/** `count` notes in `count / 100` folders, ids `syn_<i>`. */
export function syntheticNotes(count: number, seed = 42): NoteInput[] {
  const next = sequence(seed);
  const notes: NoteInput[] = [];
  for (let i = 0; i < count; i++) {
    const folder = `area-${String(i % Math.max(1, Math.ceil(count / 100)))}`;
    const words: string[] = [];
    const length = 150 + Math.floor(next() * 250);
    for (let w = 0; w < length; w++) {
      words.push(next() < 0.35 ? pick(WORDS, next) : vocabularyWord(next));
      if (w % 60 === 59) words.push(`[[${syntheticTitle(Math.floor(next() * count))}]]`);
      if (w % 20 === 19) words.push(".\n");
    }
    const tags = [pick(TAGS, next), pick(TAGS, next)];
    const day = String(1 + (i % 28)).padStart(2, "0");
    const text = [
      "---",
      `title: ${syntheticTitle(i)}`,
      `description: About ${pick(WORDS, next)} and ${pick(WORDS, next)}`,
      `type: ${pick(TYPES, next)}`,
      `tags: [${[...new Set(tags)].join(", ")}]`,
      `generated: { by: human:sara, at: 2026-09-${day}T09:00:00Z }`,
      "verified:",
      `  - { by: human:sara, at: 2026-09-${day}T09:00:00Z }`,
      `stale_after: 2027-0${String(1 + (i % 9))}-01`,
      `owner: team-${String(i % 17)}`,
      "---",
      "",
      `# ${syntheticTitle(i)}`,
      "",
      words.join(" "),
      "",
    ].join("\n");
    notes.push({ id: `syn_${String(i)}`, path: `${folder}/note-${String(i)}.md`, text });
  }
  return notes;
}
