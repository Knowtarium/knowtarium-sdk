import type {
  AgentPolicy,
  AgentPolicyViewProblem,
  AgentWriteMode,
  NoteComment,
  PendingChange,
} from "../../protocol/index.js";
import type { CheckedAgentPolicy } from "../vault/index.js";
import type { NoteSnapshot } from "./events.js";

/**
 * A write whose base version was no longer current (409): both sides, for the merge UI. `mine`
 * is what this client tried to store on top of `baseVersion`; `theirs` is the verified current
 * version (its `text` is null when the note was deleted meanwhile).
 */
export interface WriteConflict {
  readonly status: "conflict";
  readonly mine: {
    readonly baseVersion: number;
    readonly name: string | null;
    readonly text: string | null;
  };
  readonly theirs: NoteSnapshot;
}

/** A person's note write or delete. */
export type WriteResult =
  | { readonly status: "saved"; readonly note: NoteSnapshot; readonly workspaceVersion: number }
  | WriteConflict;

/** An agent's proposal. */
export type SubmitResult =
  { readonly status: "submitted"; readonly pending: PendingChange } | WriteConflict;

/** A pending change, decrypted for review. */
export interface PendingReview {
  readonly pending: PendingChange;
  /** The agent's proposed note text. */
  readonly proposed: string;
  /**
   * The proposed file name (always set: a proposal is a note file with its name). A name other
   * than the base version's renames the note.
   */
  readonly proposedName: string | null;
  /** The version it was based on, verified (null for a proposed new note). */
  readonly base: NoteSnapshot | null;
}

/** A person's approval. */
export type ApproveResult =
  | {
      readonly status: "approved";
      readonly pending: PendingChange;
      readonly note: NoteSnapshot;
      readonly workspaceVersion: number;
    }
  | WriteConflict;

/** A person's rejection, with the comment it left. */
export interface RejectResult {
  readonly pending: PendingChange;
  readonly comment: NoteComment;
}

/** An agent's direct write that found the note moved on (409): both sides, and the server's version. */
export interface AgentWriteConflict extends WriteConflict {
  /** The version current on the server (`theirs.version`). */
  readonly currentVersion: number;
}

/**
 * An agent's direct write (`writeAsAgent`):
 *
 * - `saved`: the new version, signed with the agent's key; `policyRevision` is the agent policy
 *   revision it checked (pin it), `recorded` whether the optional `wrote` record was stored;
 * - a conflict (the base moved on), like any write;
 * - `approval_required`: the folder asks first, so propose instead (`submitPending`).
 *   `reason`: `policy` (the verified policy says `review`), `unverified_policy` (the policy failed
 *   a check, `problem` says which, so every folder reads as `review`), `unknown_folder` (the
 *   destination, or the note's current folder for a move, isn't one the engine or `folders`
 *   knows) or `server` (the server refused it so);
 * - `agent_key_required`: the owner never vouched for this agent's key (connected before
 *   protocol 2, or another key), or this engine has no signing key: propose instead, or
 *   reconnect;
 * - `rate_limited`: the per-minute limit or the daily cap on direct writes (they share the
 *   code; a `retryAfterSeconds` over a minute is the daily cap): propose or try later.
 */
export type AgentWriteResult =
  | {
      readonly status: "saved";
      readonly note: NoteSnapshot;
      readonly workspaceVersion: number;
      readonly policyRevision: number;
      readonly recorded: boolean;
    }
  | AgentWriteConflict
  | {
      readonly status: "approval_required";
      readonly reason: "policy" | "unverified_policy" | "unknown_folder" | "server";
      /** The verified revision that said so (null when none verified). */
      readonly policyRevision: number | null;
      readonly problem?: AgentPolicyViewProblem;
    }
  | { readonly status: "agent_key_required" }
  | {
      /**
       * Too many writes (429): the per-minute limit, which the API client already waited out
       * once when `Retry-After` was a minute or less, or the daily cap (a long `retryAfter`).
       */
      readonly status: "rate_limited";
      readonly retryAfterSeconds: number | null;
    };

/** The owner's agent policy change (`setAgentPolicy`). */
export type SetAgentPolicyResult =
  | {
      readonly status: "saved";
      readonly policy: AgentPolicy;
      readonly revision: number;
      readonly workspaceVersion: number;
    }
  | {
      /** The policy changed since `baseRevision`: here is the current one, checked; edit again. */
      readonly status: "conflict";
      readonly currentRevision: number;
      readonly current: CheckedAgentPolicy;
    };

/**
 * What auditing an agent's version against the policy revision it named found
 * (`auditAgentVersion`). The server enforces the policy; this is a second look, for display:
 *
 * - `consistent`: the owner signed that revision with the hash the agent signed; `mode` is the
 *   folder's mode under it with today's folder tree (null without one), `review` meaning the
 *   folder asked first (or the tree changed since);
 * - `policy_mismatch`: the agent named a revision whose owner-signed hash is another (or whose
 *   hash this device pinned is another: the agent was shown a fork of that revision);
 * - `below_floor`: the agent named a revision below the floor the owner signed into its
 *   `agent_key` (an old policy replayed to it, and the server took the write);
 * - `unverifiable`: that revision couldn't be read or checked (`problem`).
 */
export type AgentWriteAudit =
  | {
      readonly status: "consistent";
      readonly revision: number;
      readonly mode: AgentWriteMode | null;
    }
  | { readonly status: "policy_mismatch"; readonly revision: number }
  | { readonly status: "below_floor"; readonly revision: number; readonly floor: number }
  | {
      readonly status: "unverifiable";
      readonly revision: number;
      readonly problem: AgentPolicyViewProblem | "not_found";
    };
