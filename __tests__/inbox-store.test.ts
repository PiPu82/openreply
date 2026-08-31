/**
 * Conversation store — unit tests.
 *
 * Covers the properties the inbox depends on: writing the same message twice
 * must not duplicate it, replaying old messages must not reorder the inbox,
 * and a message for an unknown account must not be filed under some workspace
 * anyway.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma, mockQueueAdd } = vi.hoisted(() => ({
  mockQueueAdd: vi.fn(),
  mockPrisma: {
    instagramAccount: { findMany: vi.fn() },
    dmLog: { findFirst: vi.fn() },
    conversation: { upsert: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    message: {
      createMany: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: mockQueueAdd }),
  ATTACHMENT_JOB_NAME: "process-attachment",
  ATTACHMENT_BACKOFF_MS: 15_000,
}));

import {
  applyReadReceipt,
  recordThreadMessages,
  removeDeletedMessages,
} from "../lib/inbox/store";

const ACCOUNT_IGSID = "17841480535369396";
const CONTACT = "1415193703837239";

function message(overrides: Record<string, unknown> = {}) {
  return {
    instagramAccountId: ACCOUNT_IGSID,
    contactId: CONTACT,
    mid: "mid_1",
    fromMe: false,
    text: "Strom",
    sentAt: new Date("2026-08-20T10:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.instagramAccount.findMany.mockResolvedValue([
    { id: "acct_1", workspaceId: "ws_1", instagramId: ACCOUNT_IGSID },
  ]);
  mockPrisma.dmLog.findFirst.mockResolvedValue({ commenterName: "renatefab" });
  mockPrisma.conversation.upsert.mockResolvedValue({
    id: "conv_1",
    lastMessageAt: null,
    contactUsername: "renatefab",
  });
  mockPrisma.message.createMany.mockResolvedValue({ count: 1 });
  mockPrisma.conversation.update.mockResolvedValue({});
});

describe("recordThreadMessages", () => {
  it("stores the message and moves the thread summary to it", async () => {
    const result = await recordThreadMessages([message()]);

    expect(result).toEqual({ stored: 1, conversations: 1 });
    expect(mockPrisma.conversation.update).toHaveBeenCalledWith({
      where: { id: "conv_1" },
      data: {
        lastMessageAt: new Date("2026-08-20T10:00:00Z"),
        lastMessageText: "Strom",
        lastMessageFromMe: false,
      },
    });
  });

  it("does not reorder the inbox when a backfill replays an older message", async () => {
    // The backfill walks history oldest-first, so it constantly writes messages
    // older than what the live feed already recorded. Letting those through
    // would push finished conversations back to the top of the inbox.
    mockPrisma.conversation.upsert.mockResolvedValue({
      id: "conv_1",
      lastMessageAt: new Date("2026-08-20T12:00:00Z"),
      contactUsername: "renatefab",
    });

    await recordThreadMessages(
      [message({ sentAt: new Date("2026-08-19T09:00:00Z") })],
      "BACKFILL"
    );

    expect(mockPrisma.message.createMany).toHaveBeenCalled();
    expect(mockPrisma.conversation.update).not.toHaveBeenCalled();
  });

  it("leaves the summary alone when the message was already stored", async () => {
    // Meta redelivers on any non-200, and the echo of a message we filed at
    // send time arrives seconds later. Both land here as duplicates.
    mockPrisma.message.createMany.mockResolvedValue({ count: 0 });

    const result = await recordThreadMessages([message()]);

    expect(result.stored).toBe(0);
    expect(mockPrisma.conversation.update).not.toHaveBeenCalled();
  });

  it("ignores messages for an account this instance does not manage", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([]);

    const result = await recordThreadMessages([message()]);

    expect(result).toEqual({ stored: 0, conversations: 0 });
    expect(mockPrisma.conversation.upsert).not.toHaveBeenCalled();
  });
});

describe("applyReadReceipt", () => {
  const SEEN_AT = new Date("2026-08-20T11:00:00Z");

  beforeEach(() => {
    mockPrisma.conversation.findUnique.mockResolvedValue({ id: "conv_1" });
    mockPrisma.message.updateMany.mockResolvedValue({ count: 2 });
    mockPrisma.message.findUnique.mockResolvedValue({ sentAt: SEEN_AT });
  });

  it("marks everything sent up to the message Instagram names as read", async () => {
    // Instagram identifies the last seen message by id — the Messenger-style
    // watermark timestamp is documented but never actually sent. The receipt
    // still means a cut-off, so it resolves to that message's own time.
    const count = await applyReadReceipt(ACCOUNT_IGSID, CONTACT, {
      mid: "mid_seen",
    });

    expect(count).toBe(2);
    expect(mockPrisma.message.findUnique).toHaveBeenCalledWith({
      where: { mid: "mid_seen" },
      select: { sentAt: true },
    });
    expect(mockPrisma.message.updateMany).toHaveBeenCalledWith({
      where: {
        conversationId: "conv_1",
        fromMe: true,
        readAt: null,
        sentAt: { lte: SEEN_AT },
      },
      data: { readAt: SEEN_AT },
    });
  });

  it("still honours a watermark if one ever arrives", async () => {
    const watermark = Date.parse("2026-08-20T12:00:00Z");

    await applyReadReceipt(ACCOUNT_IGSID, CONTACT, { watermark });

    expect(mockPrisma.message.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { readAt: new Date(watermark) } })
    );
  });

  it("ignores a receipt for a message that was never stored", async () => {
    // No stored message means no timestamp, and inventing one would mark
    // unrelated messages as read.
    mockPrisma.message.findUnique.mockResolvedValue(null);

    expect(
      await applyReadReceipt(ACCOUNT_IGSID, CONTACT, { mid: "mid_unknown" })
    ).toBe(0);
    expect(mockPrisma.message.updateMany).not.toHaveBeenCalled();
  });

  it("does nothing for an empty receipt", async () => {
    expect(await applyReadReceipt(ACCOUNT_IGSID, CONTACT, {})).toBe(0);
    expect(mockPrisma.message.updateMany).not.toHaveBeenCalled();
  });

  it("does nothing for a thread that was never stored", async () => {
    mockPrisma.conversation.findUnique.mockResolvedValue(null);

    expect(
      await applyReadReceipt(ACCOUNT_IGSID, CONTACT, { mid: "mid_seen" })
    ).toBe(0);
    expect(mockPrisma.message.updateMany).not.toHaveBeenCalled();
  });
});

describe("removeDeletedMessages", () => {
  beforeEach(() => {
    mockPrisma.message.findMany.mockResolvedValue([
      { id: "msg_1", conversationId: "conv_1" },
    ]);
    mockPrisma.message.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.message.findFirst.mockResolvedValue({
      sentAt: new Date("2026-08-19T10:00:00Z"),
      text: "vorherige Nachricht",
      fromMe: false,
    });
  });

  it("deletes the message and re-points the thread preview at what remains", async () => {
    // Someone unsending a message expects it gone. Leaving the preview quoting
    // it would keep the deleted text visible in the list.
    const count = await removeDeletedMessages(["mid_deleted"]);

    expect(count).toBe(1);
    expect(mockPrisma.message.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["msg_1"] } },
    });
    expect(mockPrisma.conversation.update).toHaveBeenCalledWith({
      where: { id: "conv_1" },
      data: {
        lastMessageAt: new Date("2026-08-19T10:00:00Z"),
        lastMessageText: "vorherige Nachricht",
        lastMessageFromMe: false,
      },
    });
  });

  it("clears the summary when the thread is left empty", async () => {
    // A thread still holding a timestamp would float at the top of the inbox
    // with nothing to show.
    mockPrisma.message.findFirst.mockResolvedValue(null);

    await removeDeletedMessages(["mid_deleted"]);

    expect(mockPrisma.conversation.update).toHaveBeenCalledWith({
      where: { id: "conv_1" },
      data: {
        lastMessageAt: null,
        lastMessageText: null,
        lastMessageFromMe: false,
      },
    });
  });

  it("does nothing for a message that was never stored", async () => {
    mockPrisma.message.findMany.mockResolvedValue([]);

    expect(await removeDeletedMessages(["mid_unknown"])).toBe(0);
    expect(mockPrisma.message.deleteMany).not.toHaveBeenCalled();
  });

  it("does nothing for an empty list", async () => {
    expect(await removeDeletedMessages([])).toBe(0);
    expect(mockPrisma.message.findMany).not.toHaveBeenCalled();
  });
});

describe("recordThreadMessages — media", () => {
  /**
   * Instagram's attachment links are signed and expire, so the file has to be
   * fetched while the webhook is still warm. The store's job is to hand that
   * off, once, for the right messages.
   */
  const withImage = () =>
    message({
      mid: "mid_img",
      text: "[Bild]",
      attachment: { type: "image", url: "https://cdn/x.jpg" },
    });

  beforeEach(() => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([
      { id: "acct_1", instagramId: ACCOUNT_IGSID, workspaceId: "ws_1" },
    ]);
    mockPrisma.conversation.upsert.mockResolvedValue({
      id: "conv_1",
      lastMessageAt: null,
      contactUsername: "someone",
    });
    mockPrisma.message.createMany.mockResolvedValue({ count: 1 });
    mockPrisma.conversation.update.mockResolvedValue({});
  });

  it("queues the download for a live delivery", async () => {
    await recordThreadMessages([withImage()]);

    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-attachment",
      { mid: "mid_img", url: "https://cdn/x.jpg", type: "image" },
      expect.objectContaining({ jobId: "attachment_mid_img" })
    );
  });

  it("does not queue a backfill", async () => {
    // A backfill replays payloads from days ago; those urls died long before,
    // so every job would be a guaranteed miss.
    await recordThreadMessages([withImage()], "BACKFILL");

    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("does not queue a message that was already stored", async () => {
    // Meta redelivers on any non-200. The insert is what says "new".
    mockPrisma.message.createMany.mockResolvedValue({ count: 0 });

    await recordThreadMessages([withImage()]);

    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("queues nothing for a plain text message", async () => {
    await recordThreadMessages([message()]);

    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});
