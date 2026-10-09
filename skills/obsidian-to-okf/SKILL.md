---
name: obsidian-to-okf
description: Convert a local Obsidian vault into an OKF (Open Knowledge Format) bundle in a new folder, with the free knowtarium CLI, so it can be imported into Knowtarium or used by any OKF tool. Use when someone asks to migrate, convert or import an Obsidian vault to OKF or Knowtarium. The vault itself is only read, never changed.
---

# Obsidian to OKF

This skill converts an Obsidian vault into an OKF bundle: the same notes, as plain markdown files
with OKF frontmatter, in a **new folder**. The vault is only read; nothing in it changes. It uses
the free `knowtarium` command line tool (Node.js 20 or later; `npx` downloads it), which works
offline and needs no account.

What the conversion does:

- adds the OKF fields each note lacks: `type`, `title`, `description` (the first paragraph) and
  `generated` (the person, at the time of the conversion); it leaves `stale_after` unset, so
  nothing is flagged stale on day one, and keeps every existing property exactly as written;
- renames notes called `index.md` or `log.md` (names OKF reserves) to `index-note.md` and
  `log-note.md`, and updates every link to them;
- turns wikilinks and embeds into standard markdown links (images stay images; attachments keep
  their folder and name), resolved the way Obsidian resolves them;
- writes an `index.md` in every folder and a root `log.md` with the conversion as its first entry;
- copies daily notes, templates and canvases unchanged, leaves out Obsidian's trash, and copies
  the `.obsidian` settings folder next to the bundle so Obsidian opens the copy the same way.

## Ground rules

- **Never change the vault.** Work only through `knowtarium convert`, which reads the vault and
  writes a new folder. Don't edit vault files yourself, unless the person asks you to fix something
  there (and then say exactly what you change).
- **Ask before every choice.** The person decides where the copy goes, which name goes in
  `generated`, and what to do about anything the report flags. Show them the report; don't decide
  for them.
- **One conversion per folder.** `convert` refuses an output folder that isn't empty. To convert
  again, use a new folder (or ask the person before deleting the old copy).

## Steps

1. **Ask** for the vault's path, the folder to write the copy to (suggest a new folder next to
   the vault, such as `~/Notes (OKF)`), and the name to record as the author (`generated` becomes
   `human:<name>`, for example `human:maya`). If the vault syncs (Obsidian Sync, iCloud, Dropbox),
   ask the person to let the sync finish first.
2. **Dry run** and read the report together:

   ```sh
   npx knowtarium convert "<vault>" "<copy>" --person <name> --dry-run
   ```

   It prints a summary: the counts and the first items of each section. Explain it in plain words
   (see below). For anything flagged, ask the person what they
   want: leave it, or fix it in the vault and run the dry run again.

3. **Convert** once the person says yes:

   ```sh
   npx knowtarium convert "<vault>" "<copy>" --person <name>
   ```

   It prints the summary again and saves the full report, every item of every section, as
   `.knowtarium/conversion-report.md` in the copy: read that file for the complete lists.

4. **Validate** the copy:

   ```sh
   npx knowtarium validate "<copy>"
   ```

   Expect `0 errors`. Warnings are fine to keep: links that were already broken in the vault, and
   daily notes or templates copied unchanged (they have no `type`). An error means a note whose
   frontmatter was already broken in the vault: show the person the line and let them fix it in
   the vault, then convert again into a new folder.

5. **Finish** with a short summary: how many notes and attachments, what was renamed, what needs
   a look. Then tell the person what they can do next:
   - open the copy in Obsidian (it keeps working there; `generated` is nested, so read it in
     source mode);
   - add `stale_after` dates to notes that expire (prices, plans, anything "current");
   - import the copy into a Knowtarium workspace from the web app:
     https://knowtarium.com/?utm_source=skill&utm_campaign=migration

## Reading the report

| Section                | What it means                                                                                                   | What to ask                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Renamed                | Notes called `index.md` or `log.md` became `index-note.md` and `log-note.md`; links follow                      | Nothing, unless they rely on the old names elsewhere                                                  |
| Ambiguous links        | Several notes share a name; the link now points to the one Obsidian would open                                  | Is each the right note? If not, they can link by path in the vault and convert again                  |
| Lossy                  | Something plain markdown can't express exactly, such as an embedded note (now a link) or a link to a heading    | Whether that is acceptable                                                                            |
| Links to missing notes | Links that were already broken in the vault                                                                     | Nothing; OKF keeps them as notes to write                                                             |
| Copied as they are     | Daily notes, templates, canvases                                                                                | Nothing; they can add a `type` later                                                                  |
| Skipped                | Obsidian's settings (copied next to the bundle) and files the format leaves out                                 | Nothing                                                                                               |
| Not read               | Symbolic links (never followed), hidden folders such as `.git` and `.trash`, and anything that couldn't be read | Whether something that matters is among them (for a link, they can copy the real file into the vault) |
| Left out               | Files that couldn't be converted safely, such as two names that differ only in letter case                      | They must fix it in the vault, then convert again; these files are NOT in the copy                    |
| Notes with problems    | Frontmatter that was already broken in the vault                                                                | Fix in the vault, or keep and fix later                                                               |

Never summarize "Left out" or "Notes with problems" away: say which files, and why.
