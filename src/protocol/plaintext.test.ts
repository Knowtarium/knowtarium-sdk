import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CIPHERTEXT_SCHEMAS } from "./ciphertext.js";
import * as protocol from "./index.js";

/*
 * The server must never receive readable user content, so no schema may have a field that looks
 * like one, every user-content field is ciphertext named `ciphertext` or `enc*`, and every string
 * a schema accepts is one of a known list of formats (IDs, timestamps, hashes, keys, secrets,
 * ciphertext, enums). A free `z.string()` anywhere fails.
 */

/** Field names (or camelCase name endings, like `folderName`) that would hold plaintext. */
const CONTENT_WORDS = [
  "title",
  "name",
  "body",
  "content",
  "text",
  "tag",
  "tags",
  "link",
  "links",
  "path",
  "filename",
  "description",
  "frontmatter",
  "label",
  "summary",
  "diff",
  "markdown",
  "query",
  "subject",
  "anchor",
  "result",
];

/** The string formats a schema may accept. */
const SAFE_STRINGS = new Set<z.ZodType>([
  protocol.AccountId,
  protocol.SessionId,
  protocol.WorkspaceId,
  protocol.FolderId,
  protocol.NoteId,
  protocol.PendingId,
  protocol.EventId,
  protocol.CommentId,
  protocol.CheckId,
  protocol.TokenId,
  protocol.ConnectRequestId,
  protocol.AttachmentId,
  protocol.Timestamp,
  protocol.SignedTimestamp,
  protocol.Email,
  protocol.PlanId,
  protocol.CliVersion,
  protocol.Base64Url,
  protocol.PublicKey,
  protocol.Signature,
  protocol.AuthHash,
  protocol.Sha256,
  protocol.CiphertextSha256,
  protocol.RecipientsHash,
  protocol.KeyCommitment,
  protocol.AgentPolicySha256,
  protocol.AgentPolicyRevisionHeader,
  protocol.Salt,
  protocol.LoopbackSecret,
  protocol.RecoveryGrant,
  protocol.AccountResetToken,
  protocol.BillingUrl,
  protocol.ProductId,
  protocol.CurrencyCode,
  protocol.AgentTokenSecret,
  protocol.PollSecret,
  protocol.LiveTicket,
  protocol.PendingNonce,
  protocol.VersionTag,
  protocol.ErrorMessage,
  protocol.IssuePathKey,
  ...CIPHERTEXT_SCHEMAS,
]);

/** Leaf types that accept arbitrary strings or values unless they are a known format. */
const OPEN_TYPES = new Set(["string", "custom", "template_literal", "any", "unknown"]);

interface LooseDef {
  type: string;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  innerType?: z.ZodType;
  options?: z.ZodType[];
  left?: z.ZodType;
  right?: z.ZodType;
  in?: z.ZodType;
  out?: z.ZodType;
  keyType?: z.ZodType;
  valueType?: z.ZodType;
  items?: z.ZodType[];
  getter?: () => z.ZodType;
}

const def = (schema: z.ZodType) => schema._zod.def as unknown as LooseDef;

const WRAPPERS = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "readonly",
  "nonoptional",
]);

function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (let d = def(current); WRAPPERS.has(d.type) && d.innerType; d = def(current)) {
    current = d.innerType;
  }
  return current;
}

const isCiphertextKey = (key: string) => key === "ciphertext" || /^enc[A-Z]/.test(key);

const hasContentName = (key: string) =>
  CONTENT_WORDS.some(
    (word) =>
      key.toLowerCase() === word || key.endsWith(word.charAt(0).toUpperCase() + word.slice(1)),
  );

/** What is wrong with a schema, as readable strings (empty when nothing is). */
function violations(root: z.ZodType, where: string): string[] {
  const problems: string[] = [];
  const seen = new Set<z.ZodType>();

  function checkField(key: string, schema: z.ZodType, path: string): void {
    const holdsCiphertext = CIPHERTEXT_SCHEMAS.includes(unwrap(schema));
    if (isCiphertextKey(key)) {
      if (!holdsCiphertext) problems.push(`${path} is named as ciphertext but isn't`);
      return;
    }
    if (holdsCiphertext) problems.push(`${path} holds ciphertext under a plain name`);
    if (hasContentName(key)) problems.push(`${path} looks like a plaintext content field`);
  }

  function visit(schema: z.ZodType, path: string): void {
    if (SAFE_STRINGS.has(schema) || seen.has(schema)) return;
    seen.add(schema);
    const d = def(schema);
    if (OPEN_TYPES.has(d.type)) {
      problems.push(`${path} accepts free ${d.type === "string" ? "text" : d.type} values`);
      return;
    }
    if (d.type === "object" && d.shape) {
      for (const [key, child] of Object.entries(d.shape)) {
        checkField(key, child, `${path}.${key}`);
        visit(child, `${path}.${key}`);
      }
    }
    if (d.type === "lazy" && d.getter) visit(d.getter(), path);
    const children = [
      ...(d.options ?? []),
      ...(d.items ?? []),
      d.element,
      d.innerType,
      d.left,
      d.right,
      d.in,
      d.out,
      d.keyType,
      d.valueType,
    ];
    for (const child of children) if (child) visit(child, path);
  }

  visit(root, where);
  return problems;
}

/** Every schema the package exports or uses in a route. */
function allSchemas(): [string, z.ZodType][] {
  const found: [string, z.ZodType][] = [];
  for (const [name, value] of Object.entries(protocol)) {
    if (value instanceof z.ZodType) found.push([name, value]);
  }
  for (const route of protocol.ROUTE_LIST) {
    for (const part of [
      "params",
      "query",
      "headers",
      "body",
      "response",
      "responseHeaders",
    ] as const) {
      const value: unknown = route[part];
      if (value instanceof z.ZodType) found.push([`${route.name}.${part}`, value]);
    }
  }
  return found;
}

describe("no plaintext content", () => {
  it("finds the schemas to check", () => {
    expect(allSchemas().length).toBeGreaterThan(100);
  });

  it("has no plaintext content field and no free string in any schema", () => {
    const problems = allSchemas().flatMap(([name, schema]) => violations(schema, name));
    expect(problems).toEqual([]);
  });

  it("catches plaintext fields, free strings and mislabeled ciphertext", () => {
    const bad = z.object({
      title: protocol.Ciphertext.optional(),
      nested: z.array(z.object({ folderName: z.string().optional() })),
      encTitle: protocol.Sha256,
      hidden: protocol.Ciphertext,
      notes: z.lazy(() => z.object({ remark: z.string().max(10) })),
      extra: z.record(z.string(), z.int()),
      loose: z.unknown(),
    });
    expect(violations(bad, "bad")).toEqual([
      "bad.title holds ciphertext under a plain name",
      "bad.title looks like a plaintext content field",
      "bad.nested.folderName looks like a plaintext content field",
      "bad.nested.folderName accepts free text values",
      "bad.encTitle is named as ciphertext but isn't",
      "bad.hidden holds ciphertext under a plain name",
      "bad.notes.remark accepts free text values",
      "bad.extra accepts free text values",
      "bad.loose accepts free unknown values",
    ]);
  });

  it("accepts ciphertext under the right names and known formats", () => {
    const good = z.object({
      encName: protocol.EncName,
      ciphertext: protocol.Ciphertext.nullable(),
      items: z.array(z.object({ encWorkspaceKey: protocol.EncKey.optional() })),
      at: protocol.Timestamp,
      status: z.enum(["open", "closed"]),
      noteId: protocol.NoteId,
    });
    expect(violations(good, "good")).toEqual([]);
  });
});
