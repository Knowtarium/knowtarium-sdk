import { clipNoteText, clipNoteTitle } from "../../core/clips/index.js";
import { foldName, noteNameFromTitle, numberedNoteName } from "../../core/files/index.js";
import {
  deriveInboxKeyPair,
  fromBase64Url,
  type InboxKeyPair,
  toBase64Url,
  wipe,
  type WorkspaceKeyring,
} from "../../crypto/index.js";
import {
  type ClipId,
  clipNoteId,
  CLIP_QUEUE_LIMITS,
  type ExtensionId,
  type FolderId,
  type QueuedClip,
  routes,
  type SignedInboxKey,
} from "../../protocol/index.js";
import { clippedRecord } from "../clips/clipped.js";
import { fetchExtensions, type VerifiedExtension } from "../clips/extensions.js";
import { fetchInboxKey } from "../clips/inbox.js";
import { type ClipRejection, clipSignedBy, type OpenedClip, openClip } from "../clips/open.js";
import { isSyncApiError, isVaultError } from "../errors/index.js";
import { newId } from "../platform/ids.js";
import { encryptEvent, signingFields, signRecorded } from "../vault/index.js";
import { type AgentNoteWrite, writeAsAgent } from "./agent-writes.js";
import { requireIdentity, type SyncContext, withCurrentKey, withKeys } from "./context.js";
import { writeNote } from "./writes.js";

/*
 * Filing clips (the web clipper): one implementation for the web app (a person's session, which
 * files in every folder as the person, `edited`) and the CLI (an agent's token, which files only
 * into existing folders where agents' changes apply directly, `agent_edited`, and releases the
 * rest). The steps, in order:
 *
 * 1. Read the latest `inbox_key`, verify it under the owner key this client trusts and derive the
 *    key again (stop on a mismatch); read the paired extensions, keeping those whose
 *    `extension_key` verifies.
 * 2. Claim a batch (leased for 120 seconds).
 * 3. For each clip: derive its generation's inbox key (none here: release); open it (reject
 *    `unreadable`); the JSON canonical and clean (reject `invalid_clip`); the IDs those of the
 *    queue entry and this workspace (reject `mismatch`); the signature under the vouched key
 *    (reject `bad_signature`); not posted after its extension's revocation (reject `revoked`);
 *    find the folder (the inbox, or its direct subfolder named like the category, letter case
 *    ignored; the web app creates a missing one, the CLI releases); build the note
 *    (`clipNoteText`, named from the title, numbered when taken); create the note
 *    `clipNoteId(clipId)` at base version 0 (a 409: someone filed it, ack); append the `clipped`
 *    record; ack.
 * 4. Claim again while the last batch was full.
 *
 * Rejected clips are acked and counted; nothing about them is sent anywhere.
 */

/** Why a filer left a clip waiting (released it), for the person or the agent to see. */
export type ClipWaitReason =
  /** The clip's key generation is one this client has no copy of (connected after it). */
  | "old_generation"
  /** Its category folder doesn't exist, and this client can't create folders (agents). */
  | "new_category"
  /** The target folder asks for the person's approval of agents' changes. */
  | "review"
  /** Today's limit of agents' direct changes was reached. */
  | "daily_cap"
  /** The target folder is outside this connection's scope, or it can't write. */
  | "scope"
  /** The inbox folder no longer exists (the web app makes a new one). */
  | "inbox_folder_missing";

/** A folder as the filer looks it up: its decrypted name and its parent. */
export interface ClipFolder {
  readonly name: string;
  readonly parentId: FolderId | null;
}

/** What the caller tells the filer about its workspace and how it writes. */
export interface FileClipsOptions {
  /** Clips per claim (1 to 50, default 20). */
  readonly max?: number;
  /** The live folders with their decrypted names (the synced view), by ID. */
  readonly folders: ReadonlyMap<string, ClipFolder>;
  /** The file names of the notes in a folder, for numbering a taken name. */
  readonly takenNames: (folderId: FolderId) => Iterable<string>;
  /**
   * The web app only: creates a missing category folder under the inbox as the person (a signed
   * `folder_created`) and returns its ID. Without it, such clips are released (`new_category`).
   */
  readonly createFolder?: (name: string, parentId: FolderId) => Promise<FolderId>;
  /** The filer's own stamps on the note text (`generated`, and `verified` where it asks first). */
  readonly stamp?: (text: string, folderId: FolderId) => string;
  /**
   * The agent's actor (the CLI's `<client>/<version>`), which its unsigned `clipped` record names.
   * A person's session always names `human:<account>`, as its signed record must.
   */
  readonly actor?: string;
  /** For an agent's writes: its policy floor and the folders it sees (see `AgentNoteWrite`). */
  readonly agentWrite?: Pick<AgentNoteWrite, "minPolicyRevision" | "visibleFolderIds">;
  /** Milliseconds since the epoch after which no new batch is claimed. */
  readonly deadline?: number;
  /** The clock (tests). */
  readonly now?: () => number;
}

/** A clip filed as a note. */
export interface FiledClip {
  readonly clipId: ClipId;
  readonly noteId: string;
  readonly folderId: FolderId;
  readonly name: string;
  /** Whether its `clipped` record was stored (best effort: the note stands either way). */
  readonly recorded: boolean;
}

/** What one filing pass did. */
export interface FileClipsResult {
  /**
   * `done`: the queue was worked through (or the deadline came); `no_inbox`: the workspace has no
   * inbox key; `inbox_key_mismatch`: the signed inbox key isn't the one this client derives for
   * its generation (nothing filed); `inbox_folder_missing`: the inbox folder is gone (nothing
   * claimed: the web app makes a new one and signs a new revision).
   */
  readonly status: "done" | "no_inbox" | "inbox_key_mismatch" | "inbox_folder_missing";
  readonly filed: readonly FiledClip[];
  /** Clips someone filed already (the note existed): acked. */
  readonly duplicates: readonly ClipId[];
  readonly rejected: readonly { readonly clipId: ClipId; readonly reason: ClipRejection }[];
  readonly released: readonly { readonly clipId: ClipId; readonly reason: ClipWaitReason }[];
}

type Outcome =
  | { readonly kind: "filed"; readonly filed: FiledClip }
  | { readonly kind: "duplicate" }
  | { readonly kind: "rejected"; readonly reason: ClipRejection }
  | { readonly kind: "released"; readonly reason: ClipWaitReason };

/** The longest `Retry-After` a per-minute limit asks for; a longer wait is the daily cap. */
const PER_MINUTE_RETRY_MAX_SECONDS = 60;

/** One filing pass's state: the verified keys and extensions, and the names it gave. */
interface Pass {
  readonly context: SyncContext;
  readonly options: FileClipsOptions;
  readonly inbox: SignedInboxKey["envelope"];
  extensions: Map<ExtensionId, VerifiedExtension>;
  extensionsFresh: boolean;
  /** Names given in this pass, per folder (the view may not have them yet). */
  readonly given: Map<string, string[]>;
  /** Category folders made in this pass, by folded name. */
  readonly made: Map<string, FolderId>;
}

/** The inbox key pair of `generation`, if this client holds that generation. */
function inboxKeyFor(keys: WorkspaceKeyring, generation: number): InboxKeyPair | undefined {
  const key = keys.get(generation);
  return key === undefined ? undefined : deriveInboxKeyPair(key);
}

/** The folder a clip goes to: the inbox, or the inbox's direct subfolder named like the category. */
function targetFolder(pass: Pass, category: string): FolderId | undefined {
  const inboxId = pass.inbox.folderId;
  if (category === "") return inboxId;
  const wanted = foldName(category);
  const made = pass.made.get(wanted);
  if (made !== undefined) return made;
  for (const [id, folder] of pass.options.folders) {
    if (folder.parentId === inboxId && foldName(folder.name) === wanted) return id as FolderId;
  }
  return undefined;
}

/** The note's file name: its title's (or its host's), numbered when taken in the folder. */
function noteName(pass: Pass, folderId: FolderId, clip: OpenedClip): string {
  const given = pass.given.get(folderId) ?? [];
  const name = numberedNoteName(noteNameFromTitle(clipNoteTitle(clip.payload)), [
    ...pass.options.takenNames(folderId),
    ...given,
  ]);
  pass.given.set(folderId, [...given, name]);
  return name;
}

/** Appends the `clipped` record: signed (`recorded`) for a person, unsigned for an agent. */
async function recordClipped(
  pass: Pass,
  noteId: string,
  clip: OpenedClip,
  at: string,
): Promise<boolean> {
  const { context } = pass;
  const { workspaceId } = context;
  try {
    await withCurrentKey(context, async (keys) => {
      const id = newId("evt");
      const actor =
        context.api.auth.kind === "session"
          ? `human:${requireIdentity(context, "addEvent").accountId}`
          : (pass.options.actor ?? "agent");
      const record = clippedRecord(clip, { actor, at });
      const sealed = encryptEvent(keys.current, { workspaceId, id }, record);
      const signing =
        context.api.auth.kind === "session"
          ? signingFields(
              signRecorded(requireIdentity(context, "addEvent"), {
                workspaceId,
                noteId,
                eventId: id,
                ciphertext: sealed.bytes,
              }),
            )
          : {};
      await context.api.call(routes.addEvent, {
        params: { workspaceId },
        body: {
          id,
          noteId: noteId as ReturnType<typeof clipNoteId>,
          noteVersion: 1,
          ciphertext: sealed.ciphertext,
          ...signing,
        },
        idempotent: true,
      });
    });
    return true;
  } catch {
    return false;
  }
}

/** Creates the clip's note at base version 0 as this client writes. */
async function createNote(
  pass: Pass,
  write: { noteId: ReturnType<typeof clipNoteId>; folderId: FolderId; name: string; text: string },
): Promise<"saved" | "duplicate" | ClipWaitReason> {
  const { context, options } = pass;
  try {
    if (context.api.auth.kind === "session") {
      const result = await writeNote(context, { ...write, baseVersion: 0 });
      return result.status === "saved" ? "saved" : "duplicate";
    }
    const result = await writeAsAgent(context, {
      ...write,
      baseVersion: 0,
      ...options.agentWrite,
    });
    switch (result.status) {
      case "saved":
        return "saved";
      case "conflict":
        return "duplicate";
      case "approval_required":
        return "review";
      case "agent_key_required":
        return "scope";
      case "rate_limited":
        return (result.retryAfterSeconds ?? 0) > PER_MINUTE_RETRY_MAX_SECONDS
          ? "daily_cap"
          : "review";
    }
  } catch (error) {
    if (isSyncApiError(error, "already_exists") || isSyncApiError(error, "conflict")) {
      return "duplicate";
    }
    if (isSyncApiError(error, "scope_denied")) return "scope";
    if (isSyncApiError(error, "not_found")) {
      return write.folderId === pass.inbox.folderId ? "inbox_folder_missing" : "new_category";
    }
    throw error;
  }
}

/** Files one claimed clip; throws only for failures that should stop the pass. */
async function fileOne(pass: Pass, queued: QueuedClip, keys: WorkspaceKeyring): Promise<Outcome> {
  const { context, options } = pass;
  const inboxKey = inboxKeyFor(keys, queued.generation);
  if (inboxKey === undefined) return { kind: "released", reason: "old_generation" };
  let opened: ReturnType<typeof openClip>;
  try {
    opened = openClip(fromBase64Url(queued.blob), inboxKey);
  } finally {
    wipe(inboxKey.privateKey);
  }
  if (!opened.ok) return { kind: "rejected", reason: opened.reason };
  const clip = opened.clip;
  const { payload } = clip;
  if (
    payload.clipId !== queued.clipId ||
    payload.extensionId !== queued.extensionId ||
    payload.workspaceId !== context.workspaceId
  ) {
    return { kind: "rejected", reason: "mismatch" };
  }
  let extension = pass.extensions.get(queued.extensionId);
  if (extension === undefined && !pass.extensionsFresh) {
    // paired since this pass read the list
    pass.extensions = await readExtensions(context);
    pass.extensionsFresh = true;
    extension = pass.extensions.get(queued.extensionId);
  }
  if (extension === undefined || !clipSignedBy(clip, extension.signPublicKey)) {
    return { kind: "rejected", reason: "bad_signature" };
  }
  if (
    extension.revokedAt !== null &&
    Date.parse(queued.postedAt) > Date.parse(extension.revokedAt)
  ) {
    return { kind: "rejected", reason: "revoked" };
  }
  let folderId = targetFolder(pass, payload.category);
  if (folderId === undefined) {
    if (options.createFolder === undefined) return { kind: "released", reason: "new_category" };
    folderId = await options.createFolder(payload.category, pass.inbox.folderId);
    pass.made.set(foldName(payload.category), folderId);
  }
  const noteId = clipNoteId(payload.clipId);
  const text = clipNoteText(payload);
  const name = noteName(pass, folderId, clip);
  const created = await createNote(pass, {
    noteId,
    folderId,
    name,
    text: options.stamp?.(text, folderId) ?? text,
  });
  if (created === "duplicate") return { kind: "duplicate" };
  if (created !== "saved") return { kind: "released", reason: created };
  const at = new Date((options.now ?? Date.now)()).toISOString();
  const recorded = await recordClipped(pass, noteId, clip, at);
  return { kind: "filed", filed: { clipId: queued.clipId, noteId, folderId, name, recorded } };
}

function readExtensions(context: SyncContext): Promise<Map<ExtensionId, VerifiedExtension>> {
  const { owner } = context.verifier;
  return fetchExtensions(context.api, {
    workspaceId: context.workspaceId,
    owner: { publicKey: owner.publicKey, accountId: owner.accountId ?? "" },
  });
}

/** Sends the acks and releases of one batch (at most 50 IDs each, as one claim gives). */
async function settle(
  context: SyncContext,
  acks: readonly ClipId[],
  releases: readonly ClipId[],
): Promise<void> {
  const params = { workspaceId: context.workspaceId };
  if (acks.length > 0) {
    await context.api.call(routes.ackClips, {
      params,
      body: { clipIds: [...acks] },
      idempotent: true,
    });
  }
  if (releases.length > 0) {
    await context.api.call(routes.releaseClips, {
      params,
      body: { clipIds: [...releases] },
      idempotent: true,
    });
  }
}

/**
 * Files the workspace's waiting clips as notes (see the steps above), as this engine's caller
 * writes: a person's session as the person (`edited`, in every folder), an agent's token with its
 * own key (`agent_edited`, only where the folder's mode is `direct`). Returns what it filed,
 * found filed already, rejected and left waiting.
 */
export async function fileClips(
  context: SyncContext,
  options: FileClipsOptions,
): Promise<FileClipsResult> {
  const filed: FiledClip[] = [];
  const duplicates: ClipId[] = [];
  const rejected: { clipId: ClipId; reason: ClipRejection }[] = [];
  const released: { clipId: ClipId; reason: ClipWaitReason }[] = [];
  const result = (status: FileClipsResult["status"]): FileClipsResult => ({
    status,
    filed,
    duplicates,
    rejected,
    released,
  });
  const { owner } = context.verifier;
  const signed = await fetchInboxKey(context.api, {
    workspaceId: context.workspaceId,
    owner,
  });
  if (signed === null) return result("no_inbox");
  const inbox = signed.envelope;
  // the signed key must be the one this client derives for its generation
  const own = await withKeys(context, (keys) => inboxKeyFor(keys, inbox.generation)).catch(
    (error: unknown) => {
      if (isVaultError(error, "missing_key")) return undefined;
      throw error;
    },
  );
  if (own !== undefined) {
    const matches = toBase64Url(own.publicKey) === inbox.publicKey;
    wipe(own.privateKey);
    if (!matches) return result("inbox_key_mismatch");
  }
  if (!options.folders.has(inbox.folderId)) return result("inbox_folder_missing");
  const pass: Pass = {
    context,
    options,
    inbox,
    extensions: await readExtensions(context),
    extensionsFresh: true,
    given: new Map(),
    made: new Map(),
  };
  const max = Math.min(Math.max(options.max ?? CLIP_QUEUE_LIMITS.claimDefault, 1), 50);
  const now = options.now ?? Date.now;
  // released clips come back at once with the next claim: each is handled once per pass
  const waiting = new Set<ClipId>();
  for (;;) {
    if (options.deadline !== undefined && now() > options.deadline) break;
    const { data } = await context.api.call(routes.claimClips, {
      params: { workspaceId: context.workspaceId },
      body: { max },
    });
    pass.extensionsFresh = false;
    const acks: ClipId[] = [];
    const releases: ClipId[] = [];
    const fresh = data.clips.filter((clip) => !waiting.has(clip.clipId));
    releases.push(...data.clips.filter((clip) => waiting.has(clip.clipId)).map((c) => c.clipId));
    let keys = await withKeys(context, (ring) => ring);
    const newest = Math.max(0, ...fresh.map((clip) => clip.generation));
    if (newest > keys.current.generation) keys = await context.keys.refresh();
    try {
      for (const [index, queued] of fresh.entries()) {
        let outcome: Outcome;
        try {
          outcome = await fileOne(pass, queued, keys);
        } catch (error) {
          // the rest wait for the next pass, at once rather than after the lease
          releases.push(...fresh.slice(index).map((clip) => clip.clipId));
          throw error;
        }
        switch (outcome.kind) {
          case "filed":
            filed.push(outcome.filed);
            acks.push(queued.clipId);
            break;
          case "duplicate":
            duplicates.push(queued.clipId);
            acks.push(queued.clipId);
            break;
          case "rejected":
            rejected.push({ clipId: queued.clipId, reason: outcome.reason });
            acks.push(queued.clipId);
            break;
          case "released":
            released.push({ clipId: queued.clipId, reason: outcome.reason });
            releases.push(queued.clipId);
            waiting.add(queued.clipId);
            break;
        }
      }
    } finally {
      await settle(context, acks, releases).catch(() => undefined);
    }
    // a short batch: the queue is empty; nothing new in this one: the rest all wait
    if (data.clips.length < max || fresh.length === 0) break;
  }
  return result("done");
}
