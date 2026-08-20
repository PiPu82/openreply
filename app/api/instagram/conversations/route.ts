import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { sendDirectMessage, MetaApiError } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { recordThreadMessages } from "@/lib/inbox/store";
import { syncAccountConversations } from "@/lib/inbox/sync";

/**
 * Accounts with a first-load sync in flight.
 *
 * The inbox polls every 12 seconds, so without this the wait for the initial
 * sync would start a second one, and a third. Process-local on purpose: it
 * guards a single server's duplicate work, nothing more.
 */
const syncing = new Set<string>();

export interface ConversationListItem {
  id: string;
  contact: { id: string; username: string | null };
  updatedTime: string | null;
  lastMessage: {
    text: string;
    fromMe: boolean;
    createdTime: string | null;
  } | null;
}

export interface ConversationsResponse {
  conversations: ConversationListItem[];
  account: { id: string; username: string; instagramId: string };
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
    let stored = await prisma.conversation.findMany({
      where: { workspaceId, instagramAccountId: account.id },
      orderBy: { lastMessageAt: "desc" },
      take: 50,
      select: {
        id: true,
        contactId: true,
        contactUsername: true,
        lastMessageAt: true,
        lastMessageText: true,
        lastMessageFromMe: true,
        updatedAt: true,
      },
    });

    // Nothing stored yet — a newly connected account, or the very first load
    // after this store was introduced. Fetch once, inline, so the inbox is not
    // simply empty; every later load is served from disk.
    if (stored.length === 0 && !syncing.has(account.id)) {
      syncing.add(account.id);
      try {
        await syncAccountConversations(account, 10);
      } catch (error) {
        console.error("[Conversations] Initial sync failed:", error);
      } finally {
        syncing.delete(account.id);
      }

      stored = await prisma.conversation.findMany({
        where: { workspaceId, instagramAccountId: account.id },
        orderBy: { lastMessageAt: "desc" },
        take: 50,
        select: {
          id: true,
          contactId: true,
          contactUsername: true,
          lastMessageAt: true,
          lastMessageText: true,
          lastMessageFromMe: true,
          updatedAt: true,
        },
      });
    }

    const conversations: ConversationListItem[] = stored.map((c) => ({
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
    }));

    const data: ConversationsResponse = {
      conversations,
      account: {
        id: account.id,
        username: account.username,
        instagramId: account.instagramId,
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
