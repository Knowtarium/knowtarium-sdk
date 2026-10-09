import { beforeAll, describe, expect, it } from "vitest";

import { fromHex } from "../../crypto/encoding.js";
import vectors from "../../crypto/envelope-vectors.json" with { type: "json" };
import { ready } from "../../crypto/index.js";
import {
  type AgentPolicy,
  type AgentPolicyEnvelope,
  type AgentPolicyFolder,
  effectiveMode,
  resolveAgentPolicyView,
} from "../../protocol/index.js";
import { agentPolicySignatureVerifier } from "./index.js";

beforeAll(ready);

// the agent_policy vector, signed for real by the vectors' owner key, over the policy whose hash
// agentPolicyHashes pins
const vector = vectors.signedEnvelopes.find((entry) => entry.fields.type === "agent_policy");
const envelope = vector?.fields as AgentPolicyEnvelope;
const rules = vectors.agentPolicyHashes.find(
  (entry) => entry.policySha256 === envelope.policySha256,
);
const ownerKey = fromHex(vector?.publicKey ?? "");

function policy(signedEnvelope = envelope): AgentPolicy {
  return {
    default: rules?.default as AgentPolicy["default"],
    folders: (rules?.folders ?? []).map(({ folderId, mode }) => ({
      folderId,
      mode,
    })) as AgentPolicyFolder[],
    revision: envelope.revision,
    updatedAt: envelope.createdAt,
    updatedBy: envelope.accountId,
    signed: { envelope: signedEnvelope, signature: vector?.signature ?? "" },
  };
}

const options = {
  workspaceId: envelope.workspaceId,
  ownerAccountId: envelope.accountId,
  visibleFolderIds: (rules?.folders ?? []).map((folder) => folder.folderId),
  verifySignature: agentPolicySignatureVerifier(ownerKey, envelope.accountId),
};

describe("agentPolicySignatureVerifier", () => {
  it("lets the owner's real signature through resolveAgentPolicyView", async () => {
    const resolved = await resolveAgentPolicyView(policy(), options);
    expect(resolved).toMatchObject({ ok: true, revision: 3, policySha256: envelope.policySha256 });
    if (!resolved.ok) return;
    for (const folder of rules?.folders ?? []) {
      expect(effectiveMode(resolved.rules, [{ folderId: folder.folderId, deleted: false }])).toBe(
        folder.mode,
      );
    }
  });

  it("refuses a tampered accountId", async () => {
    const other = "acc_0000000000000000000000000g";
    const tampered = policy({ ...envelope, accountId: other });
    // named as someone else than the owner
    expect(await resolveAgentPolicyView(tampered, options)).toMatchObject({
      problem: "wrong_account",
    });
    // or passed off as that account's: the signature no longer verifies
    const verifier = agentPolicySignatureVerifier(ownerKey, other);
    expect(
      await resolveAgentPolicyView(tampered, {
        ...options,
        ownerAccountId: other,
        verifySignature: verifier,
      }),
    ).toMatchObject({ problem: "bad_signature" });
    expect(verifier(policy().signed ?? ({} as never))).toBe(false);
  });

  it("refuses another key", async () => {
    const verifySignature = agentPolicySignatureVerifier(
      new Uint8Array(32).fill(9),
      envelope.accountId,
    );
    expect(await resolveAgentPolicyView(policy(), { ...options, verifySignature })).toMatchObject({
      problem: "bad_signature",
    });
  });
});
