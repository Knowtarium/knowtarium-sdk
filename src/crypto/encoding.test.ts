import { describe, expect, it } from "vitest";

import {
  concatBytes,
  fromBase32,
  fromBase64Url,
  fromHex,
  readUint32BE,
  toBase32,
  toBase64Url,
  toHex,
  uint32BE,
  utf8Decode,
  utf8Encode,
} from "./encoding.js";

const bytes = (length: number) => Uint8Array.from({ length }, (_, i) => (i * 37 + 11) & 0xff);

describe("base64url", () => {
  it.each([0, 1, 2, 3, 4, 5, 31, 32, 33, 64])("round-trips %i bytes", (length) => {
    const data = bytes(length);
    const text = toBase64Url(data);
    expect(text).not.toMatch(/[=+/]/);
    expect(fromBase64Url(text)).toEqual(data);
  });

  it("matches RFC 4648 test vectors", () => {
    const cases = ["", "Zg", "Zm8", "Zm9v", "Zm9vYg", "Zm9vYmE", "Zm9vYmFy"];
    cases.forEach((text, length) => {
      expect(toBase64Url(utf8Encode("foobar".slice(0, length)))).toBe(text);
    });
    expect(toBase64Url(Uint8Array.of(0xfb, 0xff))).toBe("-_8");
  });

  it.each(["Zg==", "Zm9v!", "Z", "Zh", "a b"])("rejects %j", (text) => {
    expect(() => fromBase64Url(text)).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });
});

describe("base32", () => {
  it.each([1, 2, 3, 4, 5, 32, 35])("round-trips %i bytes", (length) => {
    const data = bytes(length);
    expect(fromBase32(toBase32(data), length)).toEqual(data);
  });

  it("uses Crockford's alphabet and reads O, I and L as digits", () => {
    expect(toBase32(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff))).toBe("ZZZZZZZZ");
    expect(fromBase32("oiL00000", 5)).toEqual(fromBase32("01100000", 5));
  });

  it("returns undefined for bad characters, lengths and padding bits", () => {
    expect(fromBase32("U0000000", 5)).toBeUndefined();
    expect(fromBase32("0000000", 5)).toBeUndefined();
    expect(fromBase32("01", 1)).toBeUndefined();
  });
});

describe("other encodings", () => {
  it("round-trips hex and refuses bad hex", () => {
    expect(toHex(Uint8Array.of(0, 15, 255))).toBe("000fff");
    expect(fromHex("000FfF")).toEqual(Uint8Array.of(0, 15, 255));
    expect(() => fromHex("0")).toThrow();
    expect(() => fromHex("zz")).toThrow();
  });

  it("writes and reads uint32 big-endian", () => {
    expect(uint32BE(0x01020304)).toEqual(Uint8Array.of(1, 2, 3, 4));
    expect(readUint32BE(uint32BE(0xffffffff), 0)).toBe(0xffffffff);
    expect(() => uint32BE(-1)).toThrow();
    expect(() => uint32BE(2 ** 32)).toThrow();
    expect(() => uint32BE(1.5)).toThrow();
  });

  it("decodes UTF-8 strictly", () => {
    expect(utf8Decode(utf8Encode("héllo ☃"))).toBe("héllo ☃");
    expect(() => utf8Decode(Uint8Array.of(0xff))).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });

  it("concatenates", () => {
    expect(concatBytes(Uint8Array.of(1), new Uint8Array(), Uint8Array.of(2, 3))).toEqual(
      Uint8Array.of(1, 2, 3),
    );
  });
});
