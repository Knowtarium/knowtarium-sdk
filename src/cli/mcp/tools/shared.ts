import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { type Actor, deriveVerification, fileNameOf } from "../../../core/index.js";
import type { NoteSnapshot } from "../../../client/index.js";
import type { AgentPolicyViewResult } from "../../../protocol/index.js";
import { isUnreachable } from "../key-cache.js";
import { describeFailure, disconnectCommandFor, type WorkspaceSession } from "../session.js";

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
  "Mention it to the person once: they can run `npx knowtarium connect` again from their home folder, then restart the agent (in Claude Desktop, reconnect from the extension), to let you write directly where the workspace allows it.";

export const NOT_CONNECTED =
  "Knowtarium isn't connected on this computer. Ask the person to run `npx knowtarium connect` from their home folder, then restart this MCP server.";

/** The `workspace` argument every tool takes. */
export const workspaceArg = z
  .string()
  .optional()
  .describe(
    "The workspace ID (or its name, when no other connected workspace has it); only needed when several connected workspaces can be used.",
  );

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
 * How long a call without `workspace` waits for workspaces still on their first sync, to learn
 * which of them can be used (a revoked token shows on the first pull).
 */
const FIRST_SYNC_WAIT_MS = 5_000;

/**
 * Waits, at most `FIRST_SYNC_WAIT_MS` and for all of them at once, for the workspaces still on
 * their first sync, so their status, name and problem are known: revocation shows on the first
 * pull, and a disconnect when a session looks for its connection. Never rejects.
 */
export async function firstSyncs(context: ToolContext): Promise<void> {
  await Promise.all(
    context.sessions.map(async (session) => {
      await session.firstSync(FIRST_SYNC_WAIT_MS);
      await session.connected();
    }),
  );
}

/** A session's state as a refusal lists it, with the fix when it can't be used. */
function stateOf(session: WorkspaceSession): string {
  switch (session.status) {
    case "revoked":
      return `access revoked; \`${disconnectCommandFor(session.workspaceId)}\` removes it`;
    case "disconnected":
      return "disconnected on this computer";
    default:
      return session.status;
  }
}

/** A workspace as a refusal lists it: its ID, its name when known, and its state. */
function described(session: WorkspaceSession): string {
  const name = session.view.name;
  return `${session.workspaceId}${name === null ? "" : ` ("${name}")`}, ${stateOf(session)}`;
}

/**
 * The workspace a call without `workspace` means: the only connected one, or else the only one
 * that can still be used. A workspace whose access was revoked, or that `knowtarium disconnect`
 * removed, is never a candidate; with several left, the agent is asked to pick one by ID.
 */
async function defaultSession(context: ToolContext): Promise<WorkspaceSession> {
  const candidates = () => context.sessions.filter((session) => !session.ended);
  if (context.sessions.length > 1 && candidates().length > 1) await firstSyncs(context);
  const usable = context.sessions.length === 1 ? context.sessions : candidates();
  const [only] = usable;
  if (usable.length === 1 && only !== undefined) return only;
  if (usable.length === 0) {
    throw new ToolError(
      `None of the connected workspaces can be used: ${context.sessions.map(described).join("; ")}. Ask the person to run \`npx knowtarium connect\` from their home folder to connect a workspace again, then restart the agent.`,
    );
  }
  const ended = context.sessions.filter((session) => session.ended);
  throw new ToolError(
    `Several workspaces are connected; pass \`workspace\` with the ID of the one you mean: ${usable.map(described).join("; ")}.${ended.length === 0 ? "" : ` Not counted, since they can't be used: ${ended.map(described).join("; ")}.`}`,
  );
}

/**
 * The session a `workspace` argument names: a workspace ID, else a name (letter case ignored)
 * that exactly one connected workspace has. A name several have is refused with their IDs, never
 * guessed.
 */
function namedSession(context: ToolContext, workspace: string): WorkspaceSession {
  const byId = context.sessions.find((session) => session.workspaceId === workspace);
  if (byId !== undefined) return byId;
  const named = context.sessions.filter(
    (session) => session.view.name?.toLowerCase() === workspace.toLowerCase(),
  );
  const [only] = named;
  if (named.length > 1) {
    throw new ToolError(
      `${String(named.length)} connected workspaces are called ${workspace}; pass \`workspace\` with the ID of the one you mean: ${named.map(described).join("; ")}.`,
    );
  }
  if (only === undefined) {
    throw new ToolError(
      `No connected workspace is called ${workspace}. Connected: ${context.sessions.map(described).join("; ")}.`,
    );
  }
  return only;
}

/**
 * The session for a workspace argument (optional when only one connected workspace can be used),
 * once it can answer (a failed one first tries again, see `WorkspaceSession.retryOnCall`):
 * refused with the reason when nothing is connected, the name is ambiguous, the access was
 * revoked, the workspace was disconnected, or there is no local copy yet.
 */
export async function sessionFor(
  context: ToolContext,
  workspace: string | undefined,
): Promise<WorkspaceSession> {
  if (context.sessions.length === 0) throw new ToolError(context.notConnected ?? NOT_CONNECTED);
  const found =
    workspace === undefined ? await defaultSession(context) : namedSession(context, workspace);
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
