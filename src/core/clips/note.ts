import { setBody } from "../frontmatter/body.js";
import { setField, setStatus, setTitle, setType } from "../frontmatter/fields.js";
import { parseNote, serializeNote } from "../note/parse.js";

// The note a clip becomes (the web clipper):
//
//   ---
//   title: How we sped up our build
//   type: Clip
//   status: inbox
//   url: https://example.com/blog/faster-builds
//   saved: 2026-10-10T09:41:07.512Z
//   ---
//   Read before the CI meeting.
//
// built with the core YAML writer only, never a string template, so no title, link or note can
// break out of its field. No `category` key (the folder is the category), no `source` key (the
// type and the `clipped` history record say where it came from) and no clip ID (the note's ID
// carries it). The filer's own stamps (`generated`, and `verified` where a folder asks first) go
// on top.

/** The OKF `type` of a clip's note, capitalized like the web app's `Note`. */
export const CLIP_NOTE_TYPE = "Clip";

/** What a clip's note is made from: the cleaned payload's fields (`ClipPayload`). */
export interface ClipNoteSource {
  readonly url: string;
  readonly title: string;
  readonly note: string;
  readonly savedAt: string;
}

/** The clip's title, or its link's host when it has none (or the link when it has no host). */
export function clipNoteTitle(clip: Pick<ClipNoteSource, "url" | "title">): string {
  const title = clip.title.trim();
  if (title !== "") return title;
  const host = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?(\[[^\]]*\]|[^/?#:]+)/i.exec(clip.url)?.[1];
  return host ?? clip.url;
}

/**
 * The note text of a clip: `title` (`clipNoteTitle`), `type: Clip`, `status: inbox`, `url` and
 * `saved`, then the person's note as the body (or none).
 */
export function clipNoteText(clip: ClipNoteSource): string {
  let note = parseNote("");
  note = setTitle(note, clipNoteTitle(clip));
  note = setType(note, CLIP_NOTE_TYPE);
  note = setStatus(note, "inbox");
  note = setField(note, "url", clip.url);
  note = setField(note, "saved", clip.savedAt);
  return clip.note === "" ? serializeNote(note) : serializeNote(setBody(note, clip.note));
}
