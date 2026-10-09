import { describe, expect, it } from "vitest";

import { canonicalJson, type JsonValue } from "./canonical-json.js";

describe("canonicalJson", () => {
  it("sorts keys at every level and drops whitespace", () => {
    expect(canonicalJson({ b: { d: 1, c: [2, { f: 3, e: 4 }] }, a: null })).toBe(
      '{"a":null,"b":{"c":[2,{"e":4,"f":3}],"d":1}}',
    );
  });

  it("writes -0 as 0 and accepts the safe integer range", () => {
    expect(canonicalJson([-0, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER])).toBe(
      "[0,9007199254740991,-9007199254740991]",
    );
  });

  it("allows a repeated (not cyclic) reference", () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
    expect(canonicalJson(Object.assign(Object.create(null) as object, { k: 1 }) as JsonValue)).toBe(
      '{"k":1}',
    );
  });

  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a fraction", 0.1],
    ["an unsafe integer", 2 ** 53],
    ["undefined", undefined],
    ["an undefined property", { a: undefined }],
    ["a bigint", 1n],
    ["a function", () => 1],
    ["a Date", new Date(0)],
    ["a Map", new Map()],
    ["a cycle", cyclic],
    ["a lone surrogate", "\uD83D"],
  ])("refuses %s", (_, value) => {
    expect(() => canonicalJson(value as JsonValue)).toThrow(
      expect.objectContaining({ code: "non_canonical_json" }),
    );
  });
});
