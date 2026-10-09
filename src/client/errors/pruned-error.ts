/**
 * A note version whose content the server removed after the workspace's history period (it
 * answered 410 `expired`). The version stays listed (`NoteVersion.pruned`) with its signed event,
 * so the history still shows who wrote it and when; only its content is gone, for good. Callers
 * that need an old version's text (a merge base, a restore, a diff) go on without it or say so.
 */
export class VersionPrunedError extends Error {
  override readonly name = "VersionPrunedError";

  constructor(
    readonly noteId: string,
    readonly version: number,
  ) {
    super(`version ${String(version)} was removed after the workspace's history period`);
  }
}

/** Whether `error` is a `VersionPrunedError`. */
export function isVersionPruned(error: unknown): error is VersionPrunedError {
  return error instanceof VersionPrunedError;
}
