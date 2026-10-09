import { beforeAll, describe, expect, it } from "vitest";

import { type BlobContext } from "./blob-context.js";
import {
  decryptBytes,
  decryptJson,
  decryptText,
  encryptBytes,
  encryptJson,
  encryptText,
  ENVELOPE_MIN_BYTES,
  readEnvelopeHeader,
} from "./envelope.js";
import { toBase64Url, toHex, utf8Encode } from "./encoding.js";
import { type CryptoErrorCode, isCryptoError } from "./errors.js";
import { ready } from "./sodium.js";
import { createKeyring, createWorkspaceKey, rotateWorkspaceKey } from "./workspace-keys.js";

beforeAll(ready);

const note = (id: string, workspaceId = "ws_1"): BlobContext => ({ kind: "note", workspaceId, id });

function errorOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

function expectCode(run: () => unknown, code: CryptoErrorCode): void {
  const error = errorOf(run);
  expect(isCryptoError(error, code), String(error)).toBe(true);
}

describe("envelope round trips", () => {
  it("round-trips bytes, text and JSON", () => {
    const key = createWorkspaceKey();
    const data = Uint8Array.from({ length: 1000 }, (_, i) => i & 0xff);
    expect(decryptBytes(key, encryptBytes(key, data, note("n")), note("n"))).toEqual(data);
    const title: BlobContext = { kind: "title", workspaceId: "ws_1", id: "n" };
    expect(decryptText(key, encryptText(key, "héllo ☃\n---", title), title)).toBe("héllo ☃\n---");
    const value = { title: "Q3", tags: ["a", "b"], nested: { n: 1, ok: true, none: null } };
    expect(decryptJson(key, encryptJson(key, value, note("n")), note("n"))).toEqual(value);
    expect(decryptText(key, encryptText(key, "", note("n")), note("n"))).toBe("");
  });

  it("writes the exact layout: version, generation, nonce, ciphertext with tag", () => {
    const key = { generation: 0x01020304, key: createWorkspaceKey().key };
    const blob = encryptBytes(key, utf8Encode("abc"), note("n"));
    expect(blob.length).toBe(ENVELOPE_MIN_BYTES + 3);
    expect([...blob.subarray(0, 5)]).toEqual([1, 1, 2, 3, 4]);
    expect(readEnvelopeHeader(blob)).toEqual({ formatVersion: 1, keyGeneration: 0x01020304 });
  });

  it("uses a fresh nonce every time, so equal plaintexts look different", () => {
    const key = createWorkspaceKey();
    const a = encryptText(key, "same", note("n"));
    const b = encryptText(key, "same", note("n"));
    expect(toHex(a)).not.toBe(toHex(b));
    expect(toHex(a.subarray(5, 29))).not.toBe(toHex(b.subarray(5, 29)));
  });

  it("refuses values JSON can't represent", () => {
    expectCode(() => encryptJson(createWorkspaceKey(), undefined, note("n")), "invalid_input");
  });

  it("refuses decrypted text that isn't UTF-8 or JSON", () => {
    const key = createWorkspaceKey();
    const bad = encryptBytes(key, Uint8Array.of(0xff), note("n"));
    expectCode(() => decryptText(key, bad, note("n")), "invalid_input");
    expectCode(
      () => decryptJson(key, encryptText(key, "{nope", note("n")), note("n")),
      "invalid_input",
    );
  });

  it("requires a well-formed context", () => {
    const key = createWorkspaceKey();
    const malformed = [
      undefined,
      { kind: "note", workspaceId: "ws_1" },
      { kind: "note", workspaceId: "", id: "n" },
      { kind: "diary", workspaceId: "ws_1", id: "n" },
      { kind: "attachment_chunk", workspaceId: "ws_1", id: "a", chunkIndex: 2, chunkCount: 2 },
      { kind: "attachment_chunk", workspaceId: "ws_1", id: "a", chunkIndex: 0 },
    ] as unknown as BlobContext[];
    for (const context of malformed) {
      expectCode(() => encryptText(key, "x", context), "invalid_input");
    }
  });
});

describe("envelope tamper detection", () => {
  const key = { generation: 1, key: new Uint8Array(32).fill(7) };
  let blob: Uint8Array;
  beforeAll(() => {
    blob = encryptText(key, "the note body", note("note_1"));
  });

  it("fails on every single-bit change anywhere in the blob", () => {
    for (let index = 0; index < blob.length; index++) {
      for (const bit of [0x01, 0x80]) {
        const tampered = blob.slice();
        tampered[index] = (tampered[index] ?? 0) ^ bit;
        const error = errorOf(() => decryptBytes(key, tampered, note("note_1")));
        const expected: CryptoErrorCode =
          index === 0
            ? "unsupported_version"
            : index < 5
              ? "key_generation_mismatch"
              : "decryption_failed";
        expect(isCryptoError(error, expected), `byte ${String(index)}`).toBe(true);
      }
    }
  });

  it("authenticates the header: a relabelled generation fails even under the same key", () => {
    // an artificial keyring holding the same key bytes as generations 1 and 2
    const keyring = createKeyring([key, { generation: 2, key: key.key }]);
    const relabelled = blob.slice();
    relabelled[4] = 2;
    expect(decryptText(keyring, blob, note("note_1"))).toBe("the note body");
    expectCode(() => decryptBytes(keyring, relabelled, note("note_1")), "decryption_failed");
  });

  it("binds every part of the context", () => {
    const others: BlobContext[] = [
      note("note_2"),
      note("note_1", "ws_2"),
      { kind: "pending_change", workspaceId: "ws_1", id: "note_1" },
      { kind: "title", workspaceId: "ws_1", id: "note_1" },
      { kind: "search_index", workspaceId: "ws_1", id: "note_1" },
    ];
    for (const context of others) {
      expectCode(() => decryptBytes(key, blob, context), "decryption_failed");
    }
  });

  it("keeps a search index apart from the workspace name", () => {
    const index: BlobContext = { kind: "search_index", workspaceId: "ws_1", id: "ws_1" };
    const name: BlobContext = { kind: "workspace_name", workspaceId: "ws_1", id: "ws_1" };
    const sealed = encryptText(key, '{"index":{}}', index);
    expect(decryptText(key, sealed, index)).toBe('{"index":{}}');
    expectCode(() => decryptBytes(key, sealed, name), "decryption_failed");
  });

  it("encodes contexts without ambiguity (length prefixes)", () => {
    const a: BlobContext = { kind: "note", workspaceId: "ws_1", id: "ab" };
    const b: BlobContext = { kind: "note", workspaceId: "ws_1a", id: "b" };
    expectCode(() => decryptBytes(key, encryptText(key, "x", a), b), "decryption_failed");
  });

  it("fails on truncation, extension and short blobs", () => {
    const context = note("note_1");
    expectCode(
      () => decryptBytes(key, blob.subarray(0, blob.length - 1), context),
      "decryption_failed",
    );
    expectCode(
      () => decryptBytes(key, Uint8Array.from([...blob, 0]), context),
      "decryption_failed",
    );
    expectCode(
      () => decryptBytes(key, blob.subarray(0, ENVELOPE_MIN_BYTES - 1), context),
      "malformed_envelope",
    );
    expectCode(() => decryptBytes(key, new Uint8Array(), context), "malformed_envelope");
  });

  it("fails with the wrong key of the right generation", () => {
    const other = { generation: 1, key: new Uint8Array(32).fill(8) };
    expectCode(() => decryptBytes(other, blob, note("note_1")), "decryption_failed");
  });

  it("never puts key material, plaintext or context in error messages", () => {
    const secrets = [toHex(key.key), toBase64Url(key.key), "the note body", "note_1", "ws_1"];
    const tampered = blob.slice();
    tampered[40] = (tampered[40] ?? 0) ^ 1;
    const errors = [
      errorOf(() => decryptBytes(key, tampered, note("note_1"))),
      errorOf(() => decryptBytes({ generation: 9, key: key.key }, blob, note("note_1"))),
      errorOf(() => decryptBytes(key, blob, note("note_2"))),
    ];
    for (const error of errors) {
      const text = `${String(error)} ${JSON.stringify(error)}`;
      for (const secret of secrets) expect(text).not.toContain(secret);
    }
  });
});

describe("key generations", () => {
  it("rejects a blob of another generation when given a single key", () => {
    const first = createWorkspaceKey();
    const second = rotateWorkspaceKey(first);
    expect(second.generation).toBe(first.generation + 1);
    const old = encryptText(first, "old", note("n"));
    expectCode(() => decryptBytes(second, old, note("n")), "key_generation_mismatch");
  });

  it("reads old generations through a keyring after rotations and writes with the newest", () => {
    const first = createWorkspaceKey();
    const second = rotateWorkspaceKey(first);
    const third = rotateWorkspaceKey(second);
    const old = encryptText(first, "written before the rotation", note("n"));
    const keyring = createKeyring([third, first, second]);
    expect(keyring.current).toBe(third);
    expect(decryptText(keyring, old, note("n"))).toBe("written before the rotation");
    const fresh = encryptText(keyring.current, "new", note("n"));
    expect(readEnvelopeHeader(fresh).keyGeneration).toBe(3);
    expect(decryptText(keyring, fresh, note("n"))).toBe("new");
  });

  it("reports a generation the keyring lacks", () => {
    const first = createWorkspaceKey();
    const second = rotateWorkspaceKey(first);
    const old = encryptText(first, "x", note("n"));
    expectCode(
      () => decryptBytes(createKeyring([second]), old, note("n")),
      "unknown_key_generation",
    );
  });

  it("refuses an empty keyring, duplicate generations and bad keys", () => {
    const key = createWorkspaceKey();
    expectCode(() => createKeyring([]), "invalid_input");
    expectCode(() => createKeyring([key, { ...key }]), "invalid_input");
    expectCode(() => encryptText({ generation: 0, key: key.key }, "x", note("n")), "invalid_input");
    expectCode(
      () => encryptText({ generation: -1, key: key.key }, "x", note("n")),
      "invalid_input",
    );
    expectCode(
      () => encryptText({ generation: 1, key: new Uint8Array(16) }, "x", note("n")),
      "invalid_input",
    );
    expectCode(() => rotateWorkspaceKey({ generation: 0xffffffff, key: key.key }), "invalid_input");
  });

  it("refuses unknown format versions before trying to decrypt", () => {
    const key = createWorkspaceKey();
    const blob = encryptText(key, "x", note("n"));
    blob[0] = 2;
    expectCode(() => readEnvelopeHeader(blob), "unsupported_version");
  });
});
