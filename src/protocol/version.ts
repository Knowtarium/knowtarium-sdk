/**
 * The protocol version this package speaks. Bumped on any breaking change to a route or schema.
 *
 * Version 2 added agents' own signing keys and direct writes: the `agent_policy`, `agent_key` and
 * `agent_edited` envelopes, `writeNoteAsAgent` and the agent policy routes. A version 1 client
 * can't parse those envelopes, so the server answers it `unsupported_protocol` (an update notice)
 * instead of sending one (`envelopeProtocolVersion`).
 */
export const PROTOCOL_VERSION = 2;

/**
 * Versions the sync API accepts: the current one and the previous one, so the web app and the CLI
 * can update at different times.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [1, PROTOCOL_VERSION];

/** Parses a `Knowtarium-Protocol-Version` header value; null when missing or not a positive integer. */
export function parseProtocolVersion(value: string | null | undefined): number | null {
  if (value == null || !/^[1-9][0-9]{0,5}$/.test(value.trim())) return null;
  return Number(value.trim());
}

/** Whether a `Knowtarium-Protocol-Version` header value names a version the sync API accepts. */
export function isSupportedProtocolVersion(value: string | null | undefined): boolean {
  const version = parseProtocolVersion(value);
  return version !== null && SUPPORTED_PROTOCOL_VERSIONS.includes(version);
}
