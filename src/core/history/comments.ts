import { z } from "zod";

import type { SignatureStatus } from "./events.js";

/**
 * A comment as it is encrypted: the same shape as the Markdown comments agents read through MCP
 * (author, time, anchor, parent, status, text). A conflict found by an agent's check is a comment
 * too, marked `kind: "conflict"` with the notes that disagree.
 */
export const CommentRecord = z.looseObject({
  /** `human:<id>` for a person, the agent's actor for an agent. */
  author: z.string().min(1).max(200),
  at: z.iso.datetime({ offset: true }),
  anchor: z.looseObject({
    note: z.string().min(1).max(64),
    /** A claim in the note (a block id such as `^src-3`); absent for a whole-note comment. */
    claim: z.string().max(200).optional(),
  }),
  /** The comment this one replies to. */
  parent: z.string().max(64).optional(),
  status: z.enum(["open", "resolved"]).default("open"),
  text: z.string().max(20_000),
  kind: z.enum(["comment", "conflict"]).default("comment"),
  /** For a conflict: the connected notes that disagree. */
  conflictsWith: z.array(z.string().max(64)).max(200).optional(),
});
export type CommentRecord = z.infer<typeof CommentRecord>;

/** A stored comment after decrypting and verifying it. */
export interface CommentEntry {
  readonly id: string;
  readonly noteId: string;
  /** The account or token the server lists as the author. */
  readonly authorId: string;
  /**
   * The agent token that posted it, as the server asserts (null for a person's): attribution
   * for display, not proof.
   */
  readonly authorTokenId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 1 for a new comment, then +1 per update (a reply status, a resolve). */
  readonly revision: number;
  /** The workspace version of its last write (the timeline's order). */
  readonly seq: number;
  /** The decrypted record; null when it couldn't be decrypted or read. */
  readonly record: CommentRecord | null;
  readonly signature: SignatureStatus;
}

/** A comment with its replies, oldest first. */
export interface CommentThread {
  readonly root: CommentEntry;
  readonly replies: readonly CommentEntry[];
  /** The root's status: a thread is resolved when its first comment is. */
  readonly status: "open" | "resolved";
  /** Whether an agent's check flagged a conflict in this thread. */
  readonly conflict: boolean;
}

/** Threads of a note's comments, with counts. */
export interface CommentThreads {
  readonly threads: readonly CommentThread[];
  readonly open: number;
  readonly resolved: number;
  /** Open threads that are conflict flags. */
  readonly openConflicts: number;
}

/** Whether a comment is a conflict flag from an agent's check. */
export function isConflictFlag(record: CommentRecord | null): boolean {
  return record?.kind === "conflict" || (record?.conflictsWith?.length ?? 0) > 0;
}

const byCreation = (a: CommentEntry, b: CommentEntry) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/**
 * Groups comments into threads by `parent`. A reply to a reply joins the thread of its root; a
 * reply whose parent is missing (or unreadable) starts its own thread, and so does the oldest
 * comment of a `parent` cycle. Threads come oldest first.
 */
export function buildThreads(entries: readonly CommentEntry[]): CommentThreads {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const rootOf = (entry: CommentEntry): CommentEntry => {
    const chain: CommentEntry[] = [entry];
    for (;;) {
      const current = chain[chain.length - 1] ?? entry;
      const parent = current.record?.parent;
      const next = parent === undefined ? undefined : byId.get(parent);
      if (next === undefined) return current;
      const loop = chain.indexOf(next);
      if (loop !== -1) {
        // a cycle: its oldest comment is the root, the same one from wherever the walk starts
        return [...chain.slice(loop)].sort(byCreation)[0] ?? current;
      }
      chain.push(next);
    }
  };
  const groups = new Map<string, CommentEntry[]>();
  for (const entry of [...entries].sort(byCreation)) {
    const root = rootOf(entry);
    const group = groups.get(root.id) ?? [];
    if (root.id !== entry.id) group.push(entry);
    groups.set(root.id, group);
  }
  const threads: CommentThread[] = [];
  for (const [rootId, replies] of groups) {
    const root = byId.get(rootId);
    if (root === undefined) continue;
    threads.push({
      root,
      replies,
      status: root.record?.status ?? "open",
      conflict:
        isConflictFlag(root.record) || replies.some((reply) => isConflictFlag(reply.record)),
    });
  }
  threads.sort((a, b) => byCreation(a.root, b.root));
  const open = threads.filter((thread) => thread.status === "open");
  return {
    threads,
    open: open.length,
    resolved: threads.length - open.length,
    openConflicts: open.filter((thread) => thread.conflict).length,
  };
}

/** A new comment record (or a reply, with `parent`). */
export function newComment(input: {
  readonly author: string;
  readonly at: Date | string;
  readonly noteId: string;
  readonly text: string;
  readonly claim?: string;
  readonly parent?: string;
}): CommentRecord {
  return CommentRecord.parse({
    author: input.author,
    at: typeof input.at === "string" ? input.at : input.at.toISOString(),
    anchor:
      input.claim === undefined
        ? { note: input.noteId }
        : { note: input.noteId, claim: input.claim },
    ...(input.parent === undefined ? {} : { parent: input.parent }),
    status: "open",
    text: input.text,
    kind: "comment",
  });
}

/** The same comment, resolved (or open again): the next revision's record. */
export function withStatus(record: CommentRecord, status: "open" | "resolved"): CommentRecord {
  return { ...record, status };
}
