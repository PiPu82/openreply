/**
 * Local conversation store.
 *
 * The inbox used to read every thread live from Meta's Conversations API,
 * which takes 5–9 seconds for the list and over a second per thread. Since
 * Meta already pushes every message to the webhook — inbound, and outbound as
 * an echo — the same data can simply be kept, and the inbox served from it.
 *
 * The Graph API stays the reference for repairs (see ./sync), but it is no
 * longer on the path a person waits for.
 */

import { prisma } from "@/lib/db/client";
import type { WebhookThreadMessage } from "@/lib/meta/webhook";

type AccountRef = { id: string; workspaceId: string };

/**
 * Resolve an IGSID (what webhooks carry) to the internal account row.
 * Cached per call site rather than globally: a stale mapping here would file
 * messages under the wrong workspace.
 */
async function resolveAccounts(
  igsids: string[]
): Promise<Map<string, AccountRef>> {
  const rows = await prisma.instagramAccount.findMany({
    where: { instagramId: { in: Array.from(new Set(igsids)) } },
    select: { id: true, workspaceId: true, instagramId: true },
  });
  return new Map(
    rows.map((r) => [r.instagramId, { id: r.id, workspaceId: r.workspaceId }])
  );
}

/**
 * Best-effort username for a contact we have only an id for. Webhooks never
 * carry one, but anyone who arrived through a comment is already in the DM log
 * under their handle — worth reusing, so the inbox shows a name right away
 * instead of waiting for the next Graph sync.
 */
async function usernameFromDmLog(contactId: string): Promise<string | null> {
  const log = await prisma.dmLog.findFirst({
    where: { commenterId: contactId, commenterName: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { commenterName: true },
  });
  return log?.commenterName ?? null;
}

export interface RecordResult {
  stored: number;
  conversations: number;
}

/**
 * Store webhook-delivered messages, creating threads as needed.
 *
 * Idempotent: message ids are unique, so a redelivered webhook, a backfill and
 * the Graph sync can all write the same message without duplicating it. That
 * matters because Meta redelivers on any non-200, and the backfill replays
 * payloads that were already processed live.
 */
export async function recordThreadMessages(
  events: WebhookThreadMessage[],
  source: "WEBHOOK" | "BACKFILL" = "WEBHOOK"
): Promise<RecordResult> {
  if (events.length === 0) return { stored: 0, conversations: 0 };

  const accounts = await resolveAccounts(
    events.map((e) => e.instagramAccountId)
  );

  let stored = 0;
  const touched = new Set<string>();

  for (const event of events) {
    const account = accounts.get(event.instagramAccountId);
    // A message for an account this instance does not manage. Nothing to file
    // it under, and inventing a workspace would leak it into the wrong one.
    if (!account) continue;

    const conversation = await prisma.conversation.upsert({
      where: {
        instagramAccountId_contactId: {
          instagramAccountId: account.id,
          contactId: event.contactId,
        },
      },
      create: {
        workspaceId: account.workspaceId,
        instagramAccountId: account.id,
        contactId: event.contactId,
        contactUsername: await usernameFromDmLog(event.contactId),
      },
      update: {},
      select: { id: true, lastMessageAt: true, contactUsername: true },
    });
    touched.add(conversation.id);

    const created = await prisma.message.createMany({
      data: [
        {
          conversationId: conversation.id,
          workspaceId: account.workspaceId,
          mid: event.mid,
          fromMe: event.fromMe,
          text: event.text,
          sentAt: event.sentAt,
          source,
        },
      ],
      skipDuplicates: true,
    });
    stored += created.count;

    // Only move the thread's summary forward. Backfills and repairs replay old
    // messages, and those must not reorder the inbox or overwrite the preview
    // with something older than what is already there.
    const isNewer =
      !conversation.lastMessageAt || event.sentAt > conversation.lastMessageAt;
    if (created.count > 0 && isNewer) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageAt: event.sentAt,
          lastMessageText: event.text,
          lastMessageFromMe: event.fromMe,
        },
      });
    }

    if (!conversation.contactUsername) {
      const username = await usernameFromDmLog(event.contactId);
      if (username) {
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { contactUsername: username },
        });
      }
    }
  }

  return { stored, conversations: touched.size };
}

/**
 * Apply a read receipt.
 *
 * Meta reports reads as a watermark — a moment up to which everything has been
 * seen — not as individual message ids, so this marks every unread outgoing
 * message sent at or before it.
 */
export async function applyReadReceipt(
  instagramAccountIgsid: string,
  contactId: string,
  watermark: number | undefined
): Promise<number> {
  if (!watermark) return 0;

  const accounts = await resolveAccounts([instagramAccountIgsid]);
  const account = accounts.get(instagramAccountIgsid);
  if (!account) return 0;

  const conversation = await prisma.conversation.findUnique({
    where: {
      instagramAccountId_contactId: {
        instagramAccountId: account.id,
        contactId,
      },
    },
    select: { id: true },
  });
  if (!conversation) return 0;

  const readAt = new Date(watermark);
  const result = await prisma.message.updateMany({
    where: {
      conversationId: conversation.id,
      fromMe: true,
      readAt: null,
      sentAt: { lte: readAt },
    },
    data: { readAt },
  });
  return result.count;
}
