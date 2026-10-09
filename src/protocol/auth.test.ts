import { describe, expect, it } from "vitest";

import {
  BETTER_AUTH_DISABLED_PATHS,
  ChangePasswordRequest,
  encodeKeyMaterial,
  KdfParams,
  parseKeyMaterial,
  pathFor,
  PreloginResponse,
  RecoveryCompleteRequest,
  RecoveryStartRequest,
  ROUTE_LIST,
  routes,
  SignUpKeyMaterial,
} from "./index.js";
import { b64, id, kdf, keyMaterial, wrappedSecretKeys } from "./test-fixtures.js";

describe("sign-up key material (a Better Auth additional field)", () => {
  it("accepts public keys, both wrappings, KDF parameters and the recovery auth hash", () => {
    expect(SignUpKeyMaterial.safeParse(keyMaterial).success).toBe(true);
  });

  it.each(["kdf", "publicKeys", "wrappedByMaster", "wrappedByRecovery", "recoveryAuthHash"])(
    "requires %s",
    (field) => {
      expect(SignUpKeyMaterial.safeParse({ ...keyMaterial, [field]: undefined }).success).toBe(
        false,
      );
    },
  );

  it("refuses a password, a master key or any other unknown field", () => {
    expect(SignUpKeyMaterial.safeParse({ ...keyMaterial, password: "hunter2" }).success).toBe(
      false,
    );
    expect(SignUpKeyMaterial.safeParse({ ...keyMaterial, masterKey: b64(32) }).success).toBe(false);
  });

  it("round-trips as the JSON string field", () => {
    const text = encodeKeyMaterial(keyMaterial);
    expect(typeof text).toBe("string");
    expect(parseKeyMaterial(text)).toEqual(keyMaterial);
    expect(parseKeyMaterial("{")).toBeNull();
    expect(parseKeyMaterial(keyMaterial)).toBeNull();
    expect(parseKeyMaterial(JSON.stringify({ ...keyMaterial, kdf: undefined }))).toBeNull();
  });
});

describe("kdf params", () => {
  it("accepts Argon2id parameters", () => {
    expect(KdfParams.safeParse(kdf).success).toBe(true);
    expect(PreloginResponse.safeParse({ kdf }).success).toBe(true);
  });

  it.each([
    { ...kdf, algorithm: "scrypt" },
    { ...kdf, salt: b64(8) },
    { ...kdf, opsLimit: 0 },
    { ...kdf, memLimitBytes: 1024 },
  ])("refuses %j", (value) => {
    expect(KdfParams.safeParse(value).success).toBe(false);
  });
});

describe("password change and recovery", () => {
  it("swaps the login hash, KDF parameters and wrapped keys together", () => {
    const body = {
      currentLoginHash: b64(32),
      loginHash: b64(32),
      kdf,
      wrappedByMaster: wrappedSecretKeys,
    };
    expect(ChangePasswordRequest.safeParse(body).success).toBe(true);
    expect(ChangePasswordRequest.safeParse({ ...body, kdf: undefined }).success).toBe(false);
    expect(ChangePasswordRequest.safeParse({ ...body, password: "x" }).success).toBe(false);
  });

  it("starts a recovery with the recovery auth hash", () => {
    const body = { email: "a@b.co", recoveryAuthHash: b64(32) };
    expect(RecoveryStartRequest.safeParse(body).success).toBe(true);
    expect(RecoveryStartRequest.safeParse({ ...body, recoveryKey: b64(32) }).success).toBe(false);
  });

  it("completes a recovery with a grant, new wrappings and a new recovery auth hash", () => {
    const body = {
      recoveryGrant: `ktr_${b64(32)}`,
      loginHash: b64(32),
      kdf,
      wrappedByMaster: wrappedSecretKeys,
      wrappedByRecovery: wrappedSecretKeys,
      recoveryAuthHash: b64(32),
    };
    expect(RecoveryCompleteRequest.safeParse(body).success).toBe(true);
    expect(RecoveryCompleteRequest.safeParse({ ...body, recoveryGrant: "ktr_short" }).success).toBe(
      false,
    );
    expect(
      RecoveryCompleteRequest.safeParse({ ...body, recoveryAuthHash: undefined }).success,
    ).toBe(false);
  });
});

describe("Better Auth boundary", () => {
  it("leaves sign-up, sign-in, sessions and email flows to Better Auth", () => {
    const paths = Object.values(routes).map((route) => route.path);
    for (const path of paths) expect(path.startsWith("/auth")).toBe(false);
    expect(paths.some((path) => /sign-(up|in|out)|verify|reset-password/.test(path))).toBe(false);
    // the only reset is starting over with new keys, never Better Auth's password reset
    expect(paths.filter((path) => path.includes("reset"))).toEqual([
      "/account-resets",
      "/account-reset-completions",
    ]);
    // the one account session route: revoke by id, since Better Auth's revoke takes a token
    const sessionRoutes = ROUTE_LIST.filter((route) => route.path.startsWith("/account/sessions"));
    expect(sessionRoutes.map((route) => route.name)).toEqual(["revokeSession"]);
  });

  it("revokes a session by its ses_ id, as the signed-in person", () => {
    const route = routes.revokeSession;
    expect(route).toMatchObject({ method: "DELETE", auth: "session", body: null });
    expect(pathFor(route, { sessionId: id("ses") })).toBe(`/account/sessions/${id("ses")}`);
    expect(route.params.safeParse({ sessionId: id("ses") }).success).toBe(true);
    expect(route.params.safeParse({ sessionId: id("tok") }).success).toBe(false);
    expect(route.params.safeParse({ sessionId: "some-session-token" }).success).toBe(false);
  });

  it("disables the Better Auth flows that would lose the keys", () => {
    expect(BETTER_AUTH_DISABLED_PATHS).toContain("/forget-password");
    expect(BETTER_AUTH_DISABLED_PATHS).toContain("/reset-password");
    expect(BETTER_AUTH_DISABLED_PATHS).toContain("/change-password");
    expect(BETTER_AUTH_DISABLED_PATHS).toContain("/revoke-session");
  });
});
