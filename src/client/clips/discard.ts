import {
  type ClipId,
  CLIP_QUEUE_LIMITS,
  type ExtensionId,
  routes,
  type WorkspaceId,
} from "../../protocol/index.js";
import type { ApiClient } from "../api/index.js";
import { RequestValidationError } from "../errors/index.js";

/**
 * Discards the clips waiting in a workspace's queue without opening them (session, the workspace
 * owner: the web app's "Discard waiting clips"), or only those one extension posted: claims them
 * in batches of 50 and acks them; a claimed clip of another extension keeps its lease until the
 * end, so the next claim reaches the ones behind it, and is then released. Clips another filer
 * holds under a live lease aren't reached. Returns how many were discarded.
 */
export async function discardClips(
  api: ApiClient,
  details: { readonly workspaceId: WorkspaceId; readonly extensionId?: ExtensionId },
): Promise<{ readonly discarded: number }> {
  if (api.auth.kind !== "session") throw new RequestValidationError("ackClips", "auth");
  const params = { workspaceId: details.workspaceId };
  const max = CLIP_QUEUE_LIMITS.claimMax;
  const held: ClipId[] = [];
  let discarded = 0;
  try {
    // a full queue is 20 batches; a few more for clips posted meanwhile
    for (let batch = 0; batch < CLIP_QUEUE_LIMITS.pendingClips / max + 5; batch++) {
      const { data } = await api.call(routes.claimClips, { params, body: { max } });
      const acks: ClipId[] = [];
      for (const clip of data.clips) {
        if (details.extensionId === undefined || clip.extensionId === details.extensionId) {
          acks.push(clip.clipId);
        } else {
          held.push(clip.clipId);
        }
      }
      if (acks.length > 0) {
        await api.call(routes.ackClips, { params, body: { clipIds: acks }, idempotent: true });
        discarded += acks.length;
      }
      if (data.clips.length < max) break;
    }
  } finally {
    for (let start = 0; start < held.length; start += max) {
      await api
        .call(routes.releaseClips, {
          params,
          body: { clipIds: held.slice(start, start + max) },
          idempotent: true,
        })
        .catch(() => undefined);
    }
  }
  return { discarded };
}
