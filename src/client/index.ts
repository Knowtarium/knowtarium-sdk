/**
 * `knowtarium/client`: the client layer the web app and the CLI share. A typed API client over
 * the protocol's route table (`api`), the vault helpers that encrypt, sign and verify with
 * `knowtarium/crypto` and hold the device's rollback marks (`vault`), the sync engine (`sync`),
 * the live ping connection (`live`) and the encrypted cache (`cache`). Only ciphertext, IDs and
 * numbers leave it; plaintext stays in the caller's memory.
 */
export * from "./api/index.js";
export * from "./attachments/index.js";
export * from "./cache/index.js";
export * from "./errors/index.js";
export * from "./history/index.js";
export * from "./live/index.js";
export type { AbortSignalLike } from "./platform/abort.js";
export type { FetchInit, FetchLike, FetchResponse } from "./platform/fetch.js";
export { newId } from "./platform/ids.js";
export { type Scheduler, systemScheduler, type TimerHandle } from "./platform/timers.js";
export * from "./sync/index.js";
export * from "./vault/index.js";
