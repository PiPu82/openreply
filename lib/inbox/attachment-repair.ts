import { prisma } from "@/lib/db/client";
import { getConversationMessages, graphMessageMedia } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { fetchMedia, storeAttachment } from "@/lib/inbox/media";
import { kindFromPlaceholder } from "@/lib/inbox/placeholders";

/**
 * Fetch the files whose webhook moment was missed.
 *
 * The live path downloads an attachment while the webhook is still warm,
 * because Meta's link expires. When that does not happen — the delivery was
 * lost, the worker was down, the retries outlived the url — the message keeps
 * its "[Bild]" placeholder and the file is gone from that route for good.
 *
 * The Conversations API is the second way in: it signs its urls at the moment
 * of the call, so a message Meta still returns can still give up its file. It
 * returns only the last 20 messages of a thread, so this is a repair with a
 * horizon, not a guarantee — which is exactly why it does not replace
 * downloading on delivery.
 */

/** Messages to repair per run. Two Graph calls each, so kept small. */
const REPAIRS_PER_RUN = 25;

export interface RepairResult {
  /** Messages found still missing their file. */
  candidates: number;
  /** Files recovered and stored. */
  repaired: number;
}

export async function repairAttachments(account: {
  id: string;
  workspaceId: string;
  accessToken: string;
}): Promise<RepairResult> {
  const token = decryptToken(account.accessToken);

  // A placeholder with no stored file is the whole signal: the message says a
  // file was there, and we do not have it.
  const candidates = await prisma.message.findMany({
    where: {
      workspaceId: account.workspaceId,
      attachment: { is: null },
      conversation: {
        instagramAccountId: account.id,
        // Without Meta's own id for the thread there is nothing to ask.
        metaConversationId: { not: null },
      },
    },
    orderBy: { sentAt: "desc" },
    take: REPAIRS_PER_RUN,
    select: {
      id: true,
      mid: true,
      text: true,
      conversation: { select: { id: true, metaConversationId: true } },
    },
  });

  const wanted = candidates.filter(
    (m) => m.mid && kindFromPlaceholder(m.text) !== null
  );
  if (wanted.length === 0) {
    return { candidates: 0, repaired: 0 };
  }

  // One fetch per thread, not per message: two files in the same conversation
  // arrive in the same response.
  const byThread = new Map<string, typeof wanted>();
  for (const message of wanted) {
    const key = message.conversation.metaConversationId!;
    const entry = byThread.get(key);
    if (entry) entry.push(message);
    else byThread.set(key, [message]);
  }

  let repaired = 0;

  for (const [metaConversationId, messages] of byThread) {
    let remote: Awaited<ReturnType<typeof getConversationMessages>>;
    try {
      remote = await getConversationMessages(token, metaConversationId);
    } catch (error) {
      console.error("[attachment-repair] thread fetch failed", metaConversationId, error);
      continue;
    }

    const byMid = new Map(remote.map((m) => [m.id, m]));

    for (const message of messages) {
      // Beyond Meta's twenty-message window, or deleted since.
      const match = byMid.get(message.mid!);
      if (!match) continue;

      const media = graphMessageMedia(match);
      if (!media) continue;

      // What the message says it was beats Meta's hint: a voice note comes
      // back under file_url, which on its own reads as a document.
      const kind = kindFromPlaceholder(message.text) ?? media.type;

      try {
        const fetched = await fetchMedia(media.url, kind);
        if (!fetched) continue;
        const stored = await storeAttachment({
          mid: message.mid!,
          type: kind,
          media: fetched,
        });
        if (stored) repaired += 1;
      } catch (error) {
        console.error("[attachment-repair] download failed", message.mid, error);
      }
    }
  }

  return { candidates: wanted.length, repaired };
}
