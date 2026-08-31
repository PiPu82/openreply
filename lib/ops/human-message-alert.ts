import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "@/lib/queue/client";

/**
 * Tells a human that a human wrote.
 *
 * The funnel produces roughly fourteen automated events for every real
 * message: in one week, 287 threads saw activity and 20 of them carried a
 * sentence somebody actually typed. Instagram's own inbox cannot separate the
 * two — Meta exposes no folder, label or flag on a conversation (`folder`,
 * `unread_count` and `can_reply` are accepted as field names and come back
 * empty) — so the real messages drown in the bot's wake.
 *
 * Nothing can fix that inside the Instagram app. This pushes the handful of
 * genuine messages out to a place where they cannot be missed instead.
 */

/**
 * One alert per contact per window. Somebody typing three sentences in a row
 * is one person needing an answer, not three.
 */
const COOLDOWN_SECONDS = 15 * 60;

/** Telegram rejects messages over 4096 characters; leave room for the frame. */
const MAX_QUOTE = 500;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * A link that opens the conversation itself.
 *
 * `ig.me/m/<handle>` is Meta's own "message me" link and lands in the existing
 * thread with that person, in the app on a phone. Instagram's internal thread
 * ids — the only thing a deeper link could use — are not exposed by the Graph
 * API at all, so the handle is the way in. Every stored conversation has one.
 */
export function threadLink(username: string): string {
  return `https://ig.me/m/${encodeURIComponent(username)}`;
}

export function buildAlert(params: {
  username: string | null;
  contactId: string;
  text: string;
}): string {
  const { username, contactId, text } = params;
  const quote = text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE)}…` : text;
  const who = username ? `@${escapeHtml(username)}` : `Kontakt ${contactId}`;

  const lines = [
    `💬 <b>Neue Nachricht von ${who}</b>`,
    "",
    `<i>${escapeHtml(quote)}</i>`,
  ];

  // Without a handle there is no way in: Meta gives no link for a raw contact
  // id. Say so, rather than offering a link that goes nowhere.
  if (username) {
    lines.push("", `<a href="${threadLink(username)}">In Instagram öffnen</a>`);
  } else {
    lines.push("", "⚠️ Kein Benutzername bekannt — im Posteingang suchen.");
  }

  return lines.join("\n");
}

/**
 * Send to the shared group. Silent no-op when unconfigured, so a workspace
 * without Telegram set up behaves exactly as before.
 */
async function send(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_INBOX_CHAT_ID;
  if (!token || !chatId) return;

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        // The preview would be a fat Instagram card under every alert.
        disable_web_page_preview: true,
      }),
    }
  );

  if (!response.ok) {
    // Telegram's own body says why (bot removed from the group, wrong chat id).
    const body = await response.text().catch(() => "");
    throw new Error(`Telegram ${response.status}: ${body.slice(0, 200)}`);
  }
}

/**
 * Announce a message no automation answered.
 *
 * Never throws: an alert is a courtesy on top of the funnel, and a Telegram
 * outage must not fail the job that stores the message.
 */
export async function alertHumanMessage(params: {
  instagramAccountId: string;
  senderId: string;
  text: string;
}): Promise<void> {
  const { instagramAccountId, senderId, text } = params;

  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_INBOX_CHAT_ID) {
    return;
  }

  try {
    // SET NX doubles as the cooldown: the first message in the window claims
    // the key, the rest find it taken.
    const claimed = await getRedisConnection().set(
      `inbox-alert:${instagramAccountId}:${senderId}`,
      "1",
      "EX",
      COOLDOWN_SECONDS,
      "NX"
    );
    if (claimed !== "OK") return;

    const conversation = await prisma.conversation.findFirst({
      where: { contactId: senderId },
      select: { contactUsername: true },
    });

    await send(
      buildAlert({
        username: conversation?.contactUsername ?? null,
        contactId: senderId,
        text,
      })
    );
  } catch (error) {
    console.error("[inbox-alert] could not announce message", error);
  }
}
