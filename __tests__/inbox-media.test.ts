import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    message: { findUnique: vi.fn() },
    messageAttachment: { upsert: vi.fn() },
    contactAvatar: { upsert: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { fetchMedia, storeAttachment, MAX_MEDIA_BYTES } from "@/lib/inbox/media";
import { webhookAttachment } from "@/lib/meta/webhook";
import { isAttachmentPlaceholder } from "@/lib/inbox/placeholders";

const fetchMock = vi.fn();

function response(options: {
  ok?: boolean;
  bytes?: number;
  contentType?: string;
  contentLength?: string;
}) {
  const bytes = options.bytes ?? 4;
  const headers = new Map<string, string>();
  if (options.contentType) headers.set("content-type", options.contentType);
  headers.set("content-length", options.contentLength ?? String(bytes));
  return {
    ok: options.ok ?? true,
    headers: { get: (k: string) => headers.get(k) ?? null },
    arrayBuffer: async () => new ArrayBuffer(bytes),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});

describe("webhookAttachment", () => {
  it("takes the media url off an incoming message", () => {
    expect(
      webhookAttachment({
        attachments: [{ type: "image", payload: { url: "https://cdn/x.jpg" } }],
      })
    ).toEqual({ type: "image", url: "https://cdn/x.jpg" });
  });

  it("takes video and voice notes too", () => {
    expect(
      webhookAttachment({
        attachments: [{ type: "audio", payload: { url: "https://cdn/x.m4a" } }],
      })?.type
    ).toBe("audio");
    expect(
      webhookAttachment({
        attachments: [{ type: "video", payload: { url: "https://cdn/x.mp4" } }],
      })?.type
    ).toBe("video");
  });

  it("ignores our own template DM coming back as an echo", () => {
    // payload.generic is a title and a button, not a file. Treating it as an
    // attachment would send the downloader after the button's target.
    expect(
      webhookAttachment({
        attachments: [
          {
            type: "template",
            payload: { url: "https://example.com/link", generic: {} },
          },
        ],
      })
    ).toBeUndefined();
  });

  it("leaves a shared post alone", () => {
    // A share points at somebody else's post and dies with it; the placeholder
    // outlives the link.
    expect(
      webhookAttachment({
        attachments: [{ type: "share", payload: { url: "https://cdn/s" } }],
      })
    ).toBeUndefined();
  });

  it("returns nothing when there is no attachment", () => {
    expect(webhookAttachment({})).toBeUndefined();
    expect(webhookAttachment({ attachments: [{ type: "image" }] })).toBeUndefined();
  });
});

describe("fetchMedia", () => {
  it("returns the bytes and the type", async () => {
    fetchMock.mockResolvedValue(response({ bytes: 12, contentType: "image/jpeg" }));

    const media = await fetchMedia("https://cdn/x.jpg");

    expect(media?.byteSize).toBe(12);
    expect(media?.mimeType).toBe("image/jpeg");
  });

  it("drops the charset off the content type", async () => {
    fetchMock.mockResolvedValue(
      response({ contentType: "image/jpeg; charset=binary" })
    );

    expect((await fetchMedia("https://cdn/x"))?.mimeType).toBe("image/jpeg");
  });

  it("gives up on an expired link instead of throwing", async () => {
    // The ordinary outcome for a backfill or a slow retry: the message keeps
    // its placeholder and nothing fails.
    fetchMock.mockResolvedValue(response({ ok: false }));

    expect(await fetchMedia("https://cdn/gone")).toBeNull();
  });

  it("refuses a file over the limit before downloading it", async () => {
    fetchMock.mockResolvedValue(
      response({ contentLength: String(MAX_MEDIA_BYTES + 1) })
    );

    expect(await fetchMedia("https://cdn/huge.mp4")).toBeNull();
  });

  it("refuses an oversized body that declared no length", async () => {
    // A missing or lying content-length is why the body is measured as well.
    fetchMock.mockResolvedValue(
      response({ bytes: MAX_MEDIA_BYTES + 1, contentLength: "0" })
    );

    expect(await fetchMedia("https://cdn/huge.mp4")).toBeNull();
  });

  it("refuses an empty body", async () => {
    fetchMock.mockResolvedValue(response({ bytes: 0 }));

    expect(await fetchMedia("https://cdn/empty")).toBeNull();
  });
});

describe("storeAttachment", () => {
  const media = {
    data: new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>,
    mimeType: "image/jpeg",
    byteSize: 3,
  };

  it("files the bytes against the message", async () => {
    mockPrisma.message.findUnique.mockResolvedValue({
      id: "msg_1",
      workspaceId: "ws_1",
    });

    expect(await storeAttachment({ mid: "mid_1", type: "image", media })).toBe(
      true
    );
    expect(mockPrisma.messageAttachment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { messageId: "msg_1" } })
    );
  });

  it("does nothing when the message is not stored", async () => {
    // The download can land before the message is written, or after retention
    // removed it. Neither is worth failing over.
    mockPrisma.message.findUnique.mockResolvedValue(null);

    expect(await storeAttachment({ mid: "mid_gone", type: "image", media })).toBe(
      false
    );
    expect(mockPrisma.messageAttachment.upsert).not.toHaveBeenCalled();
  });
});

describe("isAttachmentPlaceholder", () => {
  it("knows the stand-in captions", () => {
    expect(isAttachmentPlaceholder("[Bild]")).toBe(true);
    expect(isAttachmentPlaceholder("[Sprachnachricht]")).toBe(true);
    expect(isAttachmentPlaceholder("[Anhang]")).toBe(true);
  });

  it("keeps anything somebody typed", () => {
    expect(isAttachmentPlaceholder("Hier das [Bild] von gestern")).toBe(false);
    expect(isAttachmentPlaceholder("Hallo")).toBe(false);
  });
});
