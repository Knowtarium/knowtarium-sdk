export { isSyncApiError, SyncApiError } from "./api-error.js";
export {
  InvalidResponseError,
  NetworkError,
  RequestValidationError,
  SyncStoppedError,
} from "./transport-error.js";
export { isVaultError, NoteTooLargeError, VaultError, type VaultErrorCode } from "./vault-error.js";
export { isVersionPruned, VersionPrunedError } from "./pruned-error.js";
export { AttachmentTooLargeError, StorageFullError } from "./storage-error.js";
