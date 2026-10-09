import { describe, expect, it } from "vitest";

import {
  FIXTURE_VERIFICATION_STATES,
  fixtureId,
  fixtureText,
  loadFixtureWorkspace,
} from "../../../test/fixture-workspace.js";
import {
  addVerified,
  type CheckRecordSignal,
  deriveVerification,
  type HumanEntryRef,
  parseNote,
  restoreText,
  setGenerated,
  type VerificationSignals,
  verifiedEntryKey,
} from "../index.js";

const NOW = Date.UTC(2026, 8, 30, 12);
const CHANGE = "2026-09-29T10:00:00Z";
const LATER = "2026-09-29T11:00:00Z";
const EARLIER = "2026-09-28T10:00:00Z";

// frontmatter-only cases use the plain OKF mode explicitly; the app's mode is tested below
const TRUST = { humanEntries: "trust-frontmatter" } as const;
const NOTE = { noteId: "note_1", version: 4 };
const confirmedBy = (entries: HumanEntryRef[]): VerificationSignals => ({
  humanEntries: { confirmed: entries },
  note: NOTE,
});

const derive = (frontmatter: Record<string, unknown>, signals: VerificationSignals = TRUST) =>
  deriveVerification(frontmatter, { now: NOW, ...signals });

const note = (by: string, verified: { by: string; at: string }[] = [], extra = {}) => ({
  generated: { by, at: CHANGE },
  verified,
  ...extra,
});

describe("the fixture workspace", () => {
  const workspace = loadFixtureWorkspace();

  it.each(Object.entries(FIXTURE_VERIFICATION_STATES))("%s is %s", (path, state) => {
    const frontmatter = workspace.notes.get(fixtureId(path))?.frontmatter ?? {};
    expect(derive(frontmatter).state).toBe(state);
  });

  it("keeps the check state under stale", () => {
    const frontmatter = workspace.notes.get(fixtureId("decisions/annual-plans.md"))?.frontmatter;
    const result = derive(frontmatter ?? {});
    expect(result.checkState).toBe("fully-verified");
    expect(result.reasons[0]?.code).toBe("stale");
  });

  it("never disagrees with the OKF tier: a person's check means human-reviewed", () => {
    for (const note of workspace.notes.values()) {
      for (const signals of [TRUST, confirmedBy([])]) {
        const result = derive(note.frontmatter, signals);
        if (result.humanChecks.length > 0) {
          expect(result.tier.tier).toBe("human-reviewed");
          expect(result.confirmedTier.tier).toBe("human-reviewed");
        }
        if (result.tier.tier === "unverified") {
          expect(["waiting-for-human", "stale"]).toContain(result.state);
        }
      }
    }
  });
});

describe("agent edits", () => {
  it("waits for a person, with or without the agent's own check", () => {
    const own = derive(note("claude-code/2.1", [{ by: "claude-code/2.1", at: CHANGE }]));
    expect(own.state).toBe("waiting-for-human");
    expect(own.reasons[0]).toMatchObject({ code: "no-human-check" });
    expect(own.agentChecks.map((check) => check.source)).toEqual(["authorship", "frontmatter"]);

    const bare = derive(note("claude-code/2.1"));
    expect(bare.state).toBe("waiting-for-human");
    expect(bare.agentChecks.map((check) => check.source)).toEqual(["authorship"]);
  });

  it("is fully verified once a person approves, with or without the agent's own check", () => {
    const approved = [{ by: "human:sara", at: LATER }];
    expect(derive(note("claude-code/2.1", approved)).state).toBe("fully-verified");
    const withOwn = derive(
      note("claude-code/2.1", [{ by: "claude-code/2.1", at: CHANGE }, ...approved]),
    );
    expect(withOwn.state).toBe("fully-verified");
    expect(withOwn.reasons.map((reason) => reason.code)).toEqual([
      "human-check",
      "agent-authored",
      "agent-check",
    ]);
  });

  it("goes through the real edits: propose, then approve with addVerified", () => {
    let parsed = parseNote("---\ntitle: A\n---\nBody\n");
    parsed = setGenerated(parsed, "codex/1.4", CHANGE);
    parsed = addVerified(parsed, "codex/1.4", CHANGE);
    expect(derive(parsed.frontmatter?.data ?? {}).state).toBe("waiting-for-human");
    parsed = addVerified(parsed, "human:ada", LATER);
    expect(derive(parsed.frontmatter?.data ?? {}).state).toBe("fully-verified");
  });
});

describe("a person's edits", () => {
  it("is agent check pending without an agent check", () => {
    const result = derive(note("human:sara", [{ by: "human:sara", at: CHANGE }]));
    expect(result.state).toBe("agent-check-pending");
    expect(result.tier.tier).toBe("human-reviewed");
    expect(result.reasons.map((reason) => reason.code)).toEqual(["no-agent-check", "human-check"]);
  });

  it("is fully verified with an agent check after it", () => {
    const result = derive(
      note("human:sara", [
        { by: "human:sara", at: CHANGE },
        { by: "claude-code/2.1", at: LATER },
      ]),
    );
    expect(result.state).toBe("fully-verified");
    expect(result.humanChecks.map((check) => check.by)).toEqual(["human:sara"]);
    expect(result.agentChecks.map((check) => check.by)).toEqual(["claude-code/2.1"]);
  });

  it("does not count the person's authorship as a check", () => {
    expect(derive(note("human:sara")).state).toBe("waiting-for-human");
  });
});

describe("dates", () => {
  it("ignores checks older than the change, and keeps them listed", () => {
    const result = derive(
      note("human:sara", [
        { by: "human:sara", at: EARLIER },
        { by: "claude-code/2.1", at: EARLIER },
      ]),
    );
    expect(result.state).toBe("waiting-for-human");
    expect(result.checks.map((check) => check.status)).toEqual(["before-change", "before-change"]);
    expect(result.reasons.at(-1)).toMatchObject({
      code: "outdated-checks",
      message: "2 checks predate the change and no longer count.",
    });
    // the tier still counts them, as the spec does
    expect(result.tier.tier).toBe("human-reviewed");
  });

  it("counts a check at exactly the change time, in any zone", () => {
    const sameInstant = "2026-09-29T12:00:00+02:00";
    const result = derive(
      note("human:sara", [
        { by: "human:sara", at: sameInstant },
        { by: "process:ci", at: CHANGE },
      ]),
    );
    expect(result.state).toBe("fully-verified");
  });

  it("uses every entry when several are in the list", () => {
    const result = derive(
      note("human:sara", [
        { by: "human:old", at: EARLIER },
        { by: "process:ci", at: EARLIER },
        { by: "human:sara", at: CHANGE },
        { by: "claude-code/2.1", at: "not a date" },
      ]),
    );
    expect(result.state).toBe("agent-check-pending");
    expect(result.checks.map((check) => [check.index, check.status])).toEqual([
      [0, "before-change"],
      [1, "before-change"],
      [2, "counted"],
      [3, "invalid-date"],
    ]);
    expect(result.reasons.map((reason) => reason.code)).toContain("invalid-date");
  });

  it("counts every dated check when there is no generated entry", () => {
    const result = derive({ verified: [{ by: "human:a", at: EARLIER }, { by: "process:ci" }] });
    expect(result.state).toBe("agent-check-pending");
    expect(result.change).toBeNull();
    expect(result.reasons.map((reason) => reason.code)).toContain("no-change-recorded");
  });

  it("counts nothing against a change with a missing or malformed date, without throwing", () => {
    for (const at of ["yesterday", undefined, 12, "2026-02-30"]) {
      const result = derive({
        generated: { by: "human:sara", at },
        verified: [
          { by: "human:sara", at: LATER },
          { by: "process:ci", at: LATER },
        ],
      });
      expect(result.state).toBe("waiting-for-human");
      expect(result.checks.every((check) => check.status === "change-date-unknown")).toBe(true);
      expect(result.reasons.map((reason) => reason.code)).toContain("change-date-unknown");
    }
  });

  it("never throws on malformed frontmatter", () => {
    for (const value of [null, 1, "x", [], [null], { by: 1 }]) {
      expect(() => derive({ generated: value, verified: value, stale_after: value })).not.toThrow();
    }
  });
});

describe("stale", () => {
  it("overrides every other state", () => {
    const stale = { stale_after: "2026-09-01" };
    const cases = [
      note("claude-code/2.1", [], stale),
      note("human:sara", [{ by: "human:sara", at: CHANGE }], stale),
      note(
        "human:sara",
        [
          { by: "human:sara", at: CHANGE },
          { by: "process:ci", at: CHANGE },
        ],
        stale,
      ),
    ];
    const checks: CheckRecordSignal[] = [
      { noteId: "note_1", by: "claude-code/2.1", at: LATER, version: 3, result: "fail" },
    ];
    for (const frontmatter of cases) {
      expect(derive(frontmatter).state).toBe("stale");
      expect(derive(frontmatter, { ...TRUST, note: { ...NOTE, version: 3 }, checks }).state).toBe(
        "stale",
      );
    }
    const first = cases[0] ?? {};
    expect(derive(first, { ...TRUST, note: { ...NOTE, version: 3 }, checks }).checkState).toBe(
      "conflict",
    );
  });
});

describe("signed events (unconfirmed human entries)", () => {
  const frontmatter = note("claude-code/2.1", [{ by: "human:sara", at: LATER }]);
  const sara = (fields: Partial<HumanEntryRef> = {}): HumanEntryRef => ({
    noteId: "note_1",
    version: 4,
    by: "human:sara",
    at: LATER,
    ...fields,
  });

  it("counts every human entry only in the explicit plain OKF mode", () => {
    const result = derive(frontmatter, TRUST);
    expect(result.state).toBe("fully-verified");
    expect(result.unconfirmed).toEqual([]);
    expect(result.confirmedTier).toEqual(result.tier);
  });

  it("requires a human-entry mode: leaving it out doesn't type-check", () => {
    // @ts-expect-error the mode is required, so nothing falls back to trusting the frontmatter
    const options: Parameters<typeof deriveVerification>[1] = { now: NOW };
    expect(options.now).toBe(NOW);
  });

  it("does not count a human entry without a matching signed event", () => {
    const result = derive(frontmatter, confirmedBy([]));
    expect(result.state).toBe("waiting-for-human");
    expect(result.unconfirmed.map((entry) => entry.by)).toEqual(["human:sara"]);
    expect(result.checks.find((check) => check.kind === "human")?.status).toBe("unconfirmed");
    expect(result.reasons.map((reason) => reason.code)).toEqual([
      "no-human-check",
      "agent-authored",
      "unconfirmed-human-check",
    ]);
    // the OKF tier reads the frontmatter; the confirmed tier leaves the unconfirmed entry out
    expect(result.tier.tier).toBe("human-reviewed");
    expect(result.confirmedTier.tier).toBe("unverified");
  });

  it("matches signed events by note, version, actor and instant", () => {
    const state = (entries: HumanEntryRef[]) => derive(frontmatter, confirmedBy(entries)).state;
    expect(state([sara({ at: "2026-09-29T13:00:00+02:00" })])).toBe("fully-verified");
    expect(state([sara({ at: new Date(Date.parse(LATER)) })])).toBe("fully-verified");
    // an event from an earlier version still confirms the entry it added
    expect(state([sara({ version: 2 })])).toBe("fully-verified");
    expect(state([sara({ by: "human:sam" })])).toBe("waiting-for-human");
    expect(state([sara({ noteId: "note_2" })])).toBe("waiting-for-human");
    expect(state([sara({ version: 5 })])).toBe("waiting-for-human");
    expect(state([sara({ at: CHANGE })])).toBe("waiting-for-human");
    expect(verifiedEntryKey("human:sara", LATER)).toBe(
      verifiedEntryKey(" human:sara", Date.parse(LATER)),
    );
  });

  it("lists old unconfirmed entries too, without counting them either way", () => {
    const result = derive(note("human:sara", [{ by: "human:x", at: EARLIER }]), confirmedBy([]));
    expect(result.unconfirmed.map((entry) => entry.by)).toEqual(["human:x"]);
    expect(result.checks[0]?.status).toBe("before-change");
  });

  it("never treats a bare human: as a person", () => {
    const bare = note("claude-code/2.1", [{ by: "human:", at: LATER }]);
    const result = derive(bare, TRUST);
    expect(result.state).toBe("waiting-for-human");
    expect(result.tier.tier).toBe("unverified");
    expect(result.checks.map((check) => check.source)).toEqual(["authorship"]);
  });
});

describe("unapplied check records", () => {
  const humanEdit = note("human:sara", [{ by: "human:sara", at: CHANGE }]);
  // sara's edit produced version 3; the agent's pass (applied or not) belongs to version 4
  const signed: HumanEntryRef = { noteId: "note_1", version: 3, by: "human:sara", at: CHANGE };
  const withChecks = (checks: CheckRecordSignal[], current = NOTE): VerificationSignals => ({
    humanEntries: { confirmed: [signed] },
    note: current,
    checks,
  });
  const record = (fields: Partial<CheckRecordSignal>): CheckRecordSignal => ({
    id: "chk_1",
    noteId: "note_1",
    by: "claude-code/2.1",
    at: LATER,
    version: 4,
    result: "pass",
    ...fields,
  });

  it("counts a passing record for the current version as the agent check", () => {
    const result = derive(humanEdit, withChecks([record({})]));
    expect(result.state).toBe("fully-verified");
    expect(result.unappliedPasses.map((check) => check.id)).toEqual(["chk_1"]);
    expect(result.reasons.map((reason) => reason.code)).toEqual([
      "human-check",
      "agent-check-unapplied",
    ]);
  });

  it("makes a failing record a conflict", () => {
    const result = derive(humanEdit, withChecks([record({ result: "fail" })]));
    expect(result.state).toBe("conflict");
    expect(result.conflicts.map((check) => check.id)).toEqual(["chk_1"]);
    expect(result.reasons[0]).toMatchObject({ code: "conflict", by: "claude-code/2.1" });
    expect(result.reasons[0]?.message).toContain("version 4");
  });

  it("ignores records for another version or another note", () => {
    const result = derive(
      humanEdit,
      withChecks(
        [
          record({ result: "fail" }),
          record({ id: "chk_2" }),
          record({ noteId: "note_2", version: 5 }),
        ],
        { ...NOTE, version: 5 },
      ),
    );
    expect(result.state).toBe("agent-check-pending");
    expect(result.checks.slice(1).map((check) => check.status)).toEqual([
      "other-version",
      "other-version",
      "other-version",
    ]);
  });

  it("keeps only each agent's latest record for the version", () => {
    const fixed = derive(
      humanEdit,
      withChecks([record({ id: "old", result: "fail", at: CHANGE }), record({ id: "new" })]),
    );
    expect(fixed.state).toBe("fully-verified");
    expect(fixed.checks.map((check) => check.status)).toEqual(["counted", "superseded", "counted"]);

    const twoAgents = derive(
      humanEdit,
      withChecks([record({ id: "a" }), record({ id: "b", by: "codex/1.4", result: "fail" })]),
    );
    expect(twoAgents.state).toBe("conflict");
  });

  it("lets a later verified entry by the same agent replace a failing record", () => {
    const fixedLater = note("human:sara", [
      { by: "human:sara", at: CHANGE },
      { by: "claude-code/2.1", at: "2026-09-29T12:00:00Z" },
    ]);
    const result = derive(fixedLater, withChecks([record({ result: "fail" })]));
    expect(result.state).toBe("fully-verified");
    expect(result.conflicts).toEqual([]);
    expect(result.checks.map((check) => check.status)).toEqual([
      "counted",
      "counted",
      "superseded",
    ]);

    // the other way round: a failing record after the agent's entry is the latest word
    const failedLater = derive(
      fixedLater,
      withChecks([record({ result: "fail", at: "2026-09-29T13:00:00Z" })]),
    );
    expect(failedLater.state).toBe("conflict");
    expect(failedLater.checks[1]?.status).toBe("superseded");
    // another agent's entry doesn't replace it
    const other = note("human:sara", [
      { by: "human:sara", at: CHANGE },
      { by: "codex/1.4", at: "2026-09-29T12:00:00Z" },
    ]);
    expect(derive(other, withChecks([record({ result: "fail" })])).state).toBe("conflict");
  });

  it("matches records by time when the note version isn't known (plain OKF mode)", () => {
    expect(derive(humanEdit, { ...TRUST, checks: [record({ at: LATER })] }).state).toBe(
      "fully-verified",
    );
    const old = derive(humanEdit, { ...TRUST, checks: [record({ at: EARLIER, result: "fail" })] });
    expect(old.state).toBe("agent-check-pending");
    expect(old.checks[1]?.status).toBe("before-change");
  });

  it("refuses records that claim to be by a person, a bare human: included", () => {
    const agentEdit = note("claude-code/2.1");
    for (const by of ["human:sara", "human:"]) {
      const result = derive(agentEdit, withChecks([record({ by })]));
      expect(result.state).toBe("waiting-for-human");
      expect(result.checks.at(-1)?.status).toBe("invalid-actor");
    }
  });
});

describe("with the note text as input", () => {
  it("works from parsed frontmatter alone", () => {
    const parsed = parseNote(fixtureText("research/pricing.md"));
    const result = derive(parsed.frontmatter?.data ?? {});
    expect(result.state).toBe("fully-verified");
    expect(result.change).toMatchObject({ by: "human:ada", kind: "human" });
    expect(result.freshness.status).toBe("fresh");
  });
});

describe("a person's edit, an agent's passing check, then the check applied", () => {
  // version 2: the person's edit (their entry confirmed by its signed write); version 3: the
  // applied check adds the agent's entry, signed `check_applied`, which confirms no person
  const edited = note("human:maya", [{ by: "human:maya", at: CHANGE }]);
  const applied = note("human:maya", [
    { by: "human:maya", at: CHANGE },
    { by: "claude-code/2.1", at: LATER },
  ]);
  const confirmed = [{ noteId: "note_1", version: 2, by: "human:maya", at: CHANGE }];

  it("waits for the check after the edit, and is fully verified once it is applied", () => {
    const atEdit = deriveVerification(edited, {
      now: NOW,
      humanEntries: { confirmed },
      note: { noteId: "note_1", version: 2 },
    });
    expect(atEdit.checkState).toBe("agent-check-pending");
    const atApplied = deriveVerification(applied, {
      now: NOW,
      humanEntries: { confirmed },
      note: { noteId: "note_1", version: 3 },
    });
    expect(atApplied.checkState).toBe("fully-verified");
    // without the earlier write's confirmation, the person's entry wouldn't count
    const unconfirmed = deriveVerification(applied, {
      now: NOW,
      humanEntries: { confirmed: [] },
      note: { noteId: "note_1", version: 3 },
    });
    expect(unconfirmed.checkState).toBe("waiting-for-human");
  });
});

describe("an agent's direct write, then a person's undo", () => {
  // version 1: the person's edit, confirmed by its signed write; version 2: an agent's direct
  // write (`agent_edited`), which confirms no person; version 3: the person's undo
  const mine = `---\ntitle: Pricing\ngenerated: { by: "human:maya", at: "${EARLIER}" }\nverified:\n  - { by: "human:maya", at: "${EARLIER}" }\n---\n$20\n`;
  const confirmed = [{ noteId: "note_1", version: 1, by: "human:maya", at: EARLIER }];
  const signals = (version: number, extra: HumanEntryRef[] = []): VerificationSignals => ({
    humanEntries: { confirmed: [...confirmed, ...extra] },
    note: { noteId: "note_1", version },
  });

  it("waits for a person after the agent's write, whatever entries the agent kept or added", () => {
    const agents = note("claude-code/2.1", [
      { by: "human:maya", at: EARLIER },
      // an agent can write a person's name into the note, but nothing signed backs it
      { by: "human:maya", at: LATER },
    ]);
    const result = derive(agents, signals(2));
    expect(result.checkState).toBe("waiting-for-human");
    expect(result.unconfirmed.map((entry) => entry.at)).toContain(LATER);
  });

  it("is the person's change again once undone, waiting for an agent's check", () => {
    const undoneAt = "2026-09-29T12:00:00.000Z";
    const undone = parseNote(restoreText(mine, "human:maya", undoneAt)).frontmatter?.data ?? {};
    // the undo's signed write confirms the person's new entry from version 3 on
    const result = derive(
      undone,
      signals(3, [{ noteId: "note_1", version: 3, by: "human:maya", at: undoneAt }]),
    );
    expect(result.change).toMatchObject({ by: "human:maya" });
    expect(result.checkState).toBe("agent-check-pending");
  });
});
