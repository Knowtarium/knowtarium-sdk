import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { type Actor, deriveVerification, fileNameOf } from "../../../core/index.js";
import type { NoteSnapshot } from "../../../client/index.js";
import type { AgentPolicyViewResult } from "../../../protocol/index.js";
import { isUnreachable } from "../key-cache.js";
import { describeFailure, type WorkspaceSession } from "../session.js";

/** What every tool works with. */
export interface ToolContext {
  readonly sessions: readonly WorkspaceSession[];
  /** The agent's actor, read from the MCP handshake when a tool runs. */
  actor(): Actor;
  now(): Date;
  /** Why no workspace is open, when it isn't simply that none is connected. */
  readonly notConnected?: string;
}

/** A refusal with a message the agent can act on. */
export class ToolError extends Error {
  override readonly name = "ToolError";
}

/** What an agent tells the person when its connection can only propose. */
export const RECONNECT_ADVICE =
  "Mention it to the person once: they can run `npx knowtarium connect` again, then restart the agent (in Claude Desktop, reconnect from the extension), to let you write directly where the workspace allows it.";

export const NOT_CONNECTED =
  "Knowtarium isn't connected on this computer. Ask the person to run `npx knowtarium connect`, then restart this MCP server.";

/** The `workspace` argument every tool takes. */
export const workspaceArg = z
  .string()
  .optional()
  .describe("The workspace ID or name; only needed when several are connected.");

/** A note argument. */
export const noteRef = z
  .string()
  .describe("A note ID (`note_...`) or its path as the tools show it.");

/** Paging arguments for a list. */
export function pagingArgs(maxLimit: number, defaultLimit: number) {
  return {
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("How many entries to skip (from `next_offset` of the previous answer)."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(maxLimit)
      .optional()
      .describe(`How many entries to return (default ${String(defaultLimit)}).`),
  };
}

/** One page of a list, with how to get the next. */
export function page<T>(
  items: readonly T[],
  args: { readonly offset?: number | undefined; readonly limit?: number | undefined },
  defaultLimit: number,
): { total: number; offset: number; items: T[]; truncated: boolean; next_offset: number | null } {
  const offset = args.offset ?? 0;
  const limit = args.limit ?? defaultLimit;
  const slice = items.slice(offset, offset + limit);
  const truncated = offset + slice.length < items.length;
  return {
    total: items.length,
    offset,
    items: slice,
    truncated,
    next_offset: truncated ? offset + slice.length : null,
  };
}

/** Cuts a text to `max` characters, saying so. */
export function capped(text: string, max: number): { text: string; truncated: boolean } {
  return text.length <= max
    ? { text, truncated: false }
    : {
        text: `${text.slice(0, max)}\n[... cut: ${String(text.length - max)} more characters]`,
        truncated: true,
      };
}

/** What the agent should know about where a session's answers come from, if anything. */
function noticeOf(session: WorkspaceSession | undefined): string | null {
  if (session === undefined) return null;
  if (session.status === "syncing" || session.status === "loading") {
    return "Still syncing with Knowtarium: these results come from the local copy and may be incomplete. Ask again shortly for the full picture.";
  }
  if (session.status === "offline" || session.status === "failed") return session.problem;
  return null;
}

/**
 * A tool's answer as pretty JSON (agents read it well, and it keeps the structure), followed by
 * a notice when the answer may be incomplete (still syncing, offline).
 */
export function json(value: unknown, session?: WorkspaceSession): CallToolResult {
  const notice = noticeOf(session);
  return {
    content: [
      { type: "text", text: JSON.stringify(value, null, 2) },
      ...(notice === null ? [] : [{ type: "text" as const, text: `Note: ${notice}` }]),
    ],
  };
}

/** Runs a tool body, turning failures into clear tool errors instead of protocol errors. */
export async function guarded(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    const text = error instanceof ToolError ? error.message : describeFailure(error);
    return { isError: true, content: [{ type: "text", text }] };
  }
}

/**
 * What a write says when Knowtarium can't be reached: nothing was `done`, or, when set, the
 * `unreachable` sentence (a direct write whose answer may have been lost after it was stored).
 */
export interface WriteOutcome {
  done: string;
  unreachable?: string;
}

/**
 * `guarded` for a write: when Knowtarium can't be reached, the answer says plainly that nothing was
 * `done` (proposed, recorded, posted), so the agent doesn't report a change that never happened.
 * `run` may change the outcome as it goes (a change is saved or proposed by then).
 */
export function guardedWrite(
  done: string,
  run: (outcome: WriteOutcome) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const outcome: WriteOutcome = { done };
  return guarded(async () => {
    try {
      return await run(outcome);
    } catch (error) {
      if (isUnreachable(error)) {
        throw new ToolError(
          outcome.unreachable ??
            `Knowtarium can't be reached, so nothing was ${outcome.done}. Try again once it can be reached.`,
        );
      }
      throw error;
    }
  });
}

/** Why a session can't answer at all, or null when it can (perhaps from a partial copy). */
function unusable(session: WorkspaceSession): string | null {
  if (session.ended) return session.problem ?? "This workspace can't be used any more.";
  if (session.loaded) return null;
  switch (session.status) {
    case "offline":
      return `${session.problem ?? "Knowtarium can't be reached."} There is no local copy of this workspace yet, so nothing can be answered until it can be reached.`;
    case "failed":
      return session.problem ?? "This workspace couldn't be opened.";
    default:
      // a retry is running: the last error says why there is nothing yet
      return (
        session.problem ?? "This workspace is still loading its notes; try again in a few seconds."
      );
  }
}

/**
 * The session for a workspace argument (optional when only one workspace is connected), once it
 * can answer (a failed one first tries again, see `WorkspaceSession.retryOnCall`): refused with the reason when nothing is connected, the access was revoked, the
 * workspace was disconnected, or there is no local copy yet.
 */
export async function sessionFor(
  context: ToolContext,
  workspace: string | undefined,
): Promise<WorkspaceSession> {
  if (context.sessions.length === 0) throw new ToolError(context.notConnected ?? NOT_CONNECTED);
  let found: WorkspaceSession | undefined;
  if (workspace === undefined) {
    const [only] = context.sessions;
    if (context.sessions.length !== 1 || only === undefined) {
      throw new ToolError(
        `Several workspaces are connected; pass \`workspace\` (one of ${context.sessions.map((session) => session.workspaceId).join(", ")}).`,
      );
    }
    found = only;
  } else {
    found = context.sessions.find(
      (session) =>
        session.workspaceId === workspace ||
        session.view.name?.toLowerCase() === workspace.toLowerCase(),
    );
  }
  if (found === undefined)
    throw new ToolError(`No connected workspace is called ${workspace ?? ""}.`);
  await found.connected();
  // a failed workspace tries again now rather than at its next scheduled retry
  await found.retryOnCall();
  const reason = unusable(found);
  if (reason !== null) throw new ToolError(reason);
  return found;
}

/** The note a reference names in a session, or a refusal. */
export function noteFor(session: WorkspaceSession, reference: string): NoteSnapshot {
  const note = session.view.find(reference);
  if (note === undefined) {
    throw new ToolError(
      `No note ${reference} in this workspace (or it is outside this agent's folders). Use search_notes or list_notes to find it.`,
    );
  }
  return note;
}

/**
 * A note's summary: what a list shows before anyone reads the body. `agentChanges` is the note's
 * folder mode by `policy` (`session.agentPolicy()`): in a `direct` folder nobody reviews or checks
 * changes, so there is no verification state (`state`, `checkState` null, no conflicts), only
 * freshness.
 */
export function summaryOf(
  session: WorkspaceSession,
  note: NoteSnapshot,
  now: Date,
  policy: AgentPolicyViewResult | null,
) {
  const mode = session.folderMode(note.folderId, policy);
  const parsed = session.view.workspace().notes.get(note.noteId);
  const frontmatter = parsed?.frontmatter ?? {};
  const verification = deriveVerification(frontmatter, {
    humanEntries: { confirmed: session.view.confirmedHumanEntries(note) },
    checks: session.checksFor(note.noteId),
    note: { noteId: note.noteId, version: note.version },
    now,
  });
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    id: note.noteId,
    path: session.view.pathOf(note.noteId),
    name: fileNameOf(session.view.pathOf(note.noteId)),
    title: parsed?.title ?? note.noteId,
    description: text(frontmatter["description"]),
    type: text(frontmatter["type"]),
    agentChanges: mode,
    state: mode === "review" ? verification.state : null,
    /**
     * The state from the checks alone (`stale` doesn't hide it): what decides whether a check is
     * due (`agent-check-pending`).
     */
    checkState: mode === "review" ? verification.checkState : null,
    freshness: verification.freshness.status,
    version: note.version,
    conflicts: (mode === "review" ? verification.conflicts : []).map((conflict) => ({
      by: conflict.by,
      version: conflict.version,
    })),
  };
}
