import { createHmac, timingSafeEqual } from "crypto";
import { ATTACHMENT_PLACEHOLDERS } from "@/lib/inbox/placeholders";

export function verifyWebhookSignature(
  payload: string,
  signature: string | null
): boolean {
  if (!signature) return false;

  // Instagram-Login apps sign webhooks with the Instagram app secret, while
  // Facebook-Login apps use the Facebook app secret. Both belong to the same
  // app, so accept a signature that matches either — this avoids a config
  // guess about which key Meta uses for a given app type.
  const secrets = [
    process.env.FACEBOOK_APP_SECRET,
    process.env.INSTAGRAM_APP_SECRET,
  ].filter((s): s is string => Boolean(s));

  if (secrets.length === 0) {
    throw new Error(
      "FACEBOOK_APP_SECRET or INSTAGRAM_APP_SECRET is required to verify webhooks"
    );
  }

  return secrets.some((secret) => {
    const expected =
      "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
    try {
      return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  });
}

export interface WebhookCommentEvent {
  instagramAccountId: string;
  commentId: string;
  commentText: string;
  commenterId: string;
  commenterName?: string;
  mediaId: string;
}

interface WebhookEntry {
  id: string;
  time: number;
  changes?: Array<{
    field: string;
    value: {
      id?: string;
      comment_id?: string;
      text?: string;
      from?: {
        id?: string;
        username?: string;
      };
      media?: {
        id?: string;
      };
      media_id?: string;
    };
  }>;
  messaging?: Array<{
    sender?: { id?: string };
    recipient?: { id?: string };
    postback?: { mid?: string; title?: string; payload?: string };
    // Instagram reports the last message seen by id. `watermark` is the
    // Messenger shape and does not appear on Instagram payloads — kept only
    // because Meta documents both under the same event name.
    read?: { mid?: string; watermark?: number; seq?: number };
    timestamp?: number;
    message?: {
      mid?: string;
      text?: string;
      is_echo?: boolean;
      is_deleted?: boolean;
      is_unsupported?: boolean;
      // Note this is not the shape the Conversations API returns for the same
      // message: webhooks nest the template under payload.generic.elements,
      // the Graph API exposes it as attachments.data[].generic_template. Two
      // extractors are needed because of it.
      attachments?: Array<{
        type?: string;
        payload?: {
          url?: string;
          generic?: {
            elements?: Array<{
              title?: string;
              subtitle?: string;
              buttons?: Array<{ type?: string; title?: string; url?: string }>;
            }>;
          };
        };
      }>;
    };
  }>;
}

export interface WebhookMessageEvent {
  instagramAccountId: string;
  messageId: string;
  messageText: string;
  senderId: string;
}

export interface WebhookPostbackEvent {
  instagramAccountId: string;
  userId: string;
  payload: string;
  mid?: string;
  /// The button's caption as the person saw it. The payload cannot stand in
  /// for it: with a follow gate the opening button and the "I'm following"
  /// button both carry `followcheck:<id>`, so the title is the only thing
  /// that says which of the two was tapped.
  title?: string;
}

export interface WebhookReadEvent {
  instagramAccountId: string;
  userId: string;
  /// Id of the last message the person has seen — what Instagram actually sends.
  mid?: string;
  /// Messenger-style timestamp. Never populated by Instagram in practice.
  watermark?: number;
}

interface WebhookPayload {
  object: string;
  entry: WebhookEntry[];
}

export function parseCommentEvents(payload: WebhookPayload): WebhookCommentEvent[] {
  const events: WebhookCommentEvent[] = [];

  if (payload.object !== "instagram") {
    return events;
  }

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "comments") continue;

      const value = change.value;
      const commentId = value?.id ?? value?.comment_id;
      const mediaId = value?.media?.id ?? value?.media_id;
      const commenterId = value?.from?.id;

      if (!entry.id || !commentId || !mediaId || !commenterId) {
        continue;
      }

      // Skip the connected account's own comments and comment replies.
      // A private reply to yourself is rejected by Meta, so queueing one
      // only produces a failed log and wasted retries.
      if (commenterId === entry.id) {
        continue;
      }

      events.push({
        instagramAccountId: entry.id,
        commentId,
        commentText: value.text ?? "",
        commenterId,
        commenterName: value.from?.username,
        mediaId,
      });
    }
  }

  return events;
}

/**
 * Parse button-tap postbacks (from an opening DM's button) out of a webhook
 * payload. Each event carries the tapping user's IGSID and our postback payload.
 */
export function parsePostbackEvents(
  payload: WebhookPayload
): WebhookPostbackEvent[] {
  const events: WebhookPostbackEvent[] = [];

  if (payload.object !== "instagram") return events;

  for (const entry of payload.entry ?? []) {
    for (const messaging of entry.messaging ?? []) {
      const postbackPayload = messaging.postback?.payload;
      const userId = messaging.sender?.id;
      const accountId = entry.id ?? messaging.recipient?.id;

      if (!postbackPayload || !userId || !accountId) continue;
      // Ignore echoes of the account's own actions.
      if (userId === accountId) continue;

      events.push({
        instagramAccountId: accountId,
        userId,
        payload: postbackPayload,
        mid: messaging.postback?.mid,
        title: messaging.postback?.title,
      });
    }
  }

  return events;
}

/**
 * Parse inbound Instagram DMs out of a webhook payload. These drive the
 * keyword-triggered autoreply: a user messages the account, and a campaign
 * with `dmTriggerEnabled` whose keywords match the text replies to them.
 *
 * Echoes (messages the account itself sent, including our own autoreplies),
 * deletions, and attachment-only messages with no text are dropped here so
 * the worker never sees them — an echo would otherwise let an autoreply
 * containing its own keyword trigger itself.
 */
export function parseMessageEvents(
  payload: WebhookPayload
): WebhookMessageEvent[] {
  const events: WebhookMessageEvent[] = [];

  if (payload.object !== "instagram") return events;

  for (const entry of payload.entry ?? []) {
    for (const messaging of entry.messaging ?? []) {
      const message = messaging.message;
      if (!message) continue;
      if (message.is_echo || message.is_deleted || message.is_unsupported) {
        continue;
      }

      const text = message.text?.trim();
      const messageId = message.mid;
      const senderId = messaging.sender?.id;
      const accountId = entry.id ?? messaging.recipient?.id;

      if (!text || !messageId || !senderId || !accountId) continue;
      // Ignore anything the connected account sent to itself.
      if (senderId === accountId) continue;

      events.push({
        instagramAccountId: accountId,
        messageId,
        messageText: text,
        senderId,
      });
    }
  }

  return events;
}

/**
 * Parse Instagram DM read receipts. When a user reads an opening DM but does
 * not tap its button, the webhook route uses this to schedule the reveal after
 * a short grace period.
 */
export function parseReadEvents(payload: WebhookPayload): WebhookReadEvent[] {
  const events: WebhookReadEvent[] = [];

  if (payload.object !== "instagram") return events;

  for (const entry of payload.entry ?? []) {
    for (const messaging of entry.messaging ?? []) {
      if (!messaging.read) continue;

      const userId = messaging.sender?.id;
      const accountId = entry.id ?? messaging.recipient?.id;

      if (!userId || !accountId) continue;
      if (userId === accountId) continue;

      events.push({
        instagramAccountId: accountId,
        userId,
        mid: messaging.read.mid,
        watermark: messaging.read.watermark,
      });
    }
  }

  return events;
}

/// A single message in a DM thread, either direction, as delivered by webhook.
export interface WebhookThreadMessage {
  /// IGSID of the connected account (webhook entry id).
  instagramAccountId: string;
  /// IGSID of the other person — the id the send API takes as recipient.
  contactId: string;
  mid: string;
  fromMe: boolean;
  text: string;
  sentAt: Date;
  /// The media file that came with the message, where there was one. The URL
  /// is good for minutes, not for storage — whoever takes this has to fetch
  /// the bytes now. `text` still carries the placeholder, so a thread reads
  /// the same whether or not the download worked.
  attachment?: WebhookAttachment;
}

export interface WebhookAttachment {
  /// Meta's type: image, video, audio, file, share, ig_reel.
  type: string;
  url: string;
}

/// Attachment types worth downloading. `share` and `story_mention` point at
/// somebody else's post rather than a file the sender attached, and their
/// links die with the story — the placeholder says more than a broken frame.
const FETCHABLE_ATTACHMENT_TYPES = new Set(["image", "video", "audio", "file"]);

/**
 * The media file on a webhook message, if it carries one worth keeping.
 *
 * Deliberately blind to `payload.generic`: that shape is one of our own
 * template DMs coming back as an echo — a title and a button, no file. Treating
 * it as an attachment would try to download the button's target.
 */
export function webhookAttachment(message: {
  attachments?: Array<{
    type?: string;
    payload?: { url?: string; generic?: unknown };
  }>;
}): WebhookAttachment | undefined {
  for (const attachment of message.attachments ?? []) {
    const type = attachment.type;
    const url = attachment.payload?.url;
    if (!type || !url) continue;
    if (attachment.payload?.generic) continue;
    if (!FETCHABLE_ATTACHMENT_TYPES.has(type)) continue;
    return { type, url };
  }
  return undefined;
}

/// Marks a tapped button in a thread, in the same spirit as the attachment
/// placeholders below: what arrived was not typed, and reading it as if it
/// were would misrepresent the exchange.
export const BUTTON_TAP_PREFIX = "[Button] ";

/**
 * Readable text for a webhook message, mirroring what the inbox shows for the
 * same message fetched from the Graph API: plain text when there is any, the
 * template title plus its button for our own automated DMs, and a placeholder
 * for media so an image never renders as an empty row.
 *
 * Where the button is a link, its target is included — that target is the
 * tracked short link, so the thread shows exactly which URL a given person
 * received.
 */
export function webhookMessageText(message: {
  text?: string;
  is_deleted?: boolean;
  is_unsupported?: boolean;
  attachments?: Array<{
    type?: string;
    payload?: {
      url?: string;
      generic?: {
        elements?: Array<{
          title?: string;
          subtitle?: string;
          buttons?: Array<{ type?: string; title?: string; url?: string }>;
        }>;
      };
    };
  }>;
}): string {
  const text = message.text?.trim();
  if (text) return text;

  const attachment = message.attachments?.[0];
  if (!attachment) {
    // Recorded rather than skipped: a gap in the thread is harder to make
    // sense of later than a message whose content Meta would not hand over.
    return message.is_unsupported ? "[Nicht unterstützte Nachricht]" : "[Anhang]";
  }

  const element = attachment.payload?.generic?.elements?.[0];
  if (element) {
    const button = element.buttons?.[0];
    const target = button?.type === "web_url" && button.url ? ` → ${button.url}` : "";
    return [
      element.title,
      element.subtitle,
      button?.title ? `[${button.title}]${target}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  return ATTACHMENT_PLACEHOLDERS[attachment.type ?? ""] ?? "[Anhang]";
}

/**
 * Message ids Meta reports as deleted.
 *
 * When someone unsends a message, Meta delivers `{ mid, is_deleted: true }` —
 * the id and nothing else, no text. The message itself has to be looked up
 * locally and removed; there is nothing in the event to store.
 */
export function parseDeletedMessageIds(payload: WebhookPayload): string[] {
  const ids: string[] = [];

  if (payload.object !== "instagram") return ids;

  for (const entry of payload.entry ?? []) {
    for (const messaging of entry.messaging ?? []) {
      const message = messaging.message;
      if (message?.is_deleted && message.mid) ids.push(message.mid);
    }
  }

  return ids;
}

/**
 * Parse every DM in a webhook payload — inbound and outbound alike.
 *
 * Unlike parseMessageEvents, which feeds keyword autoreplies and therefore
 * has to drop echoes, this keeps them: Meta echoes back everything the account
 * sends, including messages typed in the Instagram app itself, so echoes are
 * exactly what makes a locally stored thread complete rather than half of a
 * conversation.
 *
 * Deletions are skipped here because the event carries no content to store;
 * they are handled by parseDeletedMessageIds, which removes the message that
 * was already saved.
 */
export function parseThreadMessageEvents(
  payload: WebhookPayload
): WebhookThreadMessage[] {
  const events: WebhookThreadMessage[] = [];

  if (payload.object !== "instagram") return events;

  for (const entry of payload.entry ?? []) {
    for (const messaging of entry.messaging ?? []) {
      // A button tap is an action, but Meta files it as a message from the
      // person — same id, and the Conversations API returns it with the
      // button's caption as its text. Keeping it here is what makes a thread
      // read the way it happened: their tap, then our answer. Without it the
      // thread shows only our side, and someone who stopped at the follow
      // gate looks like they never responded at all.
      const postback = messaging.postback;
      if (postback?.mid && postback.title) {
        const tapper = messaging.sender?.id;
        const account = entry.id;
        if (tapper && account && tapper !== account) {
          events.push({
            instagramAccountId: account,
            contactId: tapper,
            mid: postback.mid,
            fromMe: false,
            text: `${BUTTON_TAP_PREFIX}${postback.title}`,
            sentAt: webhookDate(messaging.timestamp ?? entry.time),
          });
        }
        continue;
      }

      const message = messaging.message;
      if (!message || message.is_deleted) continue;

      const mid = message.mid;
      const senderId = messaging.sender?.id;
      const recipientId = messaging.recipient?.id;
      const accountId = entry.id;

      if (!mid || !senderId || !recipientId || !accountId) continue;

      // is_echo is authoritative; the sender comparison covers payloads that
      // omit the flag.
      const fromMe = message.is_echo === true || senderId === accountId;
      const contactId = fromMe ? recipientId : senderId;

      // A thread with the account itself is not a conversation.
      if (contactId === accountId) continue;

      events.push({
        instagramAccountId: accountId,
        contactId,
        mid,
        fromMe,
        text: webhookMessageText(message),
        sentAt: webhookDate(messaging.timestamp ?? entry.time),
        attachment: webhookAttachment(message),
      });
    }
  }

  return events;
}

/**
 * Turn a webhook timestamp into a date.
 *
 * Meta is not consistent about the unit: `messaging[].timestamp` and the
 * `entry.time` beside it are milliseconds, while the `entry.time` on a comment
 * delivery is seconds. Read as milliseconds, a comment lands in January 1970.
 *
 * Anything below 1e11 is seconds — that boundary is the year 5138 in seconds
 * and 1973 in milliseconds, so no real timestamp is ambiguous.
 */
function webhookDate(value: number | undefined): Date {
  if (!value) return new Date();
  return new Date(value < 1e11 ? value * 1000 : value);
}

/// One thing a person did, as read from a webhook delivery.
export interface WebhookInteraction {
  instagramAccountId: string;
  contactId: string;
  contactUsername?: string;
  kind: "comment" | "dm" | "button_tap";
  /// Comment id, message id, or postback id — whatever identifies this one
  /// event, so replays cannot count it twice.
  externalId: string;
  at: Date;
}

/**
 * Every interaction in a payload: comments, inbound DMs, button taps.
 *
 * Reads the payload directly instead of combining the other parsers, because
 * those drop the timestamps — parseCommentEvents and parsePostbackEvents are
 * built for reacting to an event now, where the time is simply "now". A ranking
 * over a period needs when it happened.
 *
 * The account's own actions are skipped throughout: our public replies are
 * comments too, and would otherwise top every ranking.
 */
export function parseInteractionEvents(
  payload: WebhookPayload
): WebhookInteraction[] {
  const events: WebhookInteraction[] = [];

  if (payload.object !== "instagram") return events;

  for (const entry of payload.entry ?? []) {
    const accountId = entry.id;
    if (!accountId) continue;

    // Comments — including those that match no campaign, which is most of the
    // point: engagement is not limited to the people a funnel caught.
    for (const change of entry.changes ?? []) {
      if (change.field !== "comments") continue;
      const value = change.value;
      const commentId = value?.id ?? value?.comment_id;
      const commenterId = value?.from?.id;
      if (!commentId || !commenterId || commenterId === accountId) continue;

      events.push({
        instagramAccountId: accountId,
        contactId: commenterId,
        contactUsername: value.from?.username,
        kind: "comment",
        externalId: commentId,
        at: webhookDate(entry.time),
      });
    }

    for (const messaging of entry.messaging ?? []) {
      const at = webhookDate(messaging.timestamp ?? entry.time);

      const postback = messaging.postback;
      const senderId = messaging.sender?.id;
      if (postback?.payload && senderId && senderId !== accountId) {
        events.push({
          instagramAccountId: accountId,
          contactId: senderId,
          kind: "button_tap",
          // Falls back to sender plus payload where Meta sends no id; a repeat
          // tap on the same button then counts once, which is the fairer
          // reading anyway.
          externalId: postback.mid ?? `tap_${senderId}_${postback.payload}`,
          at,
        });
        continue;
      }

      const message = messaging.message;
      if (!message?.mid) continue;
      // Echoes are the account's own messages; deletions are not an action to
      // credit someone for.
      if (message.is_echo || message.is_deleted) continue;
      if (!senderId || senderId === accountId) continue;

      events.push({
        instagramAccountId: accountId,
        contactId: senderId,
        kind: "dm",
        externalId: message.mid,
        at,
      });
    }
  }

  return events;
}
