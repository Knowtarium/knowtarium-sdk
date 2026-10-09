// A large Obsidian vault for the migration tests, generated (never committed): several hundred
// notes in nested folders, the same note names in several folders (so `[[Name]]` links are
// ambiguous), attachments embedded and linked, daily notes and templates as Obsidian's settings
// name them, plus a few notes with broken frontmatter and links to notes that don't exist. The
// same options always give the same files. `node scripts/generate-vault.js <folder>` writes it.

/** One file of the vault: its path (`/`-separated) and contents. */
export interface VaultFile {
  readonly path: string;
  readonly data: string | Uint8Array;
}

/** What the generated vault holds, for the tests to compare with. */
export interface LargeVault {
  readonly files: readonly VaultFile[];
  /** Every Markdown note, daily notes and templates included. */
  readonly notes: readonly string[];
  readonly attachments: readonly string[];
  readonly dailyNotes: readonly string[];
  readonly templates: readonly string[];
  /** Note names used in more than one folder. */
  readonly duplicateNames: readonly string[];
  /** Notes whose frontmatter is broken on purpose. */
  readonly brokenFrontmatter: readonly string[];
}

const AREAS = ["Projects", "Areas/Health", "Areas/Finance", "Resources/Reading", "People"];
const SHARED = ["Meeting notes", "Ideas", "Plan", "Overview"];
const TOPICS = ["pricing", "hiring", "roadmap", "budget", "research", "launch", "support"];

/** A deterministic pseudo-random sequence (mulberry32), so the vault never changes. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A tiny valid PNG (1 x 1), varied by one byte so the attachments differ. */
function png(seed: number): Uint8Array {
  const bytes = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ];
  return Uint8Array.from([...bytes, seed & 0xff]);
}

/** The vault: `notes` regular notes (default 400) plus daily notes, templates and attachments. */
export function largeVault(
  options: { readonly notes?: number; readonly seed?: number } = {},
): LargeVault {
  const count = options.notes ?? 400;
  const next = random(options.seed ?? 20261001);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const files: VaultFile[] = [];
  const notes: string[] = [];
  const attachments: string[] = [];
  const dailyNotes: string[] = [];
  const templates: string[] = [];
  const brokenFrontmatter: string[] = [];

  files.push(
    {
      path: ".obsidian/app.json",
      data: JSON.stringify({ attachmentFolderPath: "Attachments", newLinkFormat: "shortest" }),
    },
    {
      path: ".obsidian/daily-notes.json",
      data: JSON.stringify({ folder: "Daily", format: "YYYY-MM-DD" }),
    },
    { path: ".obsidian/templates.json", data: JSON.stringify({ folder: "Templates" }) },
  );

  for (let index = 0; index < 30; index++) {
    const path = `Attachments/figure ${String(index + 1)}.png`;
    attachments.push(path);
    files.push({ path, data: png(index) });
  }
  attachments.push("Attachments/Q3 report.pdf");
  files.push({ path: "Attachments/Q3 report.pdf", data: "%PDF-1.4\n% generated\n%%EOF\n" });

  // the shared names first, in every area, so links to them are ambiguous
  const names: { folder: string; name: string }[] = [];
  for (const area of AREAS) for (const name of SHARED) names.push({ folder: area, name });
  for (let index = names.length; index < count; index++) {
    const topic = pick(TOPICS);
    names.push({
      folder: `${pick(AREAS)}${next() < 0.3 ? `/${topic[0]?.toUpperCase() ?? ""}${topic.slice(1)}` : ""}`,
      name: `${topic[0]?.toUpperCase() ?? ""}${topic.slice(1)} note ${String(index + 1)}`,
    });
  }
  const linkable = names.map((entry) => entry.name);
  names.forEach((entry, index) => {
    const path = `${entry.folder}/${entry.name}.md`;
    notes.push(path);
    const links = [pick(linkable), pick(linkable), pick(SHARED)]
      .map((name) => `[[${name}]]`)
      .join(", ");
    const embed = next() < 0.2 ? `\n\n![[${pick(attachments).split("/").pop() ?? ""}]]` : "";
    const missing = next() < 0.05 ? ` See also [[Never written ${String(index)}]].` : "";
    const tags = `#${pick(TOPICS)}`;
    if (index % 97 === 13) {
      brokenFrontmatter.push(path);
      files.push({ path, data: `---\ntitle: [unclosed\n---\nBroken on purpose.\n` });
      return;
    }
    const frontmatter =
      next() < 0.5 ? `---\ntags: [${pick(TOPICS)}]\naliases: [${entry.name} alias]\n---\n` : "";
    files.push({
      path,
      data: `${frontmatter}# ${entry.name}\n\nAbout ${entry.name.toLowerCase()} ${tags}. Links: ${links}.${missing}${embed}\n`,
    });
  });

  for (let day = 1; day <= 30; day++) {
    const path = `Daily/2026-09-${String(day).padStart(2, "0")}.md`;
    dailyNotes.push(path);
    notes.push(path);
    files.push({ path, data: `Worked on [[${pick(linkable)}]].\n\n- [ ] follow up\n` });
  }
  for (const name of ["Meeting", "Weekly review", "Project"]) {
    const path = `Templates/${name}.md`;
    templates.push(path);
    notes.push(path);
    files.push({ path, data: `# {{title}}\n\nCreated {{date}}.\n` });
  }
  return {
    files,
    notes,
    attachments,
    dailyNotes,
    templates,
    duplicateNames: SHARED,
    brokenFrontmatter,
  };
}
