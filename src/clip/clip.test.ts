import { beforeAll, describe, expect, it, vi } from "vitest";

import { fromHex, toHex, utf8Encode } from "../crypto/encoding.js";
import envelopeVectors from "../crypto/envelope-vectors.json" with { type: "json" };
import vectors from "../crypto/vectors.json" with { type: "json" };
import { signClip } from "./frame.js";
import * as clip from "./index.js";
import { sodium } from "./sodium.js";

// knowtarium/clip must run on the standard libsodium-wrappers build alone: if anything it imports
// reached the sumo build, loading this file would fail.
vi.mock("libsodium-wrappers-sumo", () => {
  throw new Error("knowtarium/clip loaded the sumo libsodium build");
});

const {
  CLIP_LIMITS,
  ClipError,
  createClipId,
  createConnectSecret,
  createExtensionKeys,
  extensionConfirmationCode,
  formatExtensionConnectFragment,
  normalizeCategory,
  normalizeClip,
  openExtensionPairing,
  ready,
  signAndSealClip,
  verifyExtensionKey,
  verifyInboxKey,
} = clip;

beforeAll(ready);

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof ClipError ? error.code : String(error);
  }
};

const base = {
  clipId: "clip_1248h248h248h248h248h248h2",
  workspaceId: "ws_2aang6pxm1hjbt5bdrrf7dks7f",
  extensionId: "ext_0h248h248h248h248h248h248h",
  url: "https://example.com/a",
  title: "A page",
  note: "",
  category: "",
  savedAt: "2026-10-10T09:41:07.512Z",
};

const [pairingVector] = vectors.extensionPairings;
const inboxVector = envelopeVectors.signedEnvelopes.find((v) => v.name === "inbox_key");
const extensionVector = envelopeVectors.signedEnvelopes.find((v) => v.name === "extension_key");
if (pairingVector === undefined || inboxVector === undefined || extensionVector === undefined) {
  throw new Error("missing vectors");
}
const extensionSignKey = extensionVector.fields.signPublicKey ?? "";
const owner = {
  ownerSigningPublicKey: fromHex(inboxVector.publicKey),
  accountId: pairingVector.expected.accountId,
  workspaceId: pairingVector.expected.workspaceId,
};
const signedInbox = {
  envelope: inboxVector.fields,
  signature: inboxVector.signature,
} as unknown as clip.SignedInboxKey;

describe("cleaning a clip", () => {
  it("keeps a clean payload as it is and adds the version", () => {
    expect(normalizeClip(base)).toEqual({ v: 1, ...base });
    expect(normalizeClip({ v: 1, ...base })).toEqual({ v: 1, ...base });
  });

  it("drops bidi controls and invisible format characters, keeping U+200D", () => {
    const cleaned = normalizeClip({
      ...base,
      title: "Invoice ‮gnp.exe⁦ ​﻿👩‍💻",
      note: "a‮b\u0000c⁩",
      category: "Re​ading‮",
    });
    expect(cleaned.title).toBe("Invoice gnp.exe 👩‍💻");
    expect(cleaned.note).toBe("abc");
    expect(cleaned.category).toBe("Reading");
  });

  it("keeps the note's line breaks and tabs, as LF", () => {
    expect(normalizeClip({ ...base, note: "one\r\ntwo\rthree\n\tfour\u000b" }).note).toBe(
      "one\ntwo\nthree\n\tfour",
    );
    expect(normalizeClip({ ...base, title: "one\ntwo\tthree" }).title).toBe("onetwothree");
  });

  it("drops from the title what a file name can't hold, except / and :", () => {
    const title = 'a\\b*c?d"e<f>g|h/i:j --- k: [x] #y';
    expect(normalizeClip({ ...base, title }).title).toBe("abcdefgh/i:j --- k: [x] #y");
  });

  it("writes text as NFC, also after a removal joins a letter and its accent", () => {
    expect(normalizeClip({ ...base, title: "Café" }).title).toBe("Café");
    expect(normalizeClip({ ...base, title: "e<́" }).title).toBe("é");
    expect(normalizeClip({ ...base, title: "e​́" }).title).toBe("é");
  });

  it("drops lone surrogates, which have no canonical JSON", () => {
    expect(normalizeClip({ ...base, title: "a\ud800b", note: "\udc00c" })).toMatchObject({
      title: "ab",
      note: "c",
    });
  });

  it("is idempotent", () => {
    const samples = [
      "  Ünïcödé́ ‮ x  ",
      ".. hidden\t/folder: ?*",
      "e<́​́",
      "😀‍‍",
      "CON",
      "a ".repeat(80),
    ];
    for (const text of samples) {
      const once = normalizeClip({
        ...base,
        title: text.slice(0, 100),
        note: text,
        category: text,
      });
      expect(normalizeClip(once), JSON.stringify(text)).toEqual(once);
      expect(normalizeCategory(once.category)).toBe(once.category);
    }
  });

  it("takes only http: and https: links, as the URL parser writes them", () => {
    expect(normalizeClip({ ...base, url: " HTTPS://Example.COM/a b?q=ü#f " }).url).toBe(
      "https://example.com/a%20b?q=%C3%BC#f",
    );
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "nope"]) {
      expect(
        codeOf(() => normalizeClip({ ...base, url })),
        url,
      ).toBe("bad_url");
    }
  });

  it("refuses a field over its limit instead of cutting it", () => {
    const long = `https://example.com/${"a".repeat(CLIP_LIMITS.urlBytes)}`;
    expect(codeOf(() => normalizeClip({ ...base, url: long }))).toBe("too_long");
    expect(codeOf(() => normalizeClip({ ...base, title: "😀".repeat(301) }))).toBe("too_long");
    expect(normalizeClip({ ...base, title: "😀".repeat(300) }).title).toHaveLength(600);
    expect(codeOf(() => normalizeClip({ ...base, note: "x".repeat(4001) }))).toBe("too_long");
  });

  it("refuses malformed IDs, times and unknown fields", () => {
    for (const bad of [
      { clipId: "note_1248h248h248h248h248h248h2" },
      { workspaceId: "ws_1" },
      { extensionId: "tok_0h248h248h248h248h248h248h" },
      { savedAt: "2026-10-10T09:41:07Z" },
      { savedAt: "2026-02-30T09:41:07.512Z" },
      { v: 2 },
      { source: "x" },
      { title: 5 },
    ]) {
      expect(
        codeOf(() => normalizeClip({ ...base, ...bad } as never)),
        JSON.stringify(bad),
      ).toBe("invalid");
    }
  });
});

describe("invisible characters and line separators", () => {
  it("drops default ignorable characters, keeping U+200D and the emoji style selectors", () => {
    const cleaned = normalizeClip({
      ...base,
      title: "a\u3164b\u115fc\u034fd ❤\ufe0f 👩\u200d💻",
      note: "x\u3164y",
      category: "\u3164",
    });
    expect(cleaned.title).toBe("abcd ❤\ufe0f 👩\u200d💻");
    expect(cleaned.note).toBe("xy");
    // a category of nothing visible is the inbox itself
    expect(cleaned.category).toBe("");
    expect(normalizeCategory("Re\u3164ading")).toBe("Reading");
  });

  it("turns line and paragraph separators into a space, or a line break in the note", () => {
    const cleaned = normalizeClip({
      ...base,
      title: "one\u2028two\u2029three",
      note: "one\u2028two\u2029three",
      category: "a\u2028b",
    });
    expect(cleaned).toMatchObject({
      title: "one two three",
      note: "one\ntwo\nthree",
      category: "a b",
    });
  });
});

describe("categories", () => {
  it.each([
    ["  Reading   list  ", "Reading list"],
    ["Inbox", ""],
    ["INBOX", ""],
    ["inbox ", ""],
    ["a/b:c\\d", "a-b-c-d"],
    ["...hidden.", "hidden"],
    ["con", "_con"],
    ["Ünïcodé ok", "Ünïcodé ok"],
    ["x".repeat(70), "x".repeat(60)],
  ])("names %j as %j", (name, expected) => {
    expect(normalizeCategory(name)).toBe(expected);
  });
});

describe("signing and sealing", () => {
  it.each(vectors.clips)("signs the $name vector as listed", (vector) => {
    const seed = fromHex(vector.signingSeed);
    // libsodium's secret key layout: the seed, then the public key
    const secret = new Uint8Array([...seed, ...fromHex(vector.signPublicKey)]);
    const payload = normalizeClip(vector.payload);
    expect(payload).toEqual(vector.payload);
    expect(toHex(utf8Encode(`knowtarium-clip-v1\n${vector.canonical}`))).toBe(vector.message);
    expect(toHex(signClip(sodium(), payload, secret))).toBe(vector.signedPlaintext);
  });

  it("seals to the inbox key in 1 KiB steps, with the generation in the header", () => {
    const keys = createExtensionKeys();
    const inbox = vectors.inboxKeyPairs[0];
    if (inbox === undefined) throw new Error("no inbox vector");
    const sealed = signAndSealClip(base, {
      signingSecretKey: keys.privateKey,
      inboxKey: { generation: 3, publicKey: fromHex(inbox.publicKey) },
    });
    expect(Array.from(sealed.subarray(0, 5))).toEqual([1, 0, 0, 0, 3]);
    expect(sealed.length).toBe(5 + 48 + 1024);
    // the key as base64url works too, as an inbox_key envelope carries it
    const longer = signAndSealClip(
      { ...base, note: "x".repeat(2000) },
      {
        signingSecretKey: keys.privateKey,
        inboxKey: { generation: 3, publicKey: signedInbox.envelope.publicKey },
      },
    );
    expect(longer.length).toBe(5 + 48 + 3 * 1024);
  });

  it("fits the largest valid clip under 24 KiB", () => {
    const keys = createExtensionKeys();
    const sealed = signAndSealClip(
      {
        ...base,
        url: `https://example.com/${"a".repeat(2000)}`,
        title: "😀".repeat(300),
        note: "😀".repeat(4000),
        category: "😀".repeat(60),
      },
      {
        signingSecretKey: keys.privateKey,
        inboxKey: { generation: 1, publicKey: new Uint8Array(32).fill(9) },
      },
    );
    expect(sealed.length).toBeLessThanOrEqual(CLIP_LIMITS.sealedBytes);
  });

  it("refuses keys of the wrong size and a generation of 0", () => {
    const keys = createExtensionKeys();
    const inboxKey = { generation: 1, publicKey: new Uint8Array(32) };
    expect(
      codeOf(() => signAndSealClip(base, { signingSecretKey: keys.publicKey, inboxKey })),
    ).toBe("invalid");
    expect(
      codeOf(() =>
        signAndSealClip(base, {
          signingSecretKey: keys.privateKey,
          inboxKey: { generation: 1, publicKey: new Uint8Array(31) },
        }),
      ),
    ).toBe("invalid");
    expect(
      codeOf(() =>
        signAndSealClip(base, {
          signingSecretKey: keys.privateKey,
          inboxKey: { ...inboxKey, generation: 0 },
        }),
      ),
    ).toBe("invalid");
  });

  it("signs a queued payload again to the same signature, sealing it to new bytes", () => {
    const keys = createExtensionKeys();
    const inboxKey = { generation: 3, publicKey: signedInbox.envelope.publicKey };
    const options = { signingSecretKey: keys.privateKey, inboxKey };
    const first = signAndSealClip(base, options);
    const again = signAndSealClip(base, options);
    expect(toHex(first)).not.toBe(toHex(again));
    const payload = normalizeClip(base);
    expect(toHex(signClip(sodium(), payload, keys.privateKey))).toBe(
      toHex(signClip(sodium(), payload, keys.privateKey)),
    );
  });

  it("makes clip IDs from 16 random bytes", () => {
    const id = createClipId();
    expect(id).toMatch(/^clip_[0-7][0-9a-hjkmnp-tv-z]{25}$/);
    expect(createClipId()).not.toBe(id);
  });
});

describe("the owner-signed keys", () => {
  it("accepts the inbox_key vector under the pinned owner key", () => {
    expect(verifyInboxKey(signedInbox, { ...owner, minRevision: 1, minGeneration: 1 })).toBe(true);
    expect(verifyInboxKey(signedInbox, { ...owner, minRevision: 1, minGeneration: 3 })).toBe(true);
  });

  it("refuses a swapped inbox key, an older revision or generation, another workspace", () => {
    const swapped = {
      ...signedInbox,
      envelope: { ...signedInbox.envelope, publicKey: vectors.inboxKeyPairs[1]?.publicKey ?? "" },
    };
    const swappedKey = {
      ...signedInbox,
      envelope: {
        ...signedInbox.envelope,
        publicKey: extensionSignKey,
      },
    };
    expect(verifyInboxKey(swappedKey, { ...owner, minRevision: 1, minGeneration: 1 })).toBe(false);
    expect(verifyInboxKey(swapped, { ...owner, minRevision: 1, minGeneration: 1 })).toBe(false);
    expect(verifyInboxKey(signedInbox, { ...owner, minRevision: 2, minGeneration: 1 })).toBe(false);
    expect(verifyInboxKey(signedInbox, { ...owner, minRevision: 1, minGeneration: 4 })).toBe(false);
    expect(
      verifyInboxKey(signedInbox, {
        ...owner,
        workspaceId: "ws_3bbng6pxm1hjbt5bdrrf7dks7f",
        minRevision: 1,
        minGeneration: 1,
      }),
    ).toBe(false);
    const stranger = createExtensionKeys().publicKey;
    expect(
      verifyInboxKey(signedInbox, {
        ...owner,
        ownerSigningPublicKey: stranger,
        minRevision: 1,
        minGeneration: 1,
      }),
    ).toBe(false);
    const extra = { ...signedInbox, envelope: { ...signedInbox.envelope, noteId: "x" } };
    expect(verifyInboxKey(extra as never, { ...owner, minRevision: 1, minGeneration: 1 })).toBe(
      false,
    );
  });

  it("accepts the extension_key vector for exactly its extension and key", () => {
    const signed = {
      envelope: extensionVector.fields,
      signature: extensionVector.signature,
    } as unknown as clip.SignedExtensionKey;
    const expected = {
      ...owner,
      extensionId: extensionVector.fields.extensionId ?? "",
      signPublicKey: extensionSignKey,
    };
    expect(verifyExtensionKey(signed, expected)).toBe(true);
    expect(
      verifyExtensionKey(signed, { ...expected, signPublicKey: createExtensionKeys().publicKey }),
    ).toBe(false);
    expect(
      verifyExtensionKey(signed, { ...expected, extensionId: "ext_1h248h248h248h248h248h248h" }),
    ).toBe(false);
  });
});

describe("pairing", () => {
  it.each(vectors.extensionConfirmationCodes)("shows $code for $name", (vector) => {
    expect(extensionConfirmationCode(fromHex(vector.signPublicKey), vector.requestId)).toBe(
      vector.code,
    );
  });

  it("refuses a code over something else than a key and a request ID", () => {
    expect(
      codeOf(() => extensionConfirmationCode(new Uint8Array(31), "cr_1k6csk6csk6csk6csk6csk6csk")),
    ).toBe("invalid");
    expect(codeOf(() => extensionConfirmationCode(new Uint8Array(32), "tok_1"))).toBe("invalid");
  });

  it("opens the pairing vector with the secret and its own key", () => {
    const opened = openExtensionPairing(fromHex(pairingVector.sealed), {
      secret: fromHex(pairingVector.secret),
      signPublicKey: fromHex(pairingVector.signPublicKey),
    });
    const { expected } = pairingVector;
    expect(opened).toMatchObject({
      token: expected.token,
      extensionId: expected.extensionId,
      accountId: expected.accountId,
      workspaceId: expected.workspaceId,
      workspaceName: expected.workspaceName,
      categories: expected.categories,
    });
    expect(toHex(opened.ownerSigningPublicKey)).toBe(expected.ownerSigningPublicKey);
    expect(opened.inboxKey.envelope).toMatchObject({
      revision: expected.inboxKeyRevision,
      generation: expected.inboxKeyGeneration,
    });
    expect(opened.extensionKey.envelope.signPublicKey).toBe(extensionVector.fields.signPublicKey);
  });

  it.each(vectors.tamperedExtensionPairings)("refuses $name ($error)", (vector) => {
    expect(
      codeOf(() =>
        openExtensionPairing(fromHex(vector.sealed), {
          secret: fromHex(pairingVector.secret),
          signPublicKey: fromHex(pairingVector.signPublicKey),
        }),
      ),
    ).toBe(vector.error);
  });

  it("refuses the payload for another extension's key", () => {
    expect(
      codeOf(() =>
        openExtensionPairing(fromHex(pairingVector.sealed), {
          secret: fromHex(pairingVector.secret),
          signPublicKey: createExtensionKeys().publicKey,
        }),
      ),
    ).toBe("bad_payload");
  });

  it("writes the pairing link's fragment", () => {
    const secret = createConnectSecret();
    const keys = createExtensionKeys();
    expect(secret).toHaveLength(32);
    const fragment = formatExtensionConnectFragment({ signPublicKey: keys.publicKey, secret });
    expect(fragment).toMatch(/^signPublicKey=[A-Za-z0-9_-]{43}&secret=[A-Za-z0-9_-]{43}$/);
  });
});
