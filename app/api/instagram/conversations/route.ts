import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { sendDirectMessage, MetaApiError } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { recordThreadMessages } from "@/lib/inbox/store";
import {
  automationsForContacts,
  buildInboxQuery,
  inboxFilterOptions,
  type InboxFilters,
  type ThreadState,
} from "@/lib/inbox/query";
import { syncAccountConversations } from "@/lib/inbox/sync";
import { addDays, startOfDay } from "@/lib/utils/datetime";

/**
 * Accounts with a sync in flight.
 *
 * The inbox polls every 12 seconds, so without this one slow sync would start
 * a second one, and a third. Process-local on purpose: it guards a single
 * server's duplicate work, nothing more.
 */
const syncing = new Set<string>();

/** When each account was last reconciled with Meta, to keep that rare. */
const lastSyncedAt = new Map<string, number>();

const BACKGROUND_SYNC_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Reconcile with Meta behind the response, not in front of it.
 *
 * Webhooks are what keep the store current, but a delivery can be missed while
 * the stack restarts, and Meta does not redeliver forever. Before this store
 * existed every click went to Meta and such a gap could not happen; now it has
 * to be closed deliberately.
 *
 * Deliberately not awaited: the whole point of reading locally is that nobody
 * waits several seconds for Meta. Anything this recovers appears on the next
 * poll, twelve seconds later.
 */
function syncInBackground(account: {
  id: string;
  workspaceId: string;
  instagramId: string;
  accessToken: string;
}): void {
  const since = Date.now() - (lastSyncedAt.get(account.id) ?? 0);
  if (since < BACKGROUND_SYNC_INTERVAL_MS || syncing.has(account.id)) return;

  // Claim the slot before starting, or the polls arriving during the sync
  // would each start their own.
  lastSyncedAt.set(account.id, Date.now());
  syncing.add(account.id);

  void syncAccountConversations(account, 10)
    .catch((error) => {
      console.error("[Conversations] Background sync failed:", error);
    })
    .finally(() => {
      syncing.delete(account.id);
    });
}

export interface ThreadAutomationInfo {
  id: string;
  name: string;
  status: string;
  matchedKeyword: string | null;
  sentTime: string | null;
}

export interface ConversationListItem {
  id: string;
  contact: { id: string; username: string | null };
  updatedTime: string | null;
  lastMessage: {
    text: string;
    fromMe: boolean;
    createdTime: string | null;
  } | null;
  /// Which campaign brought this contact in, if any. Null means they wrote in
  /// by themselves — no automation ever reached them.
  automation: ThreadAutomationInfo | null;
  /// Who follows whom, which is what decides the Instagram folder a message
  /// lands in. Null until the sync has checked this contact.
  follow: { contactFollowsUs: boolean | null; weFollowContact: boolean | null };
  /// Whether a profile picture has been captured for this contact. False means
  /// initials — either the sync has not reached them, or Instagram gave none.
  hasAvatar: boolean;
}

export interface ConversationsResponse {
  conversations: ConversationListItem[];
  account: { id: string; username: string; instagramId: string };
  /// Choices for the filter controls, derived from the data that exists.
  filters: {
    automations: Array<{ id: string; name: string }>;
    keywords: string[];
  };
  counts: { shown: number; awaitingReply: number };
}

const THREAD_STATES: ThreadState[] = [
  "awaiting_reply",
  "dm_failed",
  "delivered_unread",
  "in_requests",
  "follows_us",
  "all",
];

/**
 * Parse a date parameter, ignoring anything unparseable rather than failing.
 *
 * The value is a day as picked in the browser, so its boundaries are German
 * ones. Read as UTC — which is what the bare string used to do — the window
 * came out two hours off.
 */
function parseDate(value: string | null, endOfDay = false): Date | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return undefined;
  return endOfDay ? addDays(startOfDay(date), 1) : startOfDay(date);
}

function readFilters(params: URLSearchParams): InboxFilters {
  const state = params.get("state");
  return {
    q: params.get("q") ?? undefined,
    from: parseDate(params.get("from")),
    // An end date is given as a day, and a day includes its evening: this
    // is the start of the following day, compared exclusively.
    to: parseDate(params.get("to"), true),
    automationId: (params.get("automation") as InboxFilters["automationId"]) ?? undefined,
    keyword: params.get("keyword") ?? undefined,
    state: THREAD_STATES.includes(state as ThreadState)
      ? (state as ThreadState)
      : undefined,
  };
}

// List the account's DM conversations for the inbox.
export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const account = await getWorkspaceInstagramAccount(
    workspaceId,
    request.nextUrl.searchParams.get("instagramAccountId")
  );
  if (!account) {
    return NextResponse.json(
      { success: false, error: "Instagram account not connected." },
      { status: 400 }
    );
  }

  try {
    // Read from the local store, not from Meta. The Conversations API needs
    // 5–9 seconds for this list because it resolves 50 threads on demand;
    // every one of those messages already arrived by webhook and is on disk.
    const filters = readFilters(request.nextUrl.searchParams);
    const { where } = await buildInboxQuery(workspaceId, account.id, filters);

    let stored = await prisma.conversation.findMany({
      where,
      orderBy: { lastMessageAt: "desc" },
      // Higher than the old cap of 50: that number was set by how many threads
      // Meta could resolve in one call, which no longer applies. With filters
      // in front of it, a page of 200 is what makes a filtered view usable.
      take: 200,
      select: {
        id: true,
        contactId: true,
        contactUsername: true,
        lastMessageAt: true,
        lastMessageText: true,
        lastMessageFromMe: true,
        updatedAt: true,
        contactFollowsUs: true,
        weFollowContact: true,
        // Presence only. The picture itself is served per row from
        // /api/inbox/avatar; selecting the bytes here would put megabytes of
        // images into a list response.
        avatar: { select: { id: true } },
      },
    });

    // Nothing stored yet — a newly connected account, or the very first load
    // after this store was introduced. Fetch once, inline, so the inbox is not
    // simply empty; every later load is served from disk.
    if (stored.length === 0 && !syncing.has(account.id)) {
      syncing.add(account.id);
      lastSyncedAt.set(account.id, Date.now());
      try {
        await syncAccountConversations(account, 10);
      } catch (error) {
        console.error("[Conversations] Initial sync failed:", error);
      } finally {
        syncing.delete(account.id);
      }

      stored = await prisma.conversation.findMany({
        where,
        orderBy: { lastMessageAt: "desc" },
        take: 200,
        select: {
          id: true,
          contactId: true,
          contactUsername: true,
          lastMessageAt: true,
          lastMessageText: true,
          lastMessageFromMe: true,
          updatedAt: true,
          contactFollowsUs: true,
          weFollowContact: true,
          // Presence only. The picture itself is served per row from
          // /api/inbox/avatar; selecting the bytes here would put megabytes of
          // images into a list response.
          avatar: { select: { id: true } },
        },
      });
    } else {
      syncInBackground(account);
    }

    // One lookup for the whole page rather than one per row.
    const automations = await automationsForContacts(
      stored.map((c) => c.contactId)
    );

    const conversations: ConversationListItem[] = stored.map((c) => {
      const automation = automations.get(c.contactId);
      return {
        id: c.id,
        contact: { id: c.contactId, username: c.contactUsername },
        updatedTime: (c.lastMessageAt ?? c.updatedAt).toISOString(),
        lastMessage: c.lastMessageAt
          ? {
              text: c.lastMessageText ?? "",
              fromMe: c.lastMessageFromMe,
              createdTime: c.lastMessageAt.toISOString(),
            }
          : null,
        follow: {
          contactFollowsUs: c.contactFollowsUs,
          weFollowContact: c.weFollowContact,
        },
        hasAvatar: Boolean(c.avatar),
        automation: automation
          ? {
              id: automation.id,
              name: automation.name,
              status: automation.status,
              matchedKeyword: automation.matchedKeyword,
              sentTime: automation.sentAt?.toISOString() ?? null,
            }
          : null,
      };
    });

    const data: ConversationsResponse = {
      conversations,
      account: {
        id: account.id,
        username: account.username,
        instagramId: account.instagramId,
      },
      filters: await inboxFilterOptions(account.id),
      counts: {
        shown: conversations.length,
        awaitingReply: conversations.filter(
          (c) => c.lastMessage && !c.lastMessage.fromMe
        ).length,
      },
    };
    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error("[Conversations] Error:", err);
    const message =
      err instanceof MetaApiError
        ? err.message
        : "Failed to load conversations";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

// Send a direct message reply.
export async function POST(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  let body: { instagramAccountId?: string; recipientId?: string; text?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid request body" },
      { status: 400 }
    );
  }

  const text = body.text?.trim();
  if (!body.recipientId || !text) {
    return NextResponse.json(
      { success: false, error: "A recipient and message are required." },
      { status: 400 }
    );
  }

  const account = await getWorkspaceInstagramAccount(
    workspaceId,
    body.instagramAccountId ?? null
  );
  if (!account) {
    return NextResponse.json(
      { success: false, error: "Instagram account not connected." },
      { status: 400 }
    );
  }

  try {
    const accessToken = decryptToken(account.accessToken);
    const result = await sendDirectMessage(
      accessToken,
      account.instagramId,
      body.recipientId,
      text
    );

    // File the sent message immediately instead of waiting for Meta to echo it
    // back. The echo does arrive, and the unique message id keeps it from being
    // stored twice — but it can take a few seconds, and in the meantime the
    // thread would poll, not find the message, and drop the one the composer
    // optimistically showed.
    await recordThreadMessages([
      {
        instagramAccountId: account.instagramId,
        contactId: body.recipientId,
        mid: result.message_id,
        fromMe: true,
        text,
        sentAt: new Date(),
      },
    ]).catch((error) => {
      // The message did go out; only the local copy failed. Reporting a
      // failure here would invite a duplicate send.
      console.error("[Conversations] Storing sent message failed:", error);
    });

    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    console.error("[Conversations] Send error:", err);
    // Surface Meta's own message — the common case is the 24-hour messaging
    // window having closed, which the user needs to see explicitly.
    const message =
      err instanceof MetaApiError ? err.message : "Failed to send message";
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
