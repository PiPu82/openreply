import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    message: { findUnique: vi.fn() },
    messageAttachment: { upsert: vi.fn() },
    contactAvatar: { upsert: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import {
  fetchMedia,
  isAllowedMimeType,
  storeAttachment,
  MAX_MEDIA_BYTES,
} from "@/lib/inbox/media";
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
  headers.set("content-type", options.contentType ?? "image/jpeg");
  headers.set("content-length", options.contentLength ?? String(bytes));
  // A real ReadableStream, because the reader is what enforces the size cap.
  let remaining = bytes;
  return {
    status: options.ok === false ? 404 : 200,
    ok: options.ok ?? true,
    headers: { get: (k: string) => headers.get(k) ?? null },
    body: {
      getReader: () => ({
        read: async () => {
          if (remaining <= 0) return { done: true, value: undefined };
          const chunk = new Uint8Array(Math.min(remaining, 1024));
          remaining -= chunk.byteLength;
          return { done: false, value: chunk };
        },
        cancel: async () => {},
      }),
    },
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

    const media = await fetchMedia("https://cdn/x.jpg", "image");

    expect(media?.byteSize).toBe(12);
    expect(media?.mimeType).toBe("image/jpeg");
  });

  it("drops the charset off the content type", async () => {
    fetchMock.mockResolvedValue(
      response({ contentType: "image/jpeg; charset=binary" })
    );

    expect((await fetchMedia("https://cdn/x", "image"))?.mimeType).toBe("image/jpeg");
  });

  it("gives up on an expired link instead of throwing", async () => {
    // The ordinary outcome for a backfill or a slow retry: the message keeps
    // its placeholder and nothing fails.
    fetchMock.mockResolvedValue(response({ ok: false }));

    expect(await fetchMedia("https://cdn/gone", "image")).toBeNull();
  });

  it("refuses a file over the limit before downloading it", async () => {
    fetchMock.mockResolvedValue(
      response({
        contentType: "video/mp4",
        contentLength: String(MAX_MEDIA_BYTES + 1),
      })
    );

    expect(await fetchMedia("https://cdn/huge.mp4", "video")).toBeNull();
  });

  it("refuses an oversized body that declared no length", async () => {
    // A missing or lying content-length is why the body is measured as well.
    fetchMock.mockResolvedValue(
      response({
        contentType: "video/mp4",
        bytes: MAX_MEDIA_BYTES + 1,
        contentLength: "0",
      })
    );

    expect(await fetchMedia("https://cdn/huge.mp4", "video")).toBeNull();
  });

  it("refuses an empty body", async () => {
    fetchMock.mockResolvedValue(response({ bytes: 0 }));

    expect(await fetchMedia("https://cdn/empty", "image")).toBeNull();
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

describe("what may be stored and served", () => {
  /**
   * The file arrives from a stranger and is later served back from the origin
   * the dashboard session lives on. A type the browser executes is a script
   * running as the logged-in user, so the type is decided by an allowlist and
   * never by the sender.
   */
  it("refuses SVG for a picture", () => {
    // An SVG is a document that may carry <script>, not an image.
    expect(isAllowedMimeType("image", "image/svg+xml")).toBe(false);
  });

  it("refuses HTML dressed as a picture", () => {
    expect(isAllowedMimeType("image", "text/html")).toBe(false);
    expect(isAllowedMimeType("image", "application/xhtml+xml")).toBe(false);
  });

  it("refuses an unknown type rather than guessing", () => {
    expect(isAllowedMimeType("image", "application/octet-stream")).toBe(false);
    expect(isAllowedMimeType("file", "application/pdf")).toBe(false);
  });

  it("allows the real media types", () => {
    expect(isAllowedMimeType("image", "image/jpeg")).toBe(true);
    expect(isAllowedMimeType("video", "video/mp4")).toBe(true);
    expect(isAllowedMimeType("audio", "audio/mpeg")).toBe(true);
  });

  it("will not let a video type through as a picture", () => {
    expect(isAllowedMimeType("image", "video/mp4")).toBe(false);
  });

  it("does not download a file whose type it would refuse", async () => {
    fetchMock.mockResolvedValue(response({ contentType: "image/svg+xml" }));

    expect(await fetchMedia("https://cdn/evil.svg", "image")).toBeNull();
  });

  it("refuses a non-https url", async () => {
    // Depth behind the webhook signature: nothing here should reach a local
    // address or an unencrypted hop.
    expect(await fetchMedia("http://169.254.169.254/latest/meta-data", "image"))
      .toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a url that is not one", async () => {
    expect(await fetchMedia("not a url", "image")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("where a download may be sent", () => {
  /**
   * The url arrives inside a signature-verified webhook, so this is depth
   * rather than the only line. But a fetch-by-url is worth attacking precisely
   * because of where it runs: the worker sits on the same network as Postgres,
   * Redis and the droplet's metadata service.
   */
  function redirectTo(location: string) {
    return {
      status: 302,
      ok: false,
      headers: { get: (k: string) => (k === "location" ? location : null) },
    };
  }

  it("does not follow a redirect off https", async () => {
    fetchMock.mockResolvedValueOnce(redirectTo("http://example.com/x.jpg"));

    expect(await fetchMedia("https://cdn/x.jpg", "image")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not follow a redirect to the metadata service", async () => {
    fetchMock.mockResolvedValueOnce(
      redirectTo("https://169.254.169.254/latest/meta-data")
    );

    expect(await fetchMedia("https://cdn/x.jpg", "image")).toBeNull();
  });

  it("does not follow a redirect onto the private network", async () => {
    // Where Postgres and Redis actually live.
    for (const target of [
      "https://127.0.0.1/x",
      "https://10.0.0.5/x",
      "https://172.20.0.3:3000/x",
      "https://192.168.1.10/x",
      "https://localhost/x",
    ]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(redirectTo(target));
      expect(await fetchMedia("https://cdn/x.jpg", "image")).toBeNull();
    }
  });

  it("follows an ordinary redirect between CDN hosts", async () => {
    fetchMock
      .mockResolvedValueOnce(redirectTo("https://scontent.cdninstagram.com/x.jpg"))
      .mockResolvedValueOnce(response({ contentType: "image/jpeg", bytes: 8 }));

    const media = await fetchMedia("https://lookaside.fbsbx.com/x.jpg", "image");

    expect(media?.byteSize).toBe(8);
  });

  it("gives up rather than looping forever", async () => {
    fetchMock.mockResolvedValue(redirectTo("https://cdn/again.jpg"));

    expect(await fetchMedia("https://cdn/x.jpg", "image")).toBeNull();
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(5);
  });
});
