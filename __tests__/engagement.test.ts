/**
 * Engagement recording — unit tests.
 *
 * The ranking is only as trustworthy as what feeds it, so these pin down what
 * counts and what does not: the account's own comments must never appear (our
 * public replies are comments too, and there are hundreds of them), and a
 * redelivered event must not count twice.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseInteractionEvents } from "../lib/meta/webhook";

const ACCOUNT = "17841480535369396";
const CONTACT = "1415193703837239";

function payload(entry: Record<string, unknown>) {
  return {
    object: "instagram",
    entry: [{ id: ACCOUNT, time: 1787232106599, ...entry }],
  } as Parameters<typeof parseInteractionEvents>[0];
}

describe("parseInteractionEvents", () => {
  it("counts a comment, with the handle it carries", () => {
    const events = parseInteractionEvents(
      payload({
        changes: [
          {
            field: "comments",
            value: {
              id: "comment_1",
              text: "Strom",
              from: { id: CONTACT, username: "renatefab" },
              media: { id: "media_1" },
            },
          },
        ],
      })
    );

    expect(events).toEqual([
      expect.objectContaining({
        contactId: CONTACT,
        contactUsername: "renatefab",
        kind: "comment",
        externalId: "comment_1",
      }),
    ]);
  });

  it("ignores the account's own comments", () => {
    // Every public reply the funnel sends is a comment on our own post. Counted,
    // the account would top its own ranking by several hundred points.
    const events = parseInteractionEvents(
      payload({
        changes: [
          {
            field: "comments",
            value: {
              id: "comment_own",
              text: "Hab dir eine DM geschickt!",
              from: { id: ACCOUNT, username: "dievermieterente" },
              media: { id: "media_1" },
            },
          },
        ],
      })
    );

    expect(events).toEqual([]);
  });

  it("counts an inbound DM but not our own echo", () => {
    const events = parseInteractionEvents(
      payload({
        messaging: [
          {
            sender: { id: CONTACT },
            recipient: { id: ACCOUNT },
            timestamp: 1787232105654,
            message: { mid: "mid_in", text: "Danke!" },
          },
          {
            sender: { id: ACCOUNT },
            recipient: { id: CONTACT },
            timestamp: 1787232105999,
            message: { mid: "mid_out", is_echo: true, text: "Gern!" },
          },
        ],
      })
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "dm", externalId: "mid_in" });
  });

  it("counts a button tap and dates it from the event", () => {
    const events = parseInteractionEvents(
      payload({
        messaging: [
          {
            sender: { id: CONTACT },
            recipient: { id: ACCOUNT },
            timestamp: 1787232105654,
            postback: { mid: "mid_tap", payload: "reveal:auto_1" },
          },
        ],
      })
    );

    expect(events[0]).toMatchObject({
      kind: "button_tap",
      externalId: "mid_tap",
    });
    expect(events[0].at.toISOString()).toBe(
      new Date(1787232105654).toISOString()
    );
  });

  it("falls back to a derived id when a tap carries none", () => {
    // Without a stable id a repeat tap would be a new row every time.
    const events = parseInteractionEvents(
      payload({
        messaging: [
          {
            sender: { id: CONTACT },
            recipient: { id: ACCOUNT },
            postback: { payload: "followcheck:auto_1" },
          },
        ],
      })
    );

    expect(events[0].externalId).toBe(
      `tap_${CONTACT}_followcheck:auto_1`
    );
  });

  it("does not count a deleted message", () => {
    const events = parseInteractionEvents(
      payload({
        messaging: [
          {
            sender: { id: CONTACT },
            recipient: { id: ACCOUNT },
            message: { mid: "mid_gone", is_deleted: true },
          },
        ],
      })
    );

    expect(events).toEqual([]);
  });
});

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    instagramAccount: { findMany: vi.fn() },
    interaction: { createMany: vi.fn() },
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

const { recordInteractions, toInteractionInputs } = await import(
  "../lib/engagement/store"
);

describe("recordInteractions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.instagramAccount.findMany.mockResolvedValue([
      { id: "acct_1", workspaceId: "ws_1", instagramId: ACCOUNT },
    ]);
    mockPrisma.interaction.createMany.mockResolvedValue({ count: 1 });
  });

  it("skips duplicates, because Meta redelivers and the backfill replays", async () => {
    const stored = await recordInteractions(
      toInteractionInputs([
        {
          instagramAccountId: ACCOUNT,
          contactId: CONTACT,
          contactUsername: "renatefab",
          kind: "comment",
          externalId: "comment_1",
          at: new Date("2026-08-21T08:00:00Z"),
        },
      ])
    );

    expect(stored).toBe(1);
    expect(mockPrisma.interaction.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true })
    );
    expect(mockPrisma.interaction.createMany.mock.calls[0][0].data[0]).toMatchObject(
      { workspaceId: "ws_1", type: "COMMENT" }
    );
  });

  it("drops events for an account this instance does not manage", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([]);

    const stored = await recordInteractions(
      toInteractionInputs([
        {
          instagramAccountId: "someone_else",
          contactId: CONTACT,
          kind: "comment",
          externalId: "comment_2",
          at: new Date(),
        },
      ])
    );

    expect(stored).toBe(0);
    expect(mockPrisma.interaction.createMany).not.toHaveBeenCalled();
  });
});
