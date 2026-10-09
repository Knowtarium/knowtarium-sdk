export {
  buildThreads,
  type CommentEntry,
  CommentRecord,
  type CommentThread,
  type CommentThreads,
  isConflictFlag,
  newComment,
  withStatus,
} from "./comments.js";
export { type DiffPart, lineDiff, type TextDiff, wordDiff } from "./diff.js";
export {
  CheckConflict,
  CheckFindings,
  EventRecord,
  type EventSource,
  type HistoryEvent,
  readHistoryEvent,
  type SignatureStatus,
  type SignedFields,
} from "./events.js";
export {
  type ConflictChoice,
  type MergeConflict,
  type MergeInput,
  mergeNotes,
  type NoteMerge,
  type NoteMergeHunk,
  resolveMerge,
  withConflictMarkers,
} from "./merge.js";
export { type RestoreOptions, restoreText } from "./restore.js";
export {
  buildTimeline,
  type CheckEntry,
  type HistoryEventEntry,
  lastFullyVerifiedVersion,
  type Timeline,
  type TimelineEntry,
  type TimelineInput,
  type VersionInfo,
} from "./timeline.js";
