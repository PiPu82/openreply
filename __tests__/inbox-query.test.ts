/**
 * Inbox filtering — unit tests.
 *
 * The tricky part is that automation filters cannot be expressed as a relation:
 * DmLog identifies people by Instagram id with no foreign key to Conversation,
 * so those filters resolve to a contact-id set first. These tests pin down that
 * translation, and the two filters whose meaning is easy to get subtly wrong —
 * a date range, and "no automation".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    dmLog: { findMany: vi.fn() },
    automation: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { buildInboxQuery } from "../lib/inbox/query";

const WS = "ws_1";
const ACCOUNT = "acct_1";

function conditions(where: Record<string, unknown>) {
  return (where.AND ?? []) as Array<Record<string, unknown>>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.dmLog.findMany.mockResolvedValue([
    { commenterId: "contact_a" },
    { commenterId: "contact_b" },
  ]);
});

describe("buildInboxQuery", () => {
  it("scopes to the workspace and account even with no filters", async () => {
    const { where } = await buildInboxQuery(WS, ACCOUNT, {});

    expect(conditions(where)[0]).toEqual({
      workspaceId: WS,
      instagramAccountId: ACCOUNT,
    });
    // No automation filter means no DmLog lookup at all.
    expect(mockPrisma.dmLog.findMany).not.toHaveBeenCalled();
  });

  it("searches handles, ids and message bodies together", async () => {
    const { where } = await buildInboxQuery(WS, ACCOUNT, { q: "  strom " });

    const or = conditions(where).find((c) => c.OR)?.OR as Array<
      Record<string, unknown>
    >;
    expect(or).toHaveLength(3);
    expect(or[0]).toEqual({
      contactUsername: { contains: "strom", mode: "insensitive" },
    });
    expect(or[2]).toEqual({
      messages: { some: { text: { contains: "strom", mode: "insensitive" } } },
    });
  });

  it("matches threads with activity in the period, not just their last message", async () => {
    // A thread that was busy last week and again today belongs in last week's
    // results too — filtering on lastMessageAt would hide it.
    const from = new Date("2026-08-01T00:00:00Z");
    const to = new Date("2026-08-07T23:59:59Z");

    const { where } = await buildInboxQuery(WS, ACCOUNT, { from, to });

    expect(conditions(where)).toContainEqual({
      messages: { some: { sentAt: { gte: from, lte: to } } },
    });
  });

  it("treats 'awaiting reply' as: they spoke last", async () => {
    const { where } = await buildInboxQuery(WS, ACCOUNT, {
      state: "awaiting_reply",
    });

    expect(conditions(where)).toContainEqual({ lastMessageFromMe: false });
  });

  it("inverts the contact set for 'no automation'", async () => {
    // "Wrote in by themselves" is everyone no automation ever reached, so the
    // same lookup is used and negated.
    const { where } = await buildInboxQuery(WS, ACCOUNT, {
      automationId: "none",
    });

    expect(conditions(where)).toContainEqual({
      contactId: { notIn: ["contact_a", "contact_b"] },
    });
  });

  it("restricts to one automation's contacts", async () => {
    const { where } = await buildInboxQuery(WS, ACCOUNT, {
      automationId: "auto_1",
    });

    expect(mockPrisma.dmLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { automationId: "auto_1" } })
    );
    expect(conditions(where)).toContainEqual({
      contactId: { in: ["contact_a", "contact_b"] },
    });
  });

  it("finds contacts whose DM was refused", async () => {
    const { where } = await buildInboxQuery(WS, ACCOUNT, {
      state: "dm_failed",
    });

    expect(mockPrisma.dmLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "FAILED" } })
    );
    expect(conditions(where)).toContainEqual({
      contactId: { in: ["contact_a", "contact_b"] },
    });
  });

  it("keeps an empty result meaningful", async () => {
    // No contact matched is not the same as no filter: the inbox must come back
    // empty rather than unfiltered.
    mockPrisma.dmLog.findMany.mockResolvedValue([]);

    const { where } = await buildInboxQuery(WS, ACCOUNT, {
      automationId: "auto_1",
    });

    expect(conditions(where)).toContainEqual({ contactId: { in: [] } });
  });

  it("finds threads whose reply sits in Instagram's requests folder", async () => {
    // Instagram exposes no field for the folder. What puts a message there is
    // the account not following the sender, so that is what gets matched — and
    // only once they have actually written.
    const { where } = await buildInboxQuery(WS, ACCOUNT, {
      state: "in_requests",
    });

    expect(conditions(where)).toContainEqual({ weFollowContact: false });
    expect(conditions(where)).toContainEqual({
      messages: { some: { fromMe: false } },
    });
  });

  it("finds contacts who follow the account", async () => {
    const { where } = await buildInboxQuery(WS, ACCOUNT, {
      state: "follows_us",
    });

    expect(conditions(where)).toContainEqual({ contactFollowsUs: true });
    // Follow filters say nothing about automations, so no DmLog lookup.
    expect(mockPrisma.dmLog.findMany).not.toHaveBeenCalled();
  });

  it("requires a sent message before calling a thread unread", async () => {
    // Without that, threads where nothing was ever sent would count as
    // "delivered but unread".
    const { where } = await buildInboxQuery(WS, ACCOUNT, {
      state: "delivered_unread",
    });

    expect(conditions(where)).toContainEqual({
      messages: { some: { fromMe: true } },
    });
    expect(conditions(where)).toContainEqual({
      messages: { none: { fromMe: true, readAt: { not: null } } },
    });
  });
});
