/**
 * Repair pass against the Conversations API.
 *
 * The webhook feed is the primary source for the inbox, but it has two gaps
 * the store cannot close on its own:
 *
 *   - Anything that happened before this store existed, or while the stack was
 *     down. Meta does not redeliver indefinitely.
 *   - Contact usernames. Webhooks carry ids only, so a thread whose contact
 *     never appeared in the DM log would otherwise show a bare number.
 *
 * Runs on a schedule rather than on page load: it costs several seconds per
 * account, which is precisely the wait the local store exists to avoid.
 *
 * Note this pass only ever adds. Deletions arrive as their own webhook and are
 * applied there; inferring them here — treating anything Meta did not return as
 * deleted — would be unsafe, because Meta returns only the 20 most recent
 * messages per thread. A quiet omission would silently destroy history rather
 * than repair it.
 */

import { prisma } from "@/lib/db/client";
import {
  getContactFollowStatus,
  getConversationMessages,
  getConversations,
  messageDetailText,
  messagePreviewText,
} from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";

export interface SyncResult {
  conversations: number;
  messages: number;
  threadsFetched: number;
  followChecks: number;
}

/** A follow status older than this is refetched; people follow and unfollow. */
const FOLLOW_STATUS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many contacts to check per run.
 *
 * Each check is one Graph call. Kept deliberately small: the whole point of the
 * local store was to stop the inbox spending hundreds of calls an hour, and a
 * background sync that runs whenever someone opens it would undo that in a
 * single afternoon.
 */
const FOLLOW_CHECKS_PER_RUN = 15;

/**
 * Fill in who follows whom, for threads where it matters.
 *
 * Only threads with an inbound message are checked. That is the case where the
 * answer changes what someone does: a reply from a contact the account does not
 * follow sits in Instagram's requests folder, which is where messages get
 * missed. Threads that only ever received our DMs are left alone — nobody is
 * waiting on those, and checking all 380 of them would cost 380 calls.
 */
async function refreshFollowStatus(
  account: { id: string; accessToken: string },
  token: string
): Promise<number> {
  const stale = new Date(Date.now() - FOLLOW_STATUS_MAX_AGE_MS);

  const threads = await prisma.conversation.findMany({
    where: {
      instagramAccountId: account.id,
      messages: { some: { fromMe: false } },
      OR: [{ followStatusAt: null }, { followStatusAt: { lt: stale } }],
    },
    orderBy: { lastMessageAt: "desc" },
    take: FOLLOW_CHECKS_PER_RUN,
    select: { id: true, contactId: true },
  });

  let checked = 0;
  for (const thread of threads) {
    const status = await getContactFollowStatus(token, thread.contactId);
    // A failed lookup returns nulls; stamping the time anyway would mean
    // retrying it on every single run.
    if (status.contactFollowsUs === null && status.weFollowContact === null) {
      continue;
    }

    await prisma.conversation.update({
      where: { id: thread.id },
      data: {
        contactFollowsUs: status.contactFollowsUs,
        weFollowContact: status.weFollowContact,
        followStatusAt: new Date(),
      },
    });
    checked += 1;
  }

  return checked;
}

/**
 * Reconcile one account's threads with Meta.
 *
 * `maxThreadFetches` bounds the expensive half: listing conversations is one
 * call, but pulling a thread's messages is another ~1.3s each. Threads are
 * visited newest-first, so a capped run still repairs what matters most, and
 * the next run continues where this one stopped.
 */
export async function syncAccountConversations(
  account: {
    id: string;
    workspaceId: string;
    instagramId: string;
    accessToken: string;
  },
  maxThreadFetches = 25
): Promise<SyncResult> {
  const token = decryptToken(account.accessToken);
  const remote = await getConversations(token, account.instagramId);

  let conversations = 0;
  let messages = 0;
  let threadsFetched = 0;

  for (const thread of remote) {
    const participants = thread.participants?.data ?? [];
    const contact =
      participants.find((p) => p.id !== account.instagramId) ?? participants[0];
    if (!contact?.id) continue;

    const preview = thread.messages?.data?.[0] ?? null;
    const previewAt = preview?.created_time
      ? new Date(preview.created_time)
      : null;

    const stored = await prisma.conversation.upsert({
      where: {
        instagramAccountId_contactId: {
          instagramAccountId: account.id,
          contactId: contact.id,
        },
      },
      create: {
        workspaceId: account.workspaceId,
        instagramAccountId: account.id,
        contactId: contact.id,
        contactUsername: contact.username ?? null,
        metaConversationId: thread.id,
        lastMessageAt: previewAt,
        lastMessageText: preview ? messagePreviewText(preview) : null,
        lastMessageFromMe: preview?.from?.id === account.instagramId,
      },
      update: {
        // The username and Meta's own id are the two things only this path can
        // supply, so they are always refreshed. The thread summary is not: the
        // webhook feed is more current than a periodic sync, and overwriting it
        // here would make the inbox jump backwards.
        contactUsername: contact.username ?? undefined,
        metaConversationId: thread.id,
      },
      select: { id: true, lastMessageAt: true },
    });
    conversations += 1;

    // Only pull the full thread when Meta knows something newer than we do.
    const behind =
      !stored.lastMessageAt ||
      (previewAt !== null && previewAt > stored.lastMessageAt);
    if (!behind || threadsFetched >= maxThreadFetches) continue;

    threadsFetched += 1;
    const remoteMessages = await getConversationMessages(token, thread.id);

    const rows = remoteMessages
      .filter((m) => m.id)
      .map((m) => ({
        conversationId: stored.id,
        workspaceId: account.workspaceId,
        mid: m.id,
        fromMe: m.from?.id === account.instagramId,
        text: messageDetailText(m),
        sentAt: m.created_time ? new Date(m.created_time) : new Date(),
        source: "GRAPH" as const,
      }));

    if (rows.length > 0) {
      const created = await prisma.message.createMany({
        data: rows,
        skipDuplicates: true,
      });
      messages += created.count;
    }

    // Re-derive the summary from what the thread actually holds now, rather
    // than trusting the preview: the sync may just have inserted older
    // messages, and the newest of them is not necessarily Meta's preview.
    const newest = await prisma.message.findFirst({
      where: { conversationId: stored.id },
      orderBy: { sentAt: "desc" },
      select: { sentAt: true, text: true, fromMe: true },
    });
    if (newest) {
      await prisma.conversation.update({
        where: { id: stored.id },
        data: {
          lastMessageAt: newest.sentAt,
          lastMessageText: newest.text,
          lastMessageFromMe: newest.fromMe,
        },
      });
    }
  }

  const followChecks = await refreshFollowStatus(account, token);

  return { conversations, messages, threadsFetched, followChecks };
}

/** Reconcile every connected account. */
export async function syncAllConversations(
  maxThreadFetches = 25
): Promise<SyncResult & { accounts: number }> {
  const accounts = await prisma.instagramAccount.findMany({
    where: { accessToken: { not: "" } },
    select: {
      id: true,
      workspaceId: true,
      instagramId: true,
      accessToken: true,
    },
  });

  const total: SyncResult & { accounts: number } = {
    accounts: 0,
    conversations: 0,
    messages: 0,
    threadsFetched: 0,
    followChecks: 0,
  };

  for (const account of accounts) {
    const result = await syncAccountConversations(account, maxThreadFetches);
    total.accounts += 1;
    total.conversations += result.conversations;
    total.messages += result.messages;
    total.threadsFetched += result.threadsFetched;
    total.followChecks += result.followChecks;
  }

  return total;
}
