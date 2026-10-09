// The shared vectors test: knowtarium/protocol has its own tiny canonicalizer and envelope schemas
// (it can't import crypto), so it must agree with knowtarium/crypto on every committed envelope
// vector. This file sits outside both modules: it runs protocol code against crypto's JSON, and
// checks the JSON's type table against both crypto's tables and protocol's schemas.
import { beforeAll, describe, expect, it } from "vitest";

import { canonicalJson as cryptoCanonicalJson, type JsonValue } from "./crypto/canonical-json.js";
import vectors from "./crypto/envelope-vectors.json" with { type: "json" };
import {
  ciphertextSha256,
  KEY_COMMITMENT_TAG,
  RECIPIENTS_HASH_TAG,
  recipientsHash,
  workspaceKeyCommitment,
} from "./crypto/hash.js";
import {
  SIGNED_ENVELOPE_OPTIONAL,
  SIGNED_ENVELOPE_TOGETHER,
  SIGNED_ENVELOPE_TYPES,
} from "./crypto/signed-envelope.js";
import { ready } from "./crypto/sodium.js";
import {
  AGENT_POLICY_FOLDER_HASH_TAG,
  AGENT_POLICY_HASH_TAG,
  type AgentPolicyFolder,
  agentPolicyFolderHash,
  agentPolicyFolderText,
  agentPolicySha256,
  agentPolicyText,
  type AgentWriteMode,
  canonicalEnvelope,
  MISSING_AGENT_POLICY_SHA256,
  canonicalJson,
  ENVELOPE_SIGNING_PREFIX,
  envelopeSigningText,
  SignedEnvelope,
} from "./protocol/index.js";
import type { z } from "zod";

type FlatRecord = Record<string, string | number>;

// no DOM or Node types in src/: the few Web APIs the test needs, typed here
interface WebApis {
  TextEncoder: new () => { encode(input: string): Uint8Array };
  atob(data: string): string;
  crypto: {
    subtle: {
      digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
      importKey(
        format: "raw",
        key: Uint8Array,
        algorithm: { name: "Ed25519" },
        extractable: false,
        usages: ["verify"],
      ): Promise<unknown>;
      verify(
        algorithm: { name: "Ed25519" },
        key: unknown,
        signature: Uint8Array,
        data: Uint8Array,
      ): Promise<boolean>;
    };
  };
}
const web = globalThis as unknown as WebApis;

const utf8 = (text: string) => new web.TextEncoder().encode(text);
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
const fromBase64Url = (text: string) =>
  Uint8Array.from(web.atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** Whether `value` is what protocol's canonicalizer takes: a flat record of strings and integers. */
function isFlatRecord(value: unknown): value is FlatRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((field) => typeof field === "string" || typeof field === "number")
  );
}

interface TypeRules {
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly together: readonly (readonly string[])[];
}
const types = vectors.types as Record<string, TypeRules>;
const sorted = (list: readonly string[]) => [...list].sort();

/** The type table as protocol's schemas have it: required and optional fields besides the base. */
function protocolTypes(): Record<string, Omit<TypeRules, "together">> {
  const table: Record<string, Omit<TypeRules, "together">> = {};
  for (const option of SignedEnvelope.options) {
    const fields = Object.entries(option.shape as Record<string, z.ZodType>).filter(
      ([key]) => !vectors.baseFields.includes(key),
    );
    const optional = fields.filter(([, schema]) => schema.safeParse(undefined).success);
    table[option.shape.type.value] = {
      required: fields.filter((field) => !optional.includes(field)).map(([key]) => key),
      optional: optional.map(([key]) => key),
    };
  }
  return table;
}

describe("the type table in envelope-vectors.json", () => {
  it("matches knowtarium/crypto's tables", () => {
    expect(sorted(Object.keys(types))).toEqual(sorted(Object.keys(SIGNED_ENVELOPE_TYPES)));
    const optional = SIGNED_ENVELOPE_OPTIONAL as Partial<Record<string, readonly string[]>>;
    const together = SIGNED_ENVELOPE_TOGETHER as Partial<
      Record<string, readonly (readonly string[])[]>
    >;
    for (const [type, rules] of Object.entries(types)) {
      const required: readonly string[] =
        SIGNED_ENVELOPE_TYPES[type as keyof typeof SIGNED_ENVELOPE_TYPES];
      expect(sorted(rules.required), type).toEqual(sorted(required));
      expect(sorted(rules.optional), type).toEqual(sorted(optional[type] ?? []));
      expect(rules.together, type).toEqual(together[type] ?? []);
    }
  });

  it("matches knowtarium/protocol's schemas", () => {
    const table = protocolTypes();
    expect(sorted(Object.keys(table))).toEqual(sorted(Object.keys(types)));
    for (const [type, rules] of Object.entries(types)) {
      expect(sorted(table[type]?.required ?? []), type).toEqual(sorted(rules.required));
      expect(sorted(table[type]?.optional ?? []), type).toEqual(sorted(rules.optional));
    }
    for (const option of SignedEnvelope.options) {
      expect(Object.keys(option.shape)).toEqual(expect.arrayContaining(vectors.baseFields));
    }
  });

  it("has protocol refuse a partial group of fields that come together", () => {
    for (const [type, rules] of Object.entries(types)) {
      for (const group of rules.together) {
        const vector = vectors.signedEnvelopes.find(
          ({ fields }) => fields.type === type && group.every((key) => key in fields),
        );
        expect(vector, `a ${type} vector with ${group.join(", ")}`).toBeDefined();
        const fields = vector?.fields as Record<string, unknown>;
        const without = (keys: readonly string[]) =>
          Object.fromEntries(Object.entries(fields).filter(([key]) => !keys.includes(key)));
        expect(SignedEnvelope.safeParse(without(group)).success).toBe(true);
        for (const key of group) {
          expect(SignedEnvelope.safeParse(without([key])).success, key).toBe(false);
        }
      }
    }
  });

  it("has an invalid vector for every missing required field", () => {
    const invalid = new Map(vectors.invalidEnvelopes.map((vector) => [vector.name, vector.fields]));
    for (const [type, rules] of Object.entries(types)) {
      for (const field of rules.required) {
        const fields = invalid.get(`${type} without ${field}`) as Record<string, unknown>;
        expect(fields, `${type} without ${field}`).toBeDefined();
        expect(fields["type"]).toBe(type);
        expect(field in fields).toBe(false);
      }
    }
    for (const field of vectors.baseFields) {
      expect(invalid.has(`no ${field}`), `no ${field}`).toBe(true);
    }
  });
});

describe("knowtarium/protocol against envelope-vectors.json", () => {
  it("uses the same signing prefix", () => {
    expect(ENVELOPE_SIGNING_PREFIX).toBe(vectors.messagePrefix);
  });

  it("covers every signed envelope type", () => {
    const types = new Set(vectors.signedEnvelopes.map((vector) => vector.fields.type));
    const schemaTypes = SignedEnvelope.options.map((option) => option.shape.type.value);
    expect([...types].sort()).toEqual([...schemaTypes].sort());
  });

  // protocol's canonicalizer handles flat records only: it must reproduce every flat vector and
  // refuse the rest, so it can never produce a different text than crypto's
  it("reproduces every flat canonical JSON vector", () => {
    const flat = vectors.canonicalJson.filter((vector) => isFlatRecord(vector.value));
    expect(flat.length).toBeGreaterThanOrEqual(3);
    for (const { name, value, canonical } of flat) {
      expect(canonicalJson(value as FlatRecord), name).toBe(canonical);
    }
  });

  it.each(vectors.canonicalJson.filter((vector) => !isFlatRecord(vector.value)))(
    "refuses $name, which is not a flat record",
    ({ value }) => {
      expect(() => canonicalJson(value as unknown as FlatRecord)).toThrow(TypeError);
    },
  );

  it.each(vectors.nonCanonicalJson)("refuses $name", ({ value }) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });

  // lone surrogates: both canonicalizers must refuse them (crypto's own tests read only the
  // nonCanonicalJson list, so both are checked here)
  it.each(vectors.nonCanonicalJsonText)("refuses $name, like crypto", ({ json }) => {
    const value = JSON.parse(json) as Record<string, string | number>;
    expect(() => canonicalJson(value)).toThrow(TypeError);
    expect(() => cryptoCanonicalJson(value as JsonValue)).toThrow(
      expect.objectContaining({ code: "non_canonical_json" }),
    );
  });

  it.each(vectors.signedEnvelopes)("accepts and reproduces $name", async (vector) => {
    const parsed = SignedEnvelope.parse(vector.fields);
    expect(canonicalJson(vector.fields as FlatRecord)).toBe(vector.canonical);
    expect(canonicalEnvelope(parsed)).toBe(vector.canonical);
    const text = envelopeSigningText(parsed);
    expect(toHex(utf8(text))).toBe(vector.message);

    // what the sync API does: Web Crypto Ed25519 over the text protocol rebuilt
    const { subtle } = web.crypto;
    const key = await subtle.importKey(
      "raw",
      fromHex(vector.publicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const signature = fromBase64Url(vector.signature);
    expect(await subtle.verify({ name: "Ed25519" }, key, signature, utf8(text))).toBe(true);
    const tampered = utf8(text.replace(vector.fields.accountId, `${vector.fields.accountId}x`));
    expect(await subtle.verify({ name: "Ed25519" }, key, signature, tampered)).toBe(false);
  });

  it.each(vectors.invalidEnvelopes)("refuses an envelope with $name", ({ fields }) => {
    expect(SignedEnvelope.safeParse(fields).success).toBe(false);
  });
});

describe("recipient set hashes", () => {
  beforeAll(ready);

  it.each(vectors.recipientsHashes)("hashes $name", async (vector) => {
    expect(vectors.recipientsHashTag).toBe(RECIPIENTS_HASH_TAG);
    const keys = vector.publicKeys.map(fromHex);
    expect(recipientsHash(keys)).toBe(vector.recipientsHash);
    // what the sync API does from the public keys it stores: Web Crypto SHA-256, no libsodium
    const sorted = [...new Set(vector.publicKeys)].sort().map(fromHex);
    const parts = [
      utf8(vectors.recipientsHashTag),
      ...sorted.flatMap((key) => [Uint8Array.of(0, 0, 0, key.length), key]),
    ];
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    const digest = new Uint8Array(await web.crypto.subtle.digest("SHA-256", bytes));
    expect(toHex(digest)).toBe(vector.recipientsHash);
  });
});

describe("key commitments", () => {
  beforeAll(ready);

  it.each(vectors.keyCommitments)("commits to $name", async (vector) => {
    expect(vectors.keyCommitmentTag).toBe(KEY_COMMITMENT_TAG);
    const key = { generation: vector.generation, key: fromHex(vector.key) };
    expect(workspaceKeyCommitment(key, vector.workspaceId)).toBe(vector.keyCommitment);
    // what any holder of the key can compute with Web Crypto alone
    const generation = Uint8Array.of(
      (vector.generation >>> 24) & 0xff,
      (vector.generation >>> 16) & 0xff,
      (vector.generation >>> 8) & 0xff,
      vector.generation & 0xff,
    );
    const parts = [utf8(vectors.keyCommitmentTag), generation, key.key, utf8(vector.workspaceId)];
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    const digest = new Uint8Array(await web.crypto.subtle.digest("SHA-256", bytes));
    expect(toHex(digest)).toBe(vector.keyCommitment);
  });
});

describe("agent policy hashes", () => {
  beforeAll(ready);

  it("uses the tags the vectors pin", () => {
    expect(AGENT_POLICY_HASH_TAG).toBe(vectors.agentPolicyTag);
    expect(AGENT_POLICY_FOLDER_HASH_TAG).toBe(vectors.agentPolicyFolderTag);
  });

  it.each(vectors.agentPolicyHashes)("hashes $name", async (vector) => {
    const mode = vector.default as AgentWriteMode;
    const folders = vector.folders.map(({ folderId, mode }) => ({
      folderId,
      mode,
    })) as AgentPolicyFolder[];
    for (const [index, folder] of folders.entries()) {
      // protocol's text is crypto's canonical JSON (RFC 8785) behind the tag
      const text = agentPolicyFolderText(folder);
      expect(text).toBe(vectors.agentPolicyFolderTag + cryptoCanonicalJson({ ...folder }));
      expect(ciphertextSha256(utf8(text))).toBe(vector.folders[index]?.sha256);
      expect(await agentPolicyFolderHash(folder)).toBe(vector.folders[index]?.sha256);
    }
    const hashes = vector.folders.map((folder) => folder.sha256);
    expect(agentPolicyText(mode, hashes)).toBe(vector.text);
    expect(vector.text).toBe(
      vectors.agentPolicyTag + cryptoCanonicalJson({ default: mode, folders: [...hashes].sort() }),
    );
    expect(ciphertextSha256(utf8(vector.text))).toBe(vector.policySha256);
    expect(await agentPolicySha256({ default: mode, folders })).toBe(vector.policySha256);
    expect(await agentPolicySha256({ default: mode, folders: [...folders].reverse() })).toBe(
      vector.policySha256,
    );
    // an agent's view: overrides outside its scope come as their hashes only
    for (let shown = 0; shown <= folders.length; shown++) {
      const view = {
        default: mode,
        folders: folders.slice(0, shown),
        otherFolderHashes: hashes.slice(shown),
      };
      expect(await agentPolicySha256(view)).toBe(vector.policySha256);
    }
  });

  it("is what the agent_policy and agent_edited vectors sign", () => {
    const fields = (type: string) =>
      vectors.signedEnvelopes.find((vector) => vector.fields.type === type)?.fields as
        Record<string, unknown> | undefined;
    const hashes = vectors.agentPolicyHashes.map((vector) => vector.policySha256);
    expect(hashes).toContain(fields("agent_policy")?.["policySha256"]);
    expect(fields("agent_edited")?.["policySha256"]).toBe(fields("agent_policy")?.["policySha256"]);
    expect(fields("agent_edited")?.["revision"]).toBe(fields("agent_policy")?.["revision"]);
  });

  it("pins the hash of the missing policy", () => {
    const missing = vectors.agentPolicyHashes.find(
      (vector) => vector.default === "direct" && vector.folders.length === 0,
    );
    expect(missing?.policySha256).toBe(MISSING_AGENT_POLICY_SHA256);
  });

  it("vouches in agent_key for the key that signs agent_edited", () => {
    const key = vectors.signedEnvelopes.find((vector) => vector.fields.type === "agent_key");
    const edited = vectors.signedEnvelopes.find((vector) => vector.fields.type === "agent_edited");
    const vouched = (key?.fields as Record<string, unknown>)["signPublicKey"] as string;
    expect(toHex(fromBase64Url(vouched))).toBe(edited?.publicKey);
    expect(edited?.publicKey).not.toBe(key?.publicKey);
    expect((edited?.fields as Record<string, unknown>)["tokenId"]).toBe(
      (key?.fields as Record<string, unknown>)["tokenId"],
    );
  });

  it("refuses a malformed input instead of hashing it", () => {
    const hash = "0".repeat(64);
    expect(() => agentPolicyText("sometimes" as AgentWriteMode, [])).toThrow(TypeError);
    expect(() => agentPolicyText("direct", ["A".repeat(64)])).toThrow(TypeError);
    expect(() => agentPolicyText("direct", [hash, hash])).toThrow(TypeError);
  });
});
