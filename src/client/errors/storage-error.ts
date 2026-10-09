import type { Usage } from "../../protocol/index.js";

/** An attachment over the protocol's size limit (`LIMITS.attachmentBytes`). Nothing was sent. */
export class AttachmentTooLargeError extends Error {
  override readonly name = "AttachmentTooLargeError";

  constructor(
    /** The encrypted size, in bytes. */
    readonly bytes: number,
    /** The limit, in bytes. */
    readonly limit: number,
  ) {
    const mib = (value: number) => (value / (1024 * 1024)).toFixed(0);
    super(`This file is too large to attach: the limit is ${mib(limit)} MiB.`);
  }
}

/**
 * The workspace's storage is full: the server refused a new upload before any bytes were stored
 * (`quota_exceeded`). `usage` is what the server reported.
 */
export class StorageFullError extends Error {
  override readonly name = "StorageFullError";

  constructor(readonly usage: Usage) {
    super(
      `The storage is full (${String(usage.usedBytes)} of ${String(usage.quotaBytes)} bytes used); free space or change plan.`,
    );
  }
}
