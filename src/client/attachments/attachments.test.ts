import { beforeAll, describe, expect, it } from "vitest";

import { assetLocation, attachmentKey, normalizeAttachmentName } from "../../core/index.js";
import { ready } from "../../crypto/index.js";
import { EncryptedCache, MemoryCacheAdapter } from "../cache/index.js";
import { LIMITS } from "../../protocol/index.js";
import {
  isSyncApiError,
  isVaultError,
  RequestValidationError,
  StorageFullError,
} from "../errors/index.js";
import type { AttachmentSnapshot } from "../sync/index.js";
import { World } from "../testing/world.js";
import {
  AttachmentUploadError,
  deleteAttachment,
  downloadAttachment,
  prepareAttachmentUpload,
  sendAttachmentUpload,
  uploadAttachment,
} from "./index.js";

beforeAll(ready);

/** Small chunks, so a few kilobytes make several of them. */
const CHUNK = 1024;

/** Bytes for the tests. */
const bytes = (length: number) => Uint8Array.from({ length }, (_, index) => (index * 31) % 251);

function attachmentsSeen(client: ReturnType<World["web"]>): AttachmentSnapshot[] {
  const seen: AttachmentSnapshot[] = [];
  client.engine.on("attachment", (event) => seen.push(event.attachment));
  return seen;
}

describe("attachments", () => {
  it("uploads encrypted chunks and metadata, syncs the name, and downloads the same bytes", async () => {
    const world = new World();
    const web = world.web();
    const data = bytes(2.5 * 1024);
    const progress: number[] = [];
    const { attachment, meta } = await uploadAttachment(web.api, web.keys, {
      workspaceId: world.workspaceId,
      folderId: world.folderId,
      name: "Diagram.png",
      type: "image/png",
      data,
      takenNames: [],
      chunkBytes: CHUNK,
      onProgress: (done) => progress.push(done),
    });
    expect(attachment).toMatchObject({ status: "complete", chunkCount: 3 });
    expect(meta).toEqual({ name: "Diagram.png", type: "image/png", sizeBytes: data.length });
    expect(progress.at(-1)).toBe(attachment.sizeBytes);
    // the server holds no name, type or plaintext size
    const stored = world.server.attachments.get(attachment.id);
    expect(JSON.stringify(stored?.attachment)).not.toContain("Diagram");

    // another client syncs the attachment with its name, and keeps it in its encrypted cache
    const cache = new EncryptedCache(new MemoryCacheAdapter());
    const other = world.web({ cache });
    const seen = attachmentsSeen(other);
    await other.engine.pull();
    expect(seen).toEqual([
      {
        attachmentId: attachment.id,
        folderId: world.folderId,
        name: "Diagram.png",
        type: "image/png",
        sizeBytes: data.length,
        deleted: false,
        createdAt: attachment.createdAt,
      },
    ]);
    const again = world.web({ cache });
    const restored = attachmentsSeen(again);
    await again.engine.load();
    // the cache keeps when it was created, for resolving same-name attachments oldest first
    expect(restored.map((entry) => [entry.name, entry.createdAt])).toEqual([
      ["Diagram.png", attachment.createdAt],
    ]);

    const download = await downloadAttachment(other.api, other.keys, {
      workspaceId: world.workspaceId,
      attachmentId: attachment.id,
    });
    expect(download.data).toEqual(data);

    await deleteAttachment(web.api, {
      workspaceId: world.workspaceId,
      attachmentId: attachment.id,
    });
    await other.engine.pull();
    expect(seen.at(-1)).toMatchObject({ attachmentId: attachment.id, deleted: true, name: null });
  });

  it("resumes a failed upload with the same prepared chunks", async () => {
    const world = new World();
    const web = world.web();
    const data = bytes(3 * 1024);
    let chunkCalls = 0;
    // the second chunk fails (a refusal the client doesn't retry by itself)
    world.server.tamper.refuse = (route) =>
      route === "uploadAttachmentChunk" && ++chunkCalls >= 2 ? "forbidden" : undefined;
    const failed = await uploadAttachment(web.api, web.keys, {
      workspaceId: world.workspaceId,
      folderId: world.folderId,
      name: "report.pdf",
      type: "application/pdf",
      data,
      takenNames: [],
      chunkBytes: CHUNK,
    }).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(AttachmentUploadError);
    const { upload } = failed as AttachmentUploadError;
    expect(world.server.attachments.get(upload.request.id)?.chunks).toHaveLength(1);
    delete world.server.tamper.refuse;
    const done = await sendAttachmentUpload(web.api, upload);
    expect(done.status).toBe("complete");
    const download = await downloadAttachment(web.api, web.keys, {
      workspaceId: world.workspaceId,
      attachmentId: done.id,
    });
    expect(download.data).toEqual(data);
  });

  it("refuses a taken name, a full storage and metadata that doesn't decrypt", async () => {
    const world = new World();
    const web = world.web();
    const details = {
      workspaceId: world.workspaceId,
      folderId: world.folderId,
      type: "image/png",
      data: bytes(10),
      takenNames: [] as string[],
    };
    const taken = await uploadAttachment(web.api, web.keys, {
      ...details,
      name: "Diagram.PNG",
      takenNames: ["diagram.png"],
    }).catch((error: unknown) => error);
    expect(taken).toBeInstanceOf(RequestValidationError);
    const note = await uploadAttachment(web.api, web.keys, { ...details, name: "x.md" }).catch(
      (error: unknown) => error,
    );
    expect(note).toBeInstanceOf(RequestValidationError);

    world.server.quotaBytes = 5;
    const full = await uploadAttachment(web.api, web.keys, { ...details, name: "a.png" }).catch(
      (error: unknown) => error,
    );
    expect(full).toBeInstanceOf(StorageFullError);
    world.server.quotaBytes = Number.MAX_SAFE_INTEGER;

    const { attachment } = await uploadAttachment(web.api, web.keys, { ...details, name: "b.png" });
    const entry = world.server.attachments.get(attachment.id);
    // a server swapping in another attachment's metadata: it no longer decrypts
    const second = await uploadAttachment(web.api, web.keys, { ...details, name: "c.png" });
    const swapped = world.server.attachments.get(second.attachment.id);
    if (entry === undefined || swapped === undefined) throw new Error("expected both");
    entry.attachment = { ...entry.attachment, encMeta: swapped.attachment.encMeta };
    const refused = await downloadAttachment(web.api, web.keys, {
      workspaceId: world.workspaceId,
      attachmentId: attachment.id,
    }).catch((error: unknown) => error);
    expect(isVaultError(refused, "invalid_attachment")).toBe(true);

    // a record claiming more chunks or bytes than the metadata allows is refused before fetching
    const third = await uploadAttachment(web.api, web.keys, { ...details, name: "d.png" });
    const stored = world.server.attachments.get(third.attachment.id);
    if (stored === undefined) throw new Error("expected the upload");
    const asked = () =>
      world.server.requests.filter(({ url }) => url.includes(`${third.attachment.id}/chunks`))
        .length;
    const before = asked();
    stored.attachment = { ...stored.attachment, chunkCount: 99 };
    const inflated = await downloadAttachment(web.api, web.keys, {
      workspaceId: world.workspaceId,
      attachmentId: third.attachment.id,
    }).catch((error: unknown) => error);
    expect(isVaultError(inflated, "invalid_attachment")).toBe(true);
    expect(asked()).toBe(before);
    // and its metadata, bound to its folder, doesn't open under another one
    stored.attachment = {
      ...stored.attachment,
      chunkCount: 1,
      // another folder: the last character changed (never to itself)
      folderId: world.folderId.replace(/.$/, (last) => (last === "x" ? "y" : "x")) as never,
    };
    const moved = await downloadAttachment(web.api, web.keys, {
      workspaceId: world.workspaceId,
      attachmentId: third.attachment.id,
    }).catch((error: unknown) => error);
    expect(isVaultError(moved, "invalid_attachment")).toBe(true);
  });
});

describe("attachment names and links", () => {
  it("normalizes names and maps an asset link to the attachment it names", () => {
    expect(normalizeAttachmentName("diagram.png")).toBe("diagram.png");
    expect(() => normalizeAttachmentName("a/b.png")).toThrow();
    expect(() => normalizeAttachmentName("note.md")).toThrow();
    expect(assetLocation("Projects/Assets/Diagram.png")).toEqual({
      folder: "Projects/Assets",
      name: "Diagram.png",
    });
    expect(assetLocation("diagram.png")).toEqual({ folder: "", name: "diagram.png" });
    expect(attachmentKey(assetLocation("Projects/DIAGRAM.png"))).toBe(
      attachmentKey({ folder: "projects", name: "diagram.PNG" }),
    );
  });
});

describe("the sync API's chunk rules, which the fake server enforces too", () => {
  const prepare = (world: World, data: Uint8Array, chunkBytes = CHUNK) =>
    prepareAttachmentUpload(world.web().keys, {
      workspaceId: world.workspaceId,
      folderId: world.folderId,
      name: "file.bin",
      type: "application/octet-stream",
      data,
      takenNames: [],
      chunkBytes,
    });
  const causeOf = (error: unknown) => (error as AttachmentUploadError).cause;

  it("refuses a chunk count the size doesn't allow, before storing anything", async () => {
    const world = new World();
    const web = world.web();
    const upload = await prepare(world, bytes(3 * 1024));
    for (const chunkCount of [upload.request.sizeBytes, 0, 1_000_000]) {
      const error = await sendAttachmentUpload(web.api, {
        ...upload,
        request: { ...upload.request, chunkCount },
      }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(AttachmentUploadError);
      const cause = causeOf(error);
      expect(
        isSyncApiError(cause, "invalid_request") || cause instanceof RequestValidationError,
      ).toBe(true);
    }
    expect(world.server.attachments.size).toBe(0);
  });

  it("refuses a chunk over the chunk limit, one smaller than an envelope, and too many bytes", async () => {
    const world = new World();
    const web = world.web();
    /** Sends other chunks under a freshly prepared upload's id and returns the failure. */
    const attempt = async (chunks: Uint8Array[], sizeBytes: number) => {
      const upload = await prepare(world, bytes(3 * 1024));
      return sendAttachmentUpload(web.api, {
        ...upload,
        chunks,
        request: { ...upload.request, sizeBytes, chunkCount: chunks.length },
      }).catch((error: unknown) => causeOf(error));
    };
    const big = new Uint8Array(LIMITS.attachmentChunkBytes + 1);
    const envelope = new Uint8Array(1100);
    expect(
      isSyncApiError(await attempt([big, envelope], big.length + 1100), "payload_too_large"),
    ).toBe(true);
    expect(
      isSyncApiError(
        await attempt([new Uint8Array(10), new Uint8Array(90)], 100),
        "invalid_request",
      ),
    ).toBe(true);
    // chunks that add up to more than the announced size
    expect(isSyncApiError(await attempt([envelope, envelope], 1100 + 46), "invalid_request")).toBe(
      true,
    );
  });

  it("checks the rules before sending: a chunk size over the limit", async () => {
    const world = new World();
    await expect(
      prepare(world, new Uint8Array(LIMITS.attachmentChunkBytes), LIMITS.attachmentChunkBytes),
    ).rejects.toBeInstanceOf(RequestValidationError);
  });

  it("uploads, syncs and downloads an empty file: one empty envelope", async () => {
    const world = new World();
    const web = world.web();
    const { attachment, meta } = await uploadAttachment(web.api, web.keys, {
      workspaceId: world.workspaceId,
      folderId: world.folderId,
      name: "empty.txt",
      type: "text/plain",
      data: new Uint8Array(0),
      takenNames: [],
    });
    expect(attachment).toMatchObject({ status: "complete", chunkCount: 1, sizeBytes: 45 });
    expect(meta).toEqual({ name: "empty.txt", type: "text/plain", sizeBytes: 0 });

    const other = world.web();
    const seen = attachmentsSeen(other);
    await other.engine.pull();
    expect(seen).toMatchObject([{ attachmentId: attachment.id, name: "empty.txt", sizeBytes: 0 }]);
    const download = await downloadAttachment(other.api, other.keys, {
      workspaceId: world.workspaceId,
      attachmentId: attachment.id,
    });
    expect(download.data).toEqual(new Uint8Array(0));
  });
});
