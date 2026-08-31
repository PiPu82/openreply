/**
 * Conversation sync — unit tests.
 *
 * Focused on the follow-status pass, because its failure mode is expensive
 * rather than visible: the sync runs whenever someone opens the inbox, so a
 * thread that never records an attempt would be re-fetched from Meta every few
 * minutes for as long as it exists.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockPrisma,
  mockGetConversations,
  mockGetConversationMessages,
  mockGetContactProfile,
  mockDecryptToken,
  mockFetchMedia,
  mockStoreAvatar,
} = vi.hoisted(() => ({
  mockFetchMedia: vi.fn(),
  mockStoreAvatar: vi.fn(),
  mockPrisma: {
    conversation: {
      upsert: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
    message: { createMany: vi.fn(), findFirst: vi.fn() },
  },
  mockGetConversations: vi.fn(),
  mockGetConversationMessages: vi.fn(),
  mockGetContactProfile: vi.fn(),
  mockDecryptToken: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/meta/client", () => ({
  getConversations: mockGetConversations,
  getConversationMessages: mockGetConversationMessages,
  getContactProfile: mockGetContactProfile,
  messagePreviewText: (m: { message?: string }) => m.message ?? "",
  messageDetailText: (m: { message?: string }) => m.message ?? "",
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: mockDecryptToken }));
vi.mock("@/lib/inbox/media", () => ({
  fetchMedia: mockFetchMedia,
  storeAvatar: mockStoreAvatar,
  AVATAR_MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000,
}));

import { syncAccountConversations } from "../lib/inbox/sync";

const account = {
  id: "acct_1",
  workspaceId: "ws_1",
  instagramId: "17841480535369396",
  accessToken: "encrypted",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDecryptToken.mockReturnValue("token");
  // No threads from Meta: this exercises the follow-status pass on its own.
  mockGetConversations.mockResolvedValue([]);
  mockPrisma.conversation.update.mockResolvedValue({});
  mockPrisma.conversation.findMany.mockResolvedValue([
    {
      id: "conv_1",
      workspaceId: "ws_1",
      contactId: "contact_1",
      contactUsername: null,
    },
  ]);
  mockFetchMedia.mockResolvedValue(null);
  mockStoreAvatar.mockResolvedValue(undefined);
});

describe("syncAccountConversations — follow status", () => {
  it("fills in the handle that webhooks never carry", async () => {
    mockGetContactProfile.mockResolvedValue({
      contactFollowsUs: true,
      weFollowContact: false,
      username: "renatefab",
    });

    const result = await syncAccountConversations(account);

    expect(result.followChecks).toBe(1);
    expect(mockPrisma.conversation.update).toHaveBeenCalledWith({
      where: { id: "conv_1" },
      data: expect.objectContaining({
        contactFollowsUs: true,
        weFollowContact: false,
        contactUsername: "renatefab",
      }),
    });
  });

  it("records the attempt even when Meta refuses the profile", async () => {
    // Contacts who never opened a conversation answer `code 230` every time.
    // Without a timestamp those threads would be retried on every sync, and the
    // sync runs whenever the inbox is opened.
    mockGetContactProfile.mockResolvedValue({
      contactFollowsUs: null,
      weFollowContact: null,
      username: null,
    });

    await syncAccountConversations(account);

    const call = mockPrisma.conversation.update.mock.calls[0][0];
    expect(call.data.followStatusAt).toBeInstanceOf(Date);
    // Nothing was learned, so nothing is overwritten with a null.
    expect(call.data).not.toHaveProperty("contactFollowsUs");
    expect(call.data).not.toHaveProperty("contactUsername");
  });

  it("does not overwrite a handle it already has", async () => {
    mockPrisma.conversation.findMany.mockResolvedValue([
      { id: "conv_1", contactId: "contact_1", contactUsername: "renatefab" },
    ]);
    mockGetContactProfile.mockResolvedValue({
      contactFollowsUs: true,
      weFollowContact: true,
      username: "changed_handle",
    });

    await syncAccountConversations(account);

    const call = mockPrisma.conversation.update.mock.calls[0][0];
    expect(call.data).not.toHaveProperty("contactUsername");
  });

  it("asks for threads that are unread-of or nameless, and only stale ones", async () => {
    mockGetContactProfile.mockResolvedValue({
      contactFollowsUs: true,
      weFollowContact: true,
      username: null,
    });

    await syncAccountConversations(account);

    const where = mockPrisma.conversation.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { messages: { some: { fromMe: false } } },
      { contactUsername: null },
    ]);
    expect(where.AND[0].OR[0]).toEqual({ followStatusAt: null });
  });
});

describe("syncAccountConversations — profile pictures", () => {
  /**
   * Its own pass, because the follow-status pass asks a different question:
   * that one only looks at threads somebody wrote in, and only once its answer
   * has gone stale. Gated behind it, avatars reached none of the existing
   * threads at all — the first run after they shipped fetched exactly zero.
   */
  it("fetches and stores the picture Instagram hands over", async () => {
    mockGetContactProfile.mockResolvedValue({
      contactFollowsUs: null,
      weFollowContact: null,
      username: null,
      profilePicUrl: "https://cdn/pic.jpg",
    });
    mockFetchMedia.mockResolvedValue({
      data: new Uint8Array([1]),
      mimeType: "image/jpeg",
      byteSize: 1,
    });

    await syncAccountConversations(account);

    expect(mockFetchMedia).toHaveBeenCalledWith("https://cdn/pic.jpg", "image");
    expect(mockStoreAvatar).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv_1", workspaceId: "ws_1" })
    );
  });

  it("stamps the attempt even when there is no picture", async () => {
    // Otherwise a contact Instagram has none for comes back on every single
    // run, forever — the sync fires whenever somebody opens the inbox.
    mockGetContactProfile.mockResolvedValue({
      contactFollowsUs: null,
      weFollowContact: null,
      username: null,
      profilePicUrl: null,
    });

    await syncAccountConversations(account);

    expect(mockPrisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ avatarCheckedAt: expect.any(Date) }),
      })
    );
    expect(mockStoreAvatar).not.toHaveBeenCalled();
  });

  it("asks only for threads without a recent attempt", async () => {
    mockGetContactProfile.mockResolvedValue({
      contactFollowsUs: null,
      weFollowContact: null,
      username: null,
      profilePicUrl: null,
    });

    await syncAccountConversations(account);

    const avatarQuery = mockPrisma.conversation.findMany.mock.calls
      .map(([args]) => args)
      .find((args) => JSON.stringify(args?.where).includes("avatarCheckedAt"));

    expect(avatarQuery).toBeDefined();
    // Capped like every other lookup here: the local store exists so the inbox
    // stops spending hundreds of Graph calls an hour.
    expect(avatarQuery.take).toBeLessThanOrEqual(50);
  });
});
