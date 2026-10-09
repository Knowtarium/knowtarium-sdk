import { beforeAll, describe, expect, it } from "vitest";

import {
  accountPublicKeys,
  derivePasswordSecrets,
  fromBase64Url,
  ready,
  toBase64Url,
  unwrapAccountKeys,
} from "../../crypto/index.js";
import { AccountResetCompleteRequest, routes } from "../../protocol/index.js";
import { isVaultError } from "../errors/index.js";
import { newId } from "../platform/ids.js";
import {
  cancelPlanChange,
  changePlan,
  createPortalSession,
  startCheckout,
  MemoryTrustStorage,
  prepareStartOver,
  requestStartOver,
  startOver,
  toPasswordKdfParams,
  TrustState,
} from "./index.js";

beforeAll(ready);

const TOKEN = `kts_${"t".repeat(43)}`;
const PASSWORD = "a brand new password";

/** A client whose answers are given per route, remembering what was sent. */
function stubApi(answers: Record<string, unknown>) {
  const sent: { route: string; body: unknown }[] = [];
  const api = {
    call: (route: { name?: string; path: string }, input: { body?: unknown } = {}) => {
      const name = Object.entries(routes).find(([, value]) => value === route)?.[0] ?? route.path;
      sent.push({ route: name, body: input.body });
      return Promise.resolve({ data: answers[name] });
    },
  };
  return { api: api as never, sent };
}

describe("starting over", () => {
  it("prepares a whole new account, like a sign-up, that the new password unlocks", () => {
    const prepared = prepareStartOver(TOKEN, PASSWORD);
    const request = AccountResetCompleteRequest.parse(prepared.request);
    expect(request.resetToken).toBe(TOKEN);
    const secrets = derivePasswordSecrets(PASSWORD, toPasswordKdfParams(request.kdf));
    expect(request.loginHash).toBe(toBase64Url(secrets.authHash));
    const publicKeys = {
      encryptionPublicKey: fromBase64Url(request.publicKeys.box),
      signingPublicKey: fromBase64Url(request.publicKeys.sign),
    };
    const unwrapped = unwrapAccountKeys(
      fromBase64Url(request.wrappedByMaster.encSecretKeys),
      secrets.keyEncryptionKey,
      "password",
      publicKeys,
    );
    expect(accountPublicKeys(unwrapped)).toEqual(publicKeys);
    expect(prepared.recoveryCode.length).toBeGreaterThan(20);
  });

  it("completes with the token, signs in and re-pins the keys on this device", async () => {
    const accountId = newId("acc");
    const { api, sent } = stubApi({
      requestAccountReset: { ok: true },
      completeAccountReset: { account: { id: accountId } },
      createPortalSession: { url: "https://billing.example.com/session/1" },
      startCheckout: { url: "https://billing.example.com/checkout/1" },
      changePlan: { effect: "scheduled", appliesAt: "2026-11-07T00:00:00.000Z" },
      cancelPlanChange: { ok: true },
    });
    await requestStartOver(api, "maya@example.com");
    expect(sent[0]).toEqual({ route: "requestAccountReset", body: { email: "maya@example.com" } });

    const trust = new TrustState(new MemoryTrustStorage());
    const old = {
      box: toBase64Url(new Uint8Array(32).fill(1)),
      sign: toBase64Url(new Uint8Array(32).fill(2)),
    };
    await trust.pinAccountKeys(accountId, old);
    const result = await startOver(api, {
      resetToken: TOKEN,
      password: PASSWORD,
      accountId,
      trust,
    });
    expect(result.account.id).toBe(accountId);
    const body = sent[1]?.body as AccountResetCompleteRequest;
    expect(sent[1]?.route).toBe("completeAccountReset");
    // the new keys are pinned: they open, the old ones are now the mismatch
    expect(await trust.pinnedAccountKeys(accountId)).toEqual(body.publicKeys);
    const refused = await trust.pinAccountKeys(accountId, old).catch((error: unknown) => error);
    expect(isVaultError(refused, "pin_mismatch")).toBe(true);

    expect(await createPortalSession(api)).toBe("https://billing.example.com/session/1");
    expect(await startCheckout(api, { planId: "pro", interval: "year" })).toBe(
      "https://billing.example.com/checkout/1",
    );
    expect(sent.at(-1)).toEqual({
      route: "startCheckout",
      body: { planId: "pro", interval: "year" },
    });
    expect(await changePlan(api, { planId: "starter", interval: "month" })).toEqual({
      effect: "scheduled",
      appliesAt: "2026-11-07T00:00:00.000Z",
    });
    expect(sent.at(-1)).toEqual({
      route: "changePlan",
      body: { planId: "starter", interval: "month" },
    });
    await cancelPlanChange(api);
    expect(sent.at(-1)).toEqual({ route: "cancelPlanChange", body: undefined });
  });

  it("refuses an answer for another account, and re-pins elsewhere only with the password", async () => {
    const accountId = newId("acc");
    const { api } = stubApi({ completeAccountReset: { account: { id: newId("acc") } } });
    const wrong = await startOver(api, { resetToken: TOKEN, password: PASSWORD, accountId }).catch(
      (error: unknown) => error,
    );
    expect(isVaultError(wrong, "pin_mismatch")).toBe(true);

    // another device: the new key material from getAccount, and the person's new password
    const { request } = prepareStartOver(TOKEN, PASSWORD);
    const trust = new TrustState(new MemoryTrustStorage());
    const refused = await trust
      .acceptAccountReset(accountId, { password: "not the password", material: request })
      .catch((error: unknown) => error);
    expect(isVaultError(refused, "untrusted_signature")).toBe(true);
    expect(await trust.pinnedAccountKeys(accountId)).toBeUndefined();
    // material whose public keys aren't the wrapped keys' is refused too
    const other = prepareStartOver(TOKEN, PASSWORD).request;
    const swapped = await trust
      .acceptAccountReset(accountId, {
        password: PASSWORD,
        material: { ...request, publicKeys: other.publicKeys },
      })
      .catch((error: unknown) => error);
    expect(isVaultError(swapped, "untrusted_signature")).toBe(true);
    await trust.acceptAccountReset(accountId, { password: PASSWORD, material: request });
    expect(await trust.pinnedAccountKeys(accountId)).toEqual(request.publicKeys);
  });
});
