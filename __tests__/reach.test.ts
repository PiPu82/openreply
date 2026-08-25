/**
 * Starting a campaign by hand only works while Meta's messaging window is
 * open. Getting this line wrong is not a cosmetic bug: too generous and the
 * send fails at Meta with the contact none the wiser, too strict and someone
 * reachable is refused.
 */
import { describe, expect, it, vi } from "vitest";
import { lastInboundAt, reachState } from "@/lib/inbox/reach";

const NOW = new Date("2026-08-25T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);

describe("reachState", () => {
  it("is open within 24 hours of their last action", () => {
    expect(reachState(hoursAgo(0.5), NOW)).toBe("open");
    expect(reachState(hoursAgo(23.9), NOW)).toBe("open");
  });

  it("needs the human-agent tag from 24 hours to 7 days", () => {
    expect(reachState(hoursAgo(24), NOW)).toBe("human_agent");
    expect(reachState(hoursAgo(24 * 7 - 0.1), NOW)).toBe("human_agent");
  });

  it("is closed after 7 days", () => {
    expect(reachState(hoursAgo(24 * 7), NOW)).toBe("closed");
    expect(reachState(hoursAgo(24 * 30), NOW)).toBe("closed");
  });

  it("is closed when they never wrote", () => {
    expect(reachState(null, NOW)).toBe("closed");
    expect(reachState(undefined, NOW)).toBe("closed");
    expect(reachState("nonsense", NOW)).toBe("closed");
  });

  it("treats a timestamp from the future as active", () => {
    // Clock skew between Meta and us should not lock out a live contact.
    expect(reachState(hoursAgo(-2), NOW)).toBe("open");
  });

  it("accepts an ISO string, which is what the browser holds", () => {
    expect(reachState(hoursAgo(2).toISOString(), NOW)).toBe("open");
  });
});

describe("lastInboundAt", () => {
  const theirs = (createdTime: string) => ({ fromMe: false, createdTime });
  const ours = (createdTime: string) => ({ fromMe: true, createdTime });

  it("takes their most recent message, ignoring ours", () => {
    expect(
      lastInboundAt([
        theirs("2026-08-25T09:00:00Z"),
        theirs("2026-08-25T10:00:00Z"),
        ours("2026-08-25T11:00:00Z"),
      ])
    ).toBe("2026-08-25T10:00:00Z");
  });

  it("returns null for a thread we only ever talked into", () => {
    // The common case for a campaign that stalled: our opening DM went out and
    // nothing came back.
    expect(lastInboundAt([ours("2026-08-25T09:00:00Z")])).toBeNull();
    expect(lastInboundAt([])).toBeNull();
  });

  it("skips entries without a timestamp", () => {
    expect(
      lastInboundAt([
        theirs("2026-08-25T09:00:00Z"),
        { fromMe: false, createdTime: null },
      ])
    ).toBe("2026-08-25T09:00:00Z");
  });
});

describe("the human-agent tag on the wire", () => {
  async function sendWith(humanAgent: boolean) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ recipient_id: "1", message_id: "m1" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { sendDirectMessageWithButton } = await import("@/lib/meta/client");
    await sendDirectMessageWithButton(
      "token",
      "17841480535369396",
      "1780695719776866",
      "Hey!",
      "Ja, her damit 🦆",
      "followcheck:abc",
      [],
      humanAgent
    );

    return JSON.parse(fetchMock.mock.calls[0][1].body);
  }

  it("tags the message when a person triggered it", () => {
    // Without this Meta refuses anything older than 24 hours.
    return sendWith(true).then((body) => {
      expect(body.messaging_type).toBe("MESSAGE_TAG");
      expect(body.tag).toBe("HUMAN_AGENT");
    });
  });

  it("sends untagged by default", () => {
    // The automated path must never claim a human is behind it.
    return sendWith(false).then((body) => {
      expect(body.messaging_type).toBeUndefined();
      expect(body.tag).toBeUndefined();
    });
  });
});
