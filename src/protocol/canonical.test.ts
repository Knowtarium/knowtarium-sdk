import { describe, expect, it } from "vitest";

import { canonicalJson } from "./index.js";

describe("canonicalJson", () => {
  it("sorts keys and leaves no whitespace", () => {
    expect(canonicalJson({ type: "edited", b: 2, a: "x" })).toBe('{"a":"x","b":2,"type":"edited"}');
  });

  it("leaves out absent fields", () => {
    expect(canonicalJson({ a: "x", version: undefined })).toBe('{"a":"x"}');
    expect(canonicalJson({})).toBe("{}");
  });

  it("escapes strings as JSON does", () => {
    expect(canonicalJson({ a: 'q"\\\n' })).toBe('{"a":"q\\"\\\\\\n"}');
  });

  it("takes integers only", () => {
    expect(canonicalJson({ v: 0, w: -3 })).toBe('{"v":0,"w":-3}');
    expect(() => canonicalJson({ v: 1.5 })).toThrow(TypeError);
    expect(() => canonicalJson({ v: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ v: 2 ** 53 })).toThrow(TypeError);
  });

  it("refuses other value types", () => {
    const bad = { v: true } as unknown as Record<string, string>;
    expect(() => canonicalJson(bad)).toThrow(TypeError);
  });

  it("refuses anything but a record", () => {
    for (const value of [[1, 2], null, "x"]) {
      expect(() => canonicalJson(value as unknown as Record<string, string>)).toThrow(TypeError);
    }
  });
});
