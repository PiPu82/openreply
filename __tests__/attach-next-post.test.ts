import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma, mockGetUserMedia, mockDecryptToken } = vi.hoisted(() => ({
  mockPrisma: {
    automation: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
  mockGetUserMedia: vi.fn(),
  mockDecryptToken: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/meta/client", () => ({ getUserMedia: mockGetUserMedia }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: mockDecryptToken }));

import { attachPendingCampaigns } from "@/lib/campaigns/attach-next-post";

const ACCOUNT = {
  id: "acct_1",
  instagramId: "17841400000000000",
  accessToken: "encrypted",
};

/** A campaign created at noon, waiting for whatever gets posted next. */
function pendingCampaign(overrides: Record<string, unknown> = {}) {
  return {
    id: "camp_1",
    instagramAccountId: ACCOUNT.id,
    createdAt: new Date("2026-08-30T12:00:00Z"),
    instagramAccount: ACCOUNT,
    ...overrides,
  };
}

function media(
  id: string,
  timestamp: string,
  productType: string,
  permalink = `https://instagram.com/p/${id}`
) {
  return {
    id,
    media_type: productType === "REELS" ? "VIDEO" : "IMAGE",
    media_product_type: productType,
    timestamp,
    permalink,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDecryptToken.mockReturnValue("plain-token");
  mockPrisma.automation.update.mockResolvedValue({});
});

describe("attachPendingCampaigns", () => {
  it("binds a plain feed post, not only reels", async () => {
    // The regression this module was extracted for: the old cron filtered on
    // media_product_type === "REELS", so a carousel or photo post left the
    // campaign waiting forever while the UI promised "the next post or reel".
    mockPrisma.automation.findMany.mockResolvedValue([pendingCampaign()]);
    mockGetUserMedia.mockResolvedValue([
      media("m_feed", "2026-08-30T14:00:00Z", "FEED"),
    ]);

    const result = await attachPendingCampaigns();

    expect(result.bound).toBe(1);
    expect(mockPrisma.automation.update).toHaveBeenCalledWith({
      where: { id: "camp_1" },
      data: {
        postId: "m_feed",
        postUrl: "https://instagram.com/p/m_feed",
        pendingNextReel: false,
      },
    });
  });

  it("still binds reels", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([pendingCampaign()]);
    mockGetUserMedia.mockResolvedValue([
      media("m_reel", "2026-08-30T14:00:00Z", "REELS"),
    ]);

    const result = await attachPendingCampaigns();

    expect(result.bound).toBe(1);
    expect(mockPrisma.automation.update.mock.calls[0][0].data.postId).toBe(
      "m_reel"
    );
  });

  it("never binds to a story", async () => {
    // A story carries no comments: binding would spend the campaign's single
    // "next post" slot on something that can never trigger it.
    mockPrisma.automation.findMany.mockResolvedValue([pendingCampaign()]);
    mockGetUserMedia.mockResolvedValue([
      media("m_story", "2026-08-30T14:00:00Z", "STORY"),
    ]);

    const result = await attachPendingCampaigns();

    expect(result.bound).toBe(0);
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it("picks the earliest post after the campaign, not the newest", async () => {
    // Two posts went out before this ran. The campaign belongs to the first
    // one — that is the post the creator made it for.
    mockPrisma.automation.findMany.mockResolvedValue([pendingCampaign()]);
    mockGetUserMedia.mockResolvedValue([
      media("m_late", "2026-08-31T09:00:00Z", "FEED"),
      media("m_first", "2026-08-30T14:00:00Z", "FEED"),
    ]);

    await attachPendingCampaigns();

    expect(mockPrisma.automation.update.mock.calls[0][0].data.postId).toBe(
      "m_first"
    );
  });

  it("ignores posts published before the campaign was created", async () => {
    // Someone commenting under an old post must not drag the campaign onto it.
    mockPrisma.automation.findMany.mockResolvedValue([pendingCampaign()]);
    mockGetUserMedia.mockResolvedValue([
      media("m_old", "2026-08-29T08:00:00Z", "FEED"),
    ]);

    const result = await attachPendingCampaigns();

    expect(result.checked).toBe(1);
    expect(result.bound).toBe(0);
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it("costs no Graph call when nothing is waiting", async () => {
    // This runs on every comment and on a one-minute timer; the idle path has
    // to stay free, or it eats the same rate budget the funnel sends from.
    mockPrisma.automation.findMany.mockResolvedValue([]);

    const result = await attachPendingCampaigns();

    expect(mockGetUserMedia).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 0, bound: 0, failedAccounts: [] });
  });

  it("limits the query to one account when scoped", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);

    await attachPendingCampaigns({ instagramId: ACCOUNT.instagramId });

    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          pendingNextReel: true,
          instagramAccount: { instagramId: ACCOUNT.instagramId },
        },
      })
    );
  });

  it("reports a failed media fetch instead of throwing", async () => {
    // The comment path calls this before matching; a Meta hiccup must not take
    // the comment down with it.
    mockPrisma.automation.findMany.mockResolvedValue([pendingCampaign()]);
    mockGetUserMedia.mockRejectedValue(new Error("Meta 190: token expired"));

    const result = await attachPendingCampaigns();

    expect(result.failedAccounts).toEqual([ACCOUNT.id]);
    expect(result.bound).toBe(0);
  });

  it("fetches media once for two campaigns on the same account", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      pendingCampaign({ id: "camp_1" }),
      pendingCampaign({ id: "camp_2" }),
    ]);
    mockGetUserMedia.mockResolvedValue([
      media("m_feed", "2026-08-30T14:00:00Z", "FEED"),
    ]);

    const result = await attachPendingCampaigns();

    expect(mockGetUserMedia).toHaveBeenCalledTimes(1);
    expect(result.bound).toBe(2);
  });
});
