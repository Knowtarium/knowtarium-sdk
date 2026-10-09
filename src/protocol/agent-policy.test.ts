import { beforeAll, describe, expect, it } from "vitest";

import {
  AGENT_POLICY_FOLDERS_MAX,
  AgentKeyRecord,
  AgentPolicy,
  type AgentPolicyFolderInfo,
  AgentPolicyQuery,
  agentPolicyAncestry,
  agentPolicyFolderHash,
  agentPolicySha256,
  agentPolicyViewFor,
  ChangeEntry,
  effectiveMode,
  formatId,
  ListKeysResponse,
  MISSING_AGENT_POLICY_SHA256,
  missingAgentPolicy,
  pathFor,
  resolveAgentPolicyView,
  routes,
  SetAgentPolicyRequest,
  type SignedAgentPolicy,
} from "./index.js";
import { b64, id, now, sha256Hex, signing } from "./test-fixtures.js";

const workspaceId = id("ws");
const root = id("fld", 1);
const projects = id("fld", 2);
const secret = id("fld", 3);
const drafts = id("fld", 4);
const other = id("fld", 5);
const otherChild = id("fld", 6);
const gone = id("fld", 7);

/** root/projects/secret/drafts, and a second top-level folder `other` with `otherChild`. */
const tree = new Map<string, AgentPolicyFolderInfo>([
  [root, { parentId: null, deleted: false }],
  [projects, { parentId: root, deleted: false }],
  [secret, { parentId: projects, deleted: false }],
  [drafts, { parentId: secret, deleted: false }],
  [other, { parentId: null, deleted: false }],
  [otherChild, { parentId: other, deleted: false }],
  [gone, { parentId: root, deleted: true }],
]);
const lookupIn = (folders: ReadonlyMap<string, AgentPolicyFolderInfo>) => (folderId: string) =>
  folders.get(folderId);
const ancestry = (folderId: string, folders = tree) =>
  agentPolicyAncestry(folderId, lookupIn(folders));

/** What an agent scoped to `secret` knows of the tree. */
const scopedTree = new Map(
  [...tree].filter(([folderId]) => ([secret, drafts] as string[]).includes(folderId)),
);

const GOOD = b64(64);
const verifySignature = (signed: SignedAgentPolicy) => signed.signature === GOOD;

/** A stored policy at `revision`, "signed" (the test's signature check accepts GOOD). */
async function signedPolicy(
  rules: Pick<AgentPolicy, "default" | "folders"> & { otherFolderHashes?: string[] },
  revision = 2,
): Promise<AgentPolicy> {
  const policySha256 = await agentPolicySha256(rules);
  return {
    default: rules.default,
    folders: rules.folders,
    revision,
    updatedAt: now,
    updatedBy: id("acc"),
    signed: {
      envelope: {
        type: "agent_policy",
        accountId: id("acc"),
        workspaceId,
        createdAt: now,
        revision,
        policySha256,
      },
      signature: GOOD,
    },
  };
}

describe("effectiveMode", () => {
  it("reads a missing policy as direct", () => {
    expect(effectiveMode(null, ancestry(drafts))).toBe("direct");
    expect(effectiveMode(undefined, ancestry(root))).toBe("direct");
    expect(missingAgentPolicy()).toEqual({
      default: "direct",
      folders: [],
      revision: 0,
      updatedAt: null,
      updatedBy: null,
      signed: null,
    });
    expect(AgentPolicy.safeParse(missingAgentPolicy()).success).toBe(true);
    expect(effectiveMode(missingAgentPolicy(), ancestry(drafts))).toBe("direct");
  });

  it("falls back to the workspace default", () => {
    expect(effectiveMode({ default: "review", folders: [] }, ancestry(drafts))).toBe("review");
    expect(effectiveMode({ default: "direct", folders: [] }, ancestry(drafts))).toBe("direct");
  });

  it("lets the nearest ancestor with an override win", () => {
    const policy = {
      default: "direct",
      folders: [
        { folderId: projects, mode: "review" },
        { folderId: drafts, mode: "direct" },
      ],
    } as const;
    expect(effectiveMode(policy, ancestry(root))).toBe("direct");
    expect(effectiveMode(policy, ancestry(projects))).toBe("review");
    // inherited from projects
    expect(effectiveMode(policy, ancestry(secret))).toBe("review");
    // its own override is nearer than projects'
    expect(effectiveMode(policy, ancestry(drafts))).toBe("direct");
  });

  it("covers only what is stored under the root folder, never the other top-level folders", () => {
    const policy = { default: "direct", folders: [{ folderId: root, mode: "review" }] } as const;
    expect(effectiveMode(policy, ancestry(root))).toBe("review");
    expect(effectiveMode(policy, ancestry(drafts))).toBe("review");
    expect(effectiveMode(policy, ancestry(other))).toBe("direct");
    expect(effectiveMode(policy, ancestry(otherChild))).toBe("direct");
  });

  it("fails closed on a deleted folder in a live note's ancestry", () => {
    const policy = { default: "direct", folders: [] } as const;
    const deleted = new Map(tree).set(secret, { parentId: projects, deleted: true });
    expect(effectiveMode(policy, ancestry(drafts, deleted))).toBe("review");
    expect(effectiveMode(null, ancestry(drafts, deleted))).toBe("review");
  });

  it("never applies an override left on a deleted folder outside the ancestry", () => {
    const policy = { default: "direct", folders: [{ folderId: gone, mode: "review" }] } as const;
    expect(effectiveMode(policy, ancestry(drafts))).toBe("direct");
  });

  it("fails closed on an unknown folder, an empty ancestry and a cut-off chain", () => {
    const policy = { default: "direct", folders: [] } as const;
    expect(effectiveMode(policy, ancestry(id("fld", 9)))).toBe("review");
    expect(effectiveMode(policy, [])).toBe("review");
    // an agent's view of `drafts` stops at `secret`, whose parent it can't see
    expect(ancestry(drafts, scopedTree).at(-1)).toEqual({ folderId: projects, unknown: true });
    expect(effectiveMode(policy, ancestry(drafts, scopedTree))).toBe("review");
    // the chain must start at the folder the ancestry was cut at
    const wrong = { ...policy, ancestors: [{ folderId: secret, ancestorIds: [root] }] };
    expect(effectiveMode(wrong, ancestry(drafts, scopedTree))).toBe("review");
  });

  it("continues a cut-off chain through the ancestors of the scope folder", () => {
    const rules = {
      default: "direct",
      folders: [{ folderId: root, mode: "review" }],
      ancestors: [{ folderId: secret, ancestorIds: [projects, root] }],
    } as const;
    expect(effectiveMode(rules, ancestry(drafts, scopedTree))).toBe("review");
    expect(effectiveMode({ ...rules, folders: [] }, ancestry(drafts, scopedTree))).toBe("direct");
  });

  it("reads raw hashes as review: resolve an agent's view first", () => {
    const view = { default: "direct", folders: [], otherFolderHashes: [sha256Hex] } as const;
    expect(effectiveMode(view, ancestry(drafts))).toBe("review");
  });
});

describe("agentPolicyAncestry", () => {
  it("lists the folder, then its parents up to the top level", () => {
    expect(ancestry(drafts)).toEqual([
      { folderId: drafts, deleted: false },
      { folderId: secret, deleted: false },
      { folderId: projects, deleted: false },
      { folderId: root, deleted: false },
    ]);
  });

  it("ends with an unknown entry at a folder it doesn't know and at a cycle", () => {
    expect(ancestry(id("fld", 9))).toEqual([{ folderId: id("fld", 9), unknown: true }]);
    const cycle = new Map<string, AgentPolicyFolderInfo>([
      [projects, { parentId: secret, deleted: false }],
      [secret, { parentId: projects, deleted: false }],
    ]);
    expect(ancestry(secret, cycle)).toEqual([
      { folderId: secret, deleted: false },
      { folderId: projects, deleted: false },
      { folderId: secret, unknown: true },
    ]);
    expect(effectiveMode({ default: "direct", folders: [] }, ancestry(secret, cycle))).toBe(
      "review",
    );
  });
});

describe("an agent's view", () => {
  const rules = {
    default: "direct",
    folders: [
      { folderId: projects, mode: "review" },
      { folderId: drafts, mode: "direct" },
      { folderId: other, mode: "review" },
    ],
  } as const;
  let policy: AgentPolicy;
  let view: AgentPolicy;
  const options = {
    workspaceId,
    ownerAccountId: id("acc"),
    visibleFolderIds: [secret, drafts],
    verifySignature,
  };
  beforeAll(async () => {
    policy = await signedPolicy({ default: rules.default, folders: [...rules.folders] });
    view = await agentPolicyViewFor(policy, [secret], lookupIn(tree));
  });

  it("shows the overrides in scope, hashes the rest and lists the folders above the scope", async () => {
    expect(view.folders).toEqual([{ folderId: drafts, mode: "direct" }]);
    expect([...(view.otherFolderHashes ?? [])].sort()).toEqual(
      [
        await agentPolicyFolderHash({ folderId: projects, mode: "review" }),
        await agentPolicyFolderHash({ folderId: other, mode: "review" }),
      ].sort(),
    );
    expect(view.ancestors).toEqual([{ folderId: secret, ancestorIds: [projects, root] }]);
    expect(view.signed).toEqual(policy.signed);
    expect(AgentPolicy.safeParse(view).success).toBe(true);
  });

  it("resolves to rules that derive what the scope inherits from the hashes", async () => {
    const resolved = await resolveAgentPolicyView(view, options);
    if (!resolved.ok) throw new Error(resolved.problem);
    expect(resolved.revision).toBe(2);
    expect(resolved.policySha256).toBe(policy.signed?.envelope.policySha256);
    expect(effectiveMode(resolved.rules, ancestry(secret, scopedTree))).toBe("review");
    expect(effectiveMode(resolved.rules, ancestry(drafts, scopedTree))).toBe("direct");
  });

  it("gives a whole-workspace token every override", async () => {
    const whole = await agentPolicyViewFor(policy, [], lookupIn(tree));
    expect(whole.folders).toEqual(policy.folders);
    expect(whole.otherFolderHashes).toEqual([]);
    const resolved = await resolveAgentPolicyView(whole, {
      ...options,
      visibleFolderIds: [...tree.keys()],
    });
    if (!resolved.ok) throw new Error(resolved.problem);
    expect(effectiveMode(resolved.rules, ancestry(otherChild))).toBe("review");
    expect(effectiveMode(resolved.rules, ancestry(drafts))).toBe("direct");
  });

  it("refuses a visible folder's override hidden among the hashes", async () => {
    // the same set of hashes, so the owner's signature still covers it
    const hidden = {
      ...view,
      folders: [],
      otherFolderHashes: [
        ...(view.otherFolderHashes ?? []),
        await agentPolicyFolderHash({ folderId: drafts, mode: "direct" }),
      ],
    };
    expect(await resolveAgentPolicyView(hidden, options)).toEqual({
      ok: false,
      problem: "hidden_override",
    });
  });

  it("refuses a changed, added or dropped override", async () => {
    const changed = { ...view, folders: [{ folderId: drafts, mode: "review" as const }] };
    const dropped = { ...view, otherFolderHashes: view.otherFolderHashes?.slice(1) };
    const flipped = { ...view, default: "review" as const };
    for (const tampered of [changed, dropped, flipped]) {
      expect(await resolveAgentPolicyView(tampered, options)).toEqual({
        ok: false,
        problem: "hash_mismatch",
      });
    }
  });

  it("refuses a bad signature and another workspace's policy", async () => {
    const forged = {
      ...view,
      signed: view.signed && { ...view.signed, signature: `B${GOOD.slice(1)}` },
    };
    expect(await resolveAgentPolicyView(forged, options)).toMatchObject({
      problem: "bad_signature",
    });
    expect(
      await resolveAgentPolicyView(view, { ...options, workspaceId: id("ws", 2) }),
    ).toMatchObject({ problem: "wrong_workspace" });
    expect(
      await resolveAgentPolicyView(view, { ...options, ownerAccountId: id("acc", 2) }),
    ).toMatchObject({ problem: "wrong_account" });
  });

  it("throws on a floor that isn't a safe integer of 0 or more", async () => {
    for (const minRevision of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(resolveAgentPolicyView(view, { ...options, minRevision })).rejects.toThrow(
        TypeError,
      );
    }
  });

  it("refuses ancestors for a folder outside the token's scope, when the scope is known", async () => {
    expect(
      await resolveAgentPolicyView(view, { ...options, scopeFolderIds: [secret] }),
    ).toMatchObject({ ok: true });
    expect(await resolveAgentPolicyView(view, { ...options, scopeFolderIds: [drafts] })).toEqual({
      ok: false,
      problem: "unexpected_ancestors",
    });
    expect(await resolveAgentPolicyView(view, { ...options, scopeFolderIds: [] })).toMatchObject({
      problem: "unexpected_ancestors",
    });
  });

  it("refuses a rollback below the floor, an unsigned revision 0 included", async () => {
    expect(await resolveAgentPolicyView(view, { ...options, minRevision: 3 })).toMatchObject({
      problem: "below_floor",
    });
    const missing = await agentPolicyViewFor(missingAgentPolicy(), [secret], lookupIn(tree));
    expect(await resolveAgentPolicyView(missing, { ...options, minRevision: 1 })).toMatchObject({
      problem: "below_floor",
    });
    const resolved = await resolveAgentPolicyView(missing, options);
    expect(resolved).toMatchObject({ ok: true, revision: 0 });
    if (resolved.ok) {
      expect(resolved.policySha256).toBe(MISSING_AGENT_POLICY_SHA256);
      expect(effectiveMode(resolved.rules, ancestry(drafts, scopedTree))).toBe("direct");
    }
  });

  it("refuses an unsigned policy that isn't the empty one", async () => {
    const unsigned = { ...missingAgentPolicy(), folders: [{ folderId: drafts, mode: "review" }] };
    expect(await resolveAgentPolicyView(unsigned as AgentPolicy, options)).toMatchObject({
      problem: "unsigned",
    });
  });

  it("refuses an ancestor with both modes", async () => {
    const both = [
      await agentPolicyFolderHash({ folderId: projects, mode: "review" }),
      await agentPolicyFolderHash({ folderId: projects, mode: "direct" }),
    ];
    const forged = await signedPolicy({ default: "direct", folders: [], otherFolderHashes: both });
    const conflicting = {
      ...forged,
      otherFolderHashes: both,
      ancestors: [{ folderId: secret, ancestorIds: [projects, root] }],
    };
    expect(await resolveAgentPolicyView(conflicting, options)).toMatchObject({
      problem: "conflicting_override",
    });
  });

  it("refuses a malformed view", async () => {
    const twice = { ...view, otherFolderHashes: [sha256Hex, sha256Hex] };
    expect(await resolveAgentPolicyView(twice, options)).toMatchObject({ problem: "malformed" });
    // an override both shown and hashed
    const both = {
      ...view,
      otherFolderHashes: [
        ...(view.otherFolderHashes ?? []),
        await agentPolicyFolderHash({ folderId: drafts, mode: "direct" }),
      ],
    };
    expect(await resolveAgentPolicyView(both, options)).toMatchObject({ problem: "malformed" });
  });
});

describe("agent policy schemas", () => {
  const policy = {
    default: "review",
    folders: [{ folderId: projects, mode: "direct" }],
    revision: 2,
    updatedAt: now,
    updatedBy: id("acc"),
    signed: {
      envelope: {
        type: "agent_policy",
        accountId: id("acc"),
        workspaceId,
        createdAt: now,
        revision: 2,
        policySha256: sha256Hex,
      },
      signature: GOOD,
    },
  };

  it("accepts a signed policy and an agent's view of one", () => {
    expect(AgentPolicy.safeParse(policy).success).toBe(true);
    const view = {
      ...policy,
      otherFolderHashes: [sha256Hex],
      ancestors: [{ folderId: secret, ancestorIds: [projects, root] }],
    };
    expect(AgentPolicy.safeParse(view).success).toBe(true);
  });

  it("ties revision 0 to no signature, and the signature to the revision", () => {
    const unsignedLater = { ...policy, signed: null, updatedAt: null, updatedBy: null };
    expect(AgentPolicy.safeParse(unsignedLater).success).toBe(false);
    expect(AgentPolicy.safeParse({ ...missingAgentPolicy(), signed: policy.signed }).success).toBe(
      false,
    );
    expect(AgentPolicy.safeParse({ ...missingAgentPolicy(), updatedAt: now }).success).toBe(false);
    expect(AgentPolicy.safeParse({ ...policy, revision: 3 }).success).toBe(false);
  });

  it("refuses unknown modes, repeats and too many overrides", () => {
    expect(AgentPolicy.safeParse({ ...policy, default: "sometimes" }).success).toBe(false);
    const twice = [...policy.folders, { folderId: projects, mode: "review" }];
    expect(AgentPolicy.safeParse({ ...policy, folders: twice }).success).toBe(false);
    const many = Array.from({ length: AGENT_POLICY_FOLDERS_MAX + 1 }, (_, index) => ({
      folderId: formatId(
        "fld",
        Uint8Array.of(index >> 8, index & 0xff, ...Array<number>(14).fill(7)),
      ),
      mode: "review",
    }));
    expect(AgentPolicy.safeParse({ ...policy, folders: many.slice(1) }).success).toBe(true);
    expect(AgentPolicy.safeParse({ ...policy, folders: many }).success).toBe(false);
    const full = {
      ...policy,
      otherFolderHashes: many.map((_, index) => index.toString(16).padStart(64, "0")),
    };
    expect(AgentPolicy.safeParse(full).success).toBe(false);
    expect(
      AgentPolicy.safeParse({ ...policy, otherFolderHashes: [sha256Hex, sha256Hex] }).success,
    ).toBe(false);
    const ancestorsTwice = [
      { folderId: secret, ancestorIds: [projects] },
      { folderId: secret, ancestorIds: [root] },
    ];
    expect(AgentPolicy.safeParse({ ...policy, ancestors: ancestorsTwice }).success).toBe(false);
    const ownAncestor = [{ folderId: secret, ancestorIds: [projects, secret] }];
    expect(AgentPolicy.safeParse({ ...policy, ancestors: ownAncestor }).success).toBe(false);
    const repeated = [{ folderId: secret, ancestorIds: [projects, projects] }];
    expect(AgentPolicy.safeParse({ ...policy, ancestors: repeated }).success).toBe(false);
    const wrongType = {
      ...policy,
      signed: { ...policy.signed, envelope: { ...policy.signed.envelope, type: "edited" } },
    };
    expect(AgentPolicy.safeParse(wrongType).success).toBe(false);
  });

  it("sets a policy with its base revision and the owner's signature", () => {
    const body = { default: "direct", folders: policy.folders, baseRevision: 0, ...signing };
    expect(SetAgentPolicyRequest.safeParse(body).success).toBe(true);
    expect(SetAgentPolicyRequest.safeParse({ ...body, signature: undefined }).success).toBe(false);
    expect(SetAgentPolicyRequest.safeParse({ ...body, baseRevision: undefined }).success).toBe(
      false,
    );
    expect(SetAgentPolicyRequest.safeParse({ ...body, revision: 1 }).success).toBe(false);
  });

  it("serves both routes at the workspace's agent-policy path, old revisions included", () => {
    expect(pathFor(routes.getAgentPolicy, { workspaceId })).toBe(
      `/workspaces/${workspaceId}/agent-policy`,
    );
    expect(routes.getAgentPolicy).toMatchObject({ method: "GET", auth: "any" });
    expect(routes.getAgentPolicy.query).toBe(AgentPolicyQuery);
    expect(AgentPolicyQuery.parse({})).toEqual({});
    expect(AgentPolicyQuery.parse({ revision: "3" })).toEqual({ revision: 3 });
    expect(AgentPolicyQuery.safeParse({ revision: "-1" }).success).toBe(false);
    expect(routes.setAgentPolicy).toMatchObject({ method: "PUT", auth: "session" });
    expect(routes.setAgentPolicy.path).toBe(routes.getAgentPolicy.path);
  });

  it("hashes the same rules the same way, and different rules differently", async () => {
    const rules = { default: "direct", folders: [{ folderId: projects, mode: "review" }] } as const;
    const hash = await agentPolicySha256(rules);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await agentPolicySha256({ ...rules })).toBe(hash);
    expect(await agentPolicySha256({ ...rules, default: "review" })).not.toBe(hash);
    expect(
      await agentPolicySha256({ ...rules, folders: [{ folderId: projects, mode: "direct" }] }),
    ).not.toBe(hash);
    expect(await agentPolicySha256({ ...rules, folders: [] })).not.toBe(hash);
    expect(await agentPolicySha256(missingAgentPolicy())).toBe(MISSING_AGENT_POLICY_SHA256);
  });
});

describe("protocol 2 additions to older shapes", () => {
  it("tells the changes feed about a new policy revision, optionally", () => {
    const entry = { kind: "workspace", seq: 4, at: now, encName: b64(80), keyGeneration: 1 };
    expect(ChangeEntry.safeParse(entry).success).toBe(true);
    expect(ChangeEntry.safeParse({ ...entry, agentPolicyRevision: 3 }).success).toBe(true);
    expect(ChangeEntry.safeParse({ ...entry, agentPolicyRevision: -1 }).success).toBe(false);
  });

  it("lists the vouched agent keys in listKeys, optionally", () => {
    const record = {
      signed: {
        envelope: {
          type: "agent_key",
          accountId: id("acc"),
          workspaceId,
          createdAt: now,
          tokenId: id("tok"),
          signPublicKey: b64(32),
          policyRevision: 0,
        },
        signature: b64(64),
      },
      revokedAt: null,
    };
    expect(AgentKeyRecord.safeParse(record).success).toBe(true);
    expect(ListKeysResponse.safeParse({ workspaceKeys: [] }).success).toBe(true);
    expect(ListKeysResponse.safeParse({ workspaceKeys: [], agentKeys: [record] }).success).toBe(
      true,
    );
    const unsigned = { ...record, signed: null };
    expect(ListKeysResponse.safeParse({ workspaceKeys: [], agentKeys: [unsigned] }).success).toBe(
      false,
    );
    const noFloor = {
      ...record,
      signed: {
        ...record.signed,
        envelope: { ...record.signed.envelope, policyRevision: undefined },
      },
    };
    expect(AgentKeyRecord.safeParse(noFloor).success).toBe(false);
  });
});
