import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockPrisma,
  mockGetConversationMessages,
  mockDecryptToken,
  mockFetchMedia,
  mockStoreAttachment,
} = vi.hoisted(() => ({
  mockPrisma: { message: { findMany: vi.fn() } },
  mockGetConversationMessages: vi.fn(),
  mockDecryptToken: vi.fn(),
  mockFetchMedia: vi.fn(),
  mockStoreAttachment: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: mockDecryptToken }));
vi.mock("@/lib/inbox/media", () => ({
  fetchMedia: mockFetchMedia,
  storeAttachment: mockStoreAttachment,
}));

import { graphMessageMedia } from "@/lib/meta/client";
vi.mock("@/lib/meta/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta/client")>();
  return {
    ...actual,
    getConversationMessages: mockGetConversationMessages,
  };
});

import { repairAttachments } from "@/lib/inbox/attachment-repair";

const account = { id: "acct_1", workspaceId: "ws_1", accessToken: "encrypted" };

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_1",
    mid: "mid_1",
    text: "[Bild]",
    conversation: { id: "conv_1", metaConversationId: "meta_conv_1" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDecryptToken.mockReturnValue("token");
  mockStoreAttachment.mockResolvedValue(true);
  mockFetchMedia.mockResolvedValue({
    data: new Uint8Array([1]),
    mimeType: "image/jpeg",
    byteSize: 1,
  });
});

describe("graphMessageMedia", () => {
  it("reads the freshly signed url the Conversations API returns", () => {
    // The whole point of this second route: these urls are signed at the
    // moment of the call, not days ago when the webhook arrived.
    expect(
      graphMessageMedia({
        id: "m",
        attachments: { data: [{ image_data: { url: "https://cdn/fresh.jpg" } }] },
      })
    ).toEqual({ type: "image", url: "https://cdn/fresh.jpg" });
  });

  it("ignores one of our own button DMs", () => {
    expect(
      graphMessageMedia({
        id: "m",
        attachments: { data: [{ generic_template: { title: "Hier ist dein Link" } }] },
      })
    ).toBeNull();
  });

  it("returns nothing when there is no file", () => {
    expect(graphMessageMedia({ id: "m" })).toBeNull();
    expect(graphMessageMedia({ id: "m", attachments: { data: [{}] } })).toBeNull();
  });
});

describe("repairAttachments", () => {
  it("recovers a file the live download missed", async () => {
    mockPrisma.message.findMany.mockResolvedValue([candidate()]);
    mockGetConversationMessages.mockResolvedValue([
      { id: "mid_1", attachments: { data: [{ image_data: { url: "https://cdn/a.jpg" } }] } },
    ]);

    const result = await repairAttachments(account);

    expect(result).toEqual({ candidates: 1, repaired: 1 });
    expect(mockStoreAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ mid: "mid_1", type: "image" })
    );
  });

  it("trusts the placeholder over Meta's hint for a voice note", async () => {
    // Meta returns a voice note under file_url, which on its own reads as a
    // document — and would then be checked against the wrong allowlist and
    // rendered without a player.
    mockPrisma.message.findMany.mockResolvedValue([
      candidate({ text: "[Sprachnachricht]" }),
    ]);
    mockGetConversationMessages.mockResolvedValue([
      { id: "mid_1", attachments: { data: [{ file_url: "https://cdn/a.m4a" }] } },
    ]);

    await repairAttachments(account);

    expect(mockFetchMedia).toHaveBeenCalledWith("https://cdn/a.m4a", "audio");
    expect(mockStoreAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ type: "audio" })
    );
  });

  it("gives up quietly past Meta's twenty-message window", async () => {
    // The thread no longer returns that message. Nothing to do, and nothing
    // worth failing a cron over.
    mockPrisma.message.findMany.mockResolvedValue([candidate()]);
    mockGetConversationMessages.mockResolvedValue([{ id: "some_other_mid" }]);

    const result = await repairAttachments(account);

    expect(result).toEqual({ candidates: 1, repaired: 0 });
    expect(mockFetchMedia).not.toHaveBeenCalled();
  });

  it("fetches a thread once for two files in it", async () => {
    mockPrisma.message.findMany.mockResolvedValue([
      candidate({ id: "msg_1", mid: "mid_1" }),
      candidate({ id: "msg_2", mid: "mid_2" }),
    ]);
    mockGetConversationMessages.mockResolvedValue([
      { id: "mid_1", attachments: { data: [{ image_data: { url: "https://cdn/1.jpg" } }] } },
      { id: "mid_2", attachments: { data: [{ image_data: { url: "https://cdn/2.jpg" } }] } },
    ]);

    const result = await repairAttachments(account);

    expect(mockGetConversationMessages).toHaveBeenCalledTimes(1);
    expect(result.repaired).toBe(2);
  });

  it("skips a message whose text is not a placeholder", async () => {
    // Somebody typed something; there was never a file to recover.
    mockPrisma.message.findMany.mockResolvedValue([
      candidate({ text: "Hallo, kurze Frage" }),
    ]);

    const result = await repairAttachments(account);

    expect(result).toEqual({ candidates: 0, repaired: 0 });
    expect(mockGetConversationMessages).not.toHaveBeenCalled();
  });

  it("carries on when one thread cannot be fetched", async () => {
    mockPrisma.message.findMany.mockResolvedValue([candidate()]);
    mockGetConversationMessages.mockRejectedValue(new Error("Meta 100"));

    await expect(repairAttachments(account)).resolves.toEqual({
      candidates: 1,
      repaired: 0,
    });
  });
});
