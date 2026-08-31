import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockPrisma,
  mockGetConversationMessages,
  mockDecryptToken,
  mockFetchMedia,
  mockStoreAttachment,
} = vi.hoisted(() => ({
  mockPrisma: { message: { findMany: vi.fn(), updateMany: vi.fn() } },
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
    attachmentTries: 0,
    conversation: { id: "conv_1", metaConversationId: "meta_conv_1" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDecryptToken.mockReturnValue("token");
  mockStoreAttachment.mockResolvedValue(true);
  mockPrisma.message.updateMany.mockResolvedValue({ count: 1 });
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

    expect(result).toEqual({ candidates: 1, repaired: 1, gaveUp: 0 });
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

    expect(result).toEqual({ candidates: 1, repaired: 0, gaveUp: 0 });
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

    expect(result).toEqual({ candidates: 0, repaired: 0, gaveUp: 0 });
    expect(mockGetConversationMessages).not.toHaveBeenCalled();
  });

  it("carries on when one thread cannot be fetched", async () => {
    mockPrisma.message.findMany.mockResolvedValue([candidate()]);
    mockGetConversationMessages.mockRejectedValue(new Error("Meta 100"));

    await expect(repairAttachments(account)).resolves.toEqual({
      candidates: 1,
      repaired: 0,
      gaveUp: 0,
    });
  });
});

describe("repairAttachments — what it asks the database for", () => {
  it("narrows to placeholders in the query, not afterwards", async () => {
    /**
     * The bug this exists to stop: the placeholder filter sat after `take`, so
     * the query fetched the newest messages that merely lacked an attachment —
     * which is nearly all of them — and the page it got back contained no
     * placeholders. The repair then reported success having looked at nothing.
     */
    mockPrisma.message.findMany.mockResolvedValue([]);

    await repairAttachments(account);

    const [args] = mockPrisma.message.findMany.mock.calls[0];
    expect(args.where.text?.in).toEqual(
      expect.arrayContaining(["[Bild]", "[Sprachnachricht]", "[Video]"])
    );
    // And a message with no id of Meta's cannot be looked up at all.
    expect(args.where.mid).toEqual({ not: null });
  });
});

describe("repairAttachments — when to stop asking", () => {
  /**
   * Nearly everything the repair cannot fetch, it will never fetch: the
   * message has slipped past Meta's twenty-message window, or the file was
   * never one Meta hands back. Run hourly without a limit, those few rows
   * would be re-asked for the rest of the system's life, a Graph call each.
   */
  it("counts a try before fetching, so failures also consume one", async () => {
    // The rows that keep failing are exactly the rows that must stop being
    // asked — counting afterwards would exempt them.
    mockPrisma.message.findMany.mockResolvedValue([candidate()]);
    mockGetConversationMessages.mockRejectedValue(new Error("Meta 100"));

    await repairAttachments(account);

    expect(mockPrisma.message.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["msg_1"] } },
      data: { attachmentTries: { increment: 1 } },
    });
  });

  it("stops asking for a message that has used up its tries", async () => {
    mockPrisma.message.findMany.mockResolvedValue([]);

    await repairAttachments(account);

    const [args] = mockPrisma.message.findMany.mock.calls[0];
    expect(args.where.attachmentTries).toEqual({ lt: 5 });
  });

  it("reports the ones it just gave up on", async () => {
    mockPrisma.message.findMany.mockResolvedValue([
      candidate({ attachmentTries: 4 }),
    ]);
    mockGetConversationMessages.mockResolvedValue([{ id: "other" }]);

    const result = await repairAttachments(account);

    expect(result.gaveUp).toBe(1);
  });

  it("never asks for a shared post or a reel", async () => {
    // Those point at somebody else's post, there is no player for them, and
    // the call could only ever come back with nothing.
    mockPrisma.message.findMany.mockResolvedValue([]);

    await repairAttachments(account);

    const [args] = mockPrisma.message.findMany.mock.calls[0];
    expect(args.where.text.in).toContain("[Bild]");
    expect(args.where.text.in).toContain("[Sprachnachricht]");
    expect(args.where.text.in).not.toContain("[Reel]");
    expect(args.where.text.in).not.toContain("[Geteilter Beitrag]");
  });
});
