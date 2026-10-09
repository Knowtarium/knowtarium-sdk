/** The OKF spec version this package targets. */
export const OKF_SPEC_VERSION = "0.2";

/** Files with a fixed role in every folder: `index.md` is its home, `log.md` its activity feed. */
export const RESERVED_FILES = ["index.md", "log.md"] as const;

export type ReservedFile = (typeof RESERVED_FILES)[number];

/** Whether a workspace-relative path is a folder's reserved file (`index.md` or `log.md`). */
export function isReservedFile(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  return (RESERVED_FILES as readonly string[]).includes(name);
}
