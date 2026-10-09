import { describe, expect, it } from "vitest";

import {
  attachmentChunkCountFits,
  Base64Url,
  base64UrlLength,
  Ciphertext,
  EncName,
  ENVELOPE_OVERHEAD_BYTES,
  isSupportedProtocolVersion,
  LIMITS,
  parseProtocolVersion,
  PROTOCOL_VERSION,
  PublicKey,
  Signature,
  Timestamp,
  Version,
} from "./index.js";
import { b64 } from "./test-fixtures.js";

describe("base64url", () => {
  it.each(["", "AA", "AAA", "AAAA", "ab-_", "Zm9vYmFy"])("accepts %j", (value) => {
    expect(Base64Url.safeParse(value).success).toBe(true);
  });

  it.each(["A", "AAAAA", "AA==", "a+b/", "a b", "é"])("rejects %j", (value) => {
    expect(Base64Url.safeParse(value).success).toBe(false);
  });

  it("computes unpadded lengths", () => {
    expect(base64UrlLength(32)).toBe(43);
    expect(base64UrlLength(64)).toBe(86);
    expect(base64UrlLength(16)).toBe(22);
  });
});

describe("ciphertext and keys", () => {
  it("accepts an envelope and refuses anything shorter than its overhead", () => {
    expect(Ciphertext.safeParse(b64(45)).success).toBe(true);
    expect(Ciphertext.safeParse(b64(44)).success).toBe(false);
  });

  it("caps records and names", () => {
    expect(Ciphertext.safeParse(b64(64 * 1024)).success).toBe(true);
    expect(Ciphertext.safeParse(b64(64 * 1024 + 3)).success).toBe(false);
    expect(EncName.safeParse(b64(2048)).success).toBe(false);
  });

  it("refuses plaintext in a ciphertext field", () => {
    expect(EncName.safeParse("Clients and projects, Q3 plan").success).toBe(false);
  });

  it("checks key and signature sizes", () => {
    expect(PublicKey.safeParse(b64(32)).success).toBe(true);
    expect(PublicKey.safeParse(b64(33)).success).toBe(false);
    expect(Signature.safeParse(b64(64)).success).toBe(true);
    expect(Signature.safeParse(b64(32)).success).toBe(false);
  });
});

describe("primitives", () => {
  it("takes UTC timestamps", () => {
    expect(Timestamp.safeParse("2026-09-30T12:00:00.000Z").success).toBe(true);
    expect(Timestamp.safeParse("2026-09-30").success).toBe(false);
  });

  it("takes whole non-negative versions", () => {
    expect(Version.safeParse(0).success).toBe(true);
    expect(Version.safeParse(-1).success).toBe(false);
    expect(Version.safeParse(1.5).success).toBe(false);
  });
});

describe("protocol version", () => {
  it("parses the header", () => {
    expect(parseProtocolVersion("1")).toBe(1);
    expect(parseProtocolVersion(" 1 ")).toBe(1);
    expect(parseProtocolVersion("01")).toBeNull();
    expect(parseProtocolVersion("v1")).toBeNull();
    expect(parseProtocolVersion(null)).toBeNull();
  });

  it("accepts the current version and the previous one", () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect(isSupportedProtocolVersion(String(PROTOCOL_VERSION))).toBe(true);
    expect(isSupportedProtocolVersion("1")).toBe(true);
    expect(isSupportedProtocolVersion("3")).toBe(false);
    expect(isSupportedProtocolVersion(undefined)).toBe(false);
  });
});

describe("attachmentChunkCountFits", () => {
  const max = LIMITS.attachmentChunkBytes;
  it("takes as many chunks as keep each within the limit, and no more than the size allows", () => {
    expect(attachmentChunkCountFits(46, 1)).toBe(true);
    expect(attachmentChunkCountFits(46 * 3, 3)).toBe(true);
    expect(attachmentChunkCountFits(46 * 3 - 1, 3)).toBe(false);
    expect(attachmentChunkCountFits(max, 1)).toBe(true);
    expect(attachmentChunkCountFits(max + 1, 1)).toBe(false);
    expect(attachmentChunkCountFits(max + 1, 2)).toBe(true);
    // one empty envelope (an empty file) is allowed, but never more chunks than that
    expect(attachmentChunkCountFits(ENVELOPE_OVERHEAD_BYTES, 1)).toBe(true);
    expect(attachmentChunkCountFits(ENVELOPE_OVERHEAD_BYTES * 2, 2)).toBe(false);
    expect(attachmentChunkCountFits(100, 0)).toBe(false);
    expect(attachmentChunkCountFits(100, 1.5)).toBe(false);
  });
});
