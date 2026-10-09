import { z } from "zod";

import {
  AttachmentId,
  CheckId,
  CommentId,
  ConnectRequestId,
  FolderId,
  NoteId,
  PendingId,
  SessionId,
  TokenId,
  WorkspaceId,
} from "./ids.js";

/** The schema of every path parameter a route may use (`:workspaceId` and so on). */
export const PARAM_SCHEMAS = {
  workspaceId: WorkspaceId,
  folderId: FolderId,
  noteId: NoteId,
  version: z.coerce.number().int().positive(),
  pendingId: PendingId,
  commentId: CommentId,
  checkId: CheckId,
  tokenId: TokenId,
  sessionId: SessionId,
  requestId: ConnectRequestId,
  attachmentId: AttachmentId,
  chunkIndex: z.coerce.number().int().nonnegative(),
} as const;

export type ParamName = keyof typeof PARAM_SCHEMAS;

export function isParamName(name: string): name is ParamName {
  return Object.hasOwn(PARAM_SCHEMAS, name);
}
