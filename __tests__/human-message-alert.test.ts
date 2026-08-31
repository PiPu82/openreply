import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma, mockRedisSet } = vi.hoisted(() => ({
  mockPrisma: { conversation: { findFirst: vi.fn() } },
  mockRedisSet: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: () => ({ set: mockRedisSet }),
}));

import {
  alertHumanMessage,
  buildAlert,
  threadLink,
} from "@/lib/ops/human-message-alert";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TELEGRAM_BOT_TOKEN = "bot-token";
  process.env.TELEGRAM_INBOX_CHAT_ID = "-1001234567890";
  mockRedisSet.mockResolvedValue("OK");
  mockPrisma.conversation.findFirst.mockResolvedValue({
    contactUsername: "max_mustermann",
  });
  fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "" });
  vi.stubGlobal("fetch", fetchMock);
});

describe("threadLink", () => {
  it("points at the conversation with that person", () => {
    // ig.me is Meta's own "message me" link and opens the existing thread in
    // the app. Instagram's internal thread ids are not exposed by the Graph
    // API, so the handle is the only way to link into a conversation.
    expect(threadLink("max_mustermann")).toBe("https://ig.me/m/max_mustermann");
  });
});

describe("buildAlert", () => {
  it("carries the handle, the words and the way in", () => {
    const alert = buildAlert({
      username: "max_mustermann",
      contactId: "igsid_1",
      text: "Hallo, wie rechne ich den Allgemeinstrom ab?",
    });

    expect(alert).toContain("@max_mustermann");
    expect(alert).toContain("Allgemeinstrom");
    expect(alert).toContain("https://ig.me/m/max_mustermann");
  });

  it("says so instead of linking nowhere when the handle is missing", () => {
    const alert = buildAlert({
      username: null,
      contactId: "igsid_1",
      text: "Hallo",
    });

    expect(alert).not.toContain("ig.me");
    expect(alert).toContain("igsid_1");
  });

  it("escapes markup so a message cannot break the alert", () => {
    // parse_mode HTML: an unescaped "<" makes Telegram reject the whole send,
    // which would silently lose the very message we are announcing.
    const alert = buildAlert({
      username: "a<b",
      contactId: "igsid_1",
      text: "1 < 2 & 3 > 2",
    });

    expect(alert).toContain("1 &lt; 2 &amp; 3 &gt; 2");
    expect(alert).not.toContain("a<b</b>");
  });

  it("trims a very long message", () => {
    const alert = buildAlert({
      username: "max",
      contactId: "igsid_1",
      text: "x".repeat(900),
    });

    expect(alert).toContain("…");
    expect(alert.length).toBeLessThan(900);
  });
});

describe("alertHumanMessage", () => {
  const message = {
    instagramAccountId: "ig_456",
    senderId: "igsid_1",
    text: "Kurze Frage zur Nebenkostenabrechnung",
  };

  it("sends to the configured group", async () => {
    await alertHumanMessage(message);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/botbot-token/sendMessage");
    const body = JSON.parse(init.body);
    expect(body.chat_id).toBe("-1001234567890");
    expect(body.text).toContain("Nebenkostenabrechnung");
  });

  it("stays quiet for a burst from the same person", async () => {
    // Three sentences in a row are one person needing an answer, not three.
    mockRedisSet.mockResolvedValue(null);

    await alertHumanMessage(message);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when Telegram is not configured", async () => {
    delete process.env.TELEGRAM_INBOX_CHAT_ID;

    await alertHumanMessage(message);

    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("swallows a Telegram outage", async () => {
    // The alert rides on top of storing the message; it must never fail the job.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "bot was kicked from the group chat",
    });

    await expect(alertHumanMessage(message)).resolves.toBeUndefined();
  });
});
