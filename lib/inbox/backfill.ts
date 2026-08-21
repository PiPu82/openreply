/**
 * Rebuild threads from webhook payloads already on disk.
 *
 * Every delivery is kept verbatim in WebhookEvent, so the history from the day
 * webhooks started flowing can be reconstructed without asking Meta for
 * anything — which matters, because the Conversations API only returns the 20
 * most recent messages per thread.
 *
 * Safe to run repeatedly: message ids are unique and read receipts only ever
 * move a message from unread to read.
 */

import { prisma } from "@/lib/db/client";
import {
  parseDeletedMessageIds,
  parseInteractionEvents,
  parseReadEvents,
  parseThreadMessageEvents,
} from "@/lib/meta/webhook";
import {
  applyReadReceipt,
  recordThreadMessages,
  removeDeletedMessages,
} from "./store";
import { recordInteractions, toInteractionInputs } from "@/lib/engagement/store";

export interface BackfillResult {
  events: number;
  stored: number;
  conversations: number;
  receipts: number;
  deleted: number;
  interactions: number;
}

export async function backfillInboxFromWebhookEvents(
  batchSize = 200
): Promise<BackfillResult> {
  const result: BackfillResult = {
    events: 0,
    stored: 0,
    conversations: 0,
    receipts: 0,
    deleted: 0,
    interactions: 0,
  };

  let cursor: string | undefined;

  for (;;) {
    const events = await prisma.webhookEvent.findMany({
      where: { object: "instagram" },
      // Oldest first, so a thread is rebuilt in the order it happened and its
      // summary ends up on the genuinely newest message.
      orderBy: { createdAt: "asc" },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, payload: true },
    });

    if (events.length === 0) break;
    cursor = events[events.length - 1].id;

    for (const event of events) {
      result.events += 1;
      // Stored payloads are typed as arbitrary JSON; the parsers already
      // check the shape and ignore anything that does not match.
      const payload = event.payload as unknown as Parameters<
        typeof parseThreadMessageEvents
      >[0];

      const stored = await recordThreadMessages(
        parseThreadMessageEvents(payload),
        "BACKFILL"
      );
      result.stored += stored.stored;
      result.conversations += stored.conversations;

      // The engagement ranking reaches back as far as the stored payloads do,
      // rather than starting the day it was built.
      result.interactions += await recordInteractions(
        toInteractionInputs(parseInteractionEvents(payload))
      );

      // Replayed in order, so a message stored by an earlier payload is
      // removed again when its deletion comes up.
      result.deleted += await removeDeletedMessages(
        parseDeletedMessageIds(payload)
      );

      for (const read of parseReadEvents(payload)) {
        result.receipts += await applyReadReceipt(
          read.instagramAccountId,
          read.userId,
          { mid: read.mid, watermark: read.watermark }
        );
      }
    }
  }

  return result;
}
