import { describe, expect, it } from "vitest";

import { fixtureId, loadFixtureWorkspace } from "../../../test/fixture-workspace.js";
import { actorKind, deriveTrustTier, readProvenance } from "../index.js";

const workspace = loadFixtureWorkspace();
const frontmatterOf = (path: string) => workspace.notes.get(fixtureId(path))?.frontmatter ?? {};

describe("actorKind", () => {
  it.each([
    ["human:sara", "human"],
    ["claude-code/2.1", "agent"],
    ["agent:importer", "agent"],
    ["process:ci", "agent"],
    ["humans:sara", "agent"],
    ["human:", "agent"],
  ])("reads %s as %s", (by, kind) => {
    expect(actorKind(by)).toBe(kind);
  });
});

describe("deriveTrustTier", () => {
  it("is unverified with no verified entries", () => {
    expect(deriveTrustTier({})).toEqual({ tier: "unverified", counted: [] });
    expect(deriveTrustTier({ verified: [] }).tier).toBe("unverified");
    expect(deriveTrustTier(frontmatterOf("notes/custom-keys.md")).tier).toBe("unverified");
  });

  it("is machine-confirmed when only agents and processes verified it", () => {
    const result = deriveTrustTier({
      verified: [
        { by: "process:ci", at: "2026-09-01" },
        { by: "claude-code/2.1", at: "2026-09-02T00:00:00Z" },
      ],
    });
    expect(result.tier).toBe("machine-confirmed");
    expect(result.counted.map((entry) => entry.by)).toEqual(["process:ci", "claude-code/2.1"]);
    expect(deriveTrustTier(frontmatterOf("research/churn.md")).tier).toBe("machine-confirmed");
  });

  it("is human-reviewed with at least one person, and lists only the people as counted", () => {
    const result = deriveTrustTier(frontmatterOf("research/pricing.md"));
    expect(result.tier).toBe("human-reviewed");
    expect(result.counted).toEqual([
      {
        by: "human:ada",
        kind: "human",
        at: "2026-09-20T09:00:00Z",
        time: Date.UTC(2026, 8, 20, 9),
        index: 0,
      },
    ]);
  });

  it("counts entries whatever their date, as the spec does", () => {
    // the checks predate the change: still human-reviewed as a tier (the state says otherwise)
    expect(deriveTrustTier(frontmatterOf("decisions/old-review.md")).tier).toBe("human-reviewed");
    expect(deriveTrustTier({ verified: [{ by: "human:a", at: "not a date" }] }).tier).toBe(
      "human-reviewed",
    );
  });

  it("never counts a bare human: as a person or as a machine", () => {
    const result = deriveTrustTier({ verified: [{ by: "human:", at: "2026-09-01" }] });
    expect(result.tier).toBe("unverified");
    expect(readProvenance({ verified: [{ by: "human: " }] }).unreadable).toHaveLength(1);
    expect(readProvenance({ generated: { by: "human:" } }).generated).toBeNull();
  });

  it("accepts a single mapping, and skips items without an actor", () => {
    expect(deriveTrustTier({ verified: { by: "human:a", at: "2026-09-01" } }).tier).toBe(
      "human-reviewed",
    );
    const provenance = readProvenance({
      verified: [{ at: "2026-09-01" }, "human:a", { by: "  " }, { by: "process:ci" }],
    });
    expect(provenance.verified.map((entry) => [entry.index, entry.by, entry.at])).toEqual([
      [3, "process:ci", null],
    ]);
    expect(provenance.unreadable.map((entry) => entry.index)).toEqual([0, 1, 2]);
    expect(deriveTrustTier({ verified: "human:a" }).tier).toBe("unverified");
  });
});

describe("readProvenance", () => {
  it("reads generated, with dates in any of the OKF forms", () => {
    expect(readProvenance(frontmatterOf("notes/custom-keys.md")).generated).toEqual({
      by: "agent:importer",
      kind: "agent",
      at: "2026-09-22T08:00:00Z",
      time: Date.UTC(2026, 8, 22, 8),
    });
    const offset = readProvenance({
      generated: { by: "human:a", at: "2026-09-22T10:00:00+02:00" },
    });
    expect(offset.generated?.time).toBe(Date.UTC(2026, 8, 22, 8));
    const date = readProvenance({
      generated: { by: "human:a", at: new Date(Date.UTC(2026, 0, 2)) },
    });
    expect(date.generated?.at).toBe("2026-01-02T00:00:00.000Z");
  });

  it("never throws on malformed values", () => {
    for (const value of [null, 3, "x", [], { by: 3 }, { by: "human:a", at: { nested: true } }]) {
      expect(() => readProvenance({ generated: value, verified: value })).not.toThrow();
    }
    expect(readProvenance({ generated: { by: "human:a", at: [1] } }).generated).toMatchObject({
      at: "(a list)",
      time: null,
    });
    expect(readProvenance({ generated: { by: "human:a" } }).generated?.at).toBeNull();
  });
});
