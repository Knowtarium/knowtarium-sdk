import { beforeAll, describe, expect, it } from "vitest";

import { createAccount } from "./account.js";
import { decryptText, encryptText } from "./envelope.js";
import { signEvent, verifyEvent } from "./sign.js";
import { ready } from "./sodium.js";
import { createWorkspaceKey } from "./workspace-keys.js";

// Runs only in the "dom" Vitest project (happy-dom), next to every other crypto test file, to show
// the package loads and works with browser globals rather than Node's.

beforeAll(ready);

describe("browser-like environment", () => {
  it("has a DOM", () => {
    expect("document" in globalThis && "window" in globalThis).toBe(true);
  });

  it("creates an account, encrypts and signs", () => {
    const account = createAccount("a password typed in a browser");
    const key = createWorkspaceKey();
    const context = { kind: "note", workspaceId: "ws_1", id: "n" } as const;
    expect(decryptText(key, encryptText(key, "hello", context), context)).toBe("hello");
    const signed = signEvent({ type: "edited", actor: "human:u" }, account.keys.signing);
    expect(verifyEvent(signed, account.publicKeys.signingPublicKey)).toBe(true);
  });
});
