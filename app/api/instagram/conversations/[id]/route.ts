import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { MetaApiError } from "@/lib/meta/client";

export interface ThreadMessage {
  id: string;
  text: string;
  fromMe: boolean;
  fromUsername: string | null;
  createdTime: string | null;
  /// When the recipient read it, for messages we sent. Null while unread.
  readTime?: string | null;
  /// The media file kept for this message, where one was captured. The bytes
  /// are fetched separately; `text` still carries the placeholder, so a
  /// message whose download failed reads exactly as it did before.
  attachment?: { type: string; mimeType: string } | null;
}

export interface ThreadResponse {
  messages: ThreadMessage[];
}

type RouteProps = { params: Promise<{ id: string }> };

// Message history for a single conversation, oldest first.
//
// Served from the local store: Meta's Conversations API takes over a second
// per thread and only ever returns the 20 most recent messages, while the
// store keeps everything the webhook ever delivered.
export async function GET(request: NextRequest, { params }: RouteProps) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { id: conversationId } = await params;

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
    const conversation = await prisma.conversation.findFirst({
      where: {
        id: conversationId,
        workspaceId,
        instagramAccountId: account.id,
      },
      select: { id: true, contactUsername: true },
    });

    if (!conversation) {
      return NextResponse.json(
        { success: false, error: "Conversation not found." },
        { status: 404 }
      );
    }

    const stored = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { sentAt: "asc" },
      // Generous, but bounded: a thread this long is already unreadable, and
      // an unbounded query would be a way to tip the server over.
      take: 500,
      select: {
        id: true,
        text: true,
        fromMe: true,
        sentAt: true,
        readAt: true,
        // Only the shape, never the bytes: a thread of 500 messages must not
        // drag megabytes of media through this response. The file itself is
        // fetched per message from /api/inbox/attachment.
        attachment: { select: { type: true, mimeType: true } },
      },
    });

    const messages: ThreadMessage[] = stored.map((m) => ({
      id: m.id,
      text: m.text,
      fromMe: m.fromMe,
      fromUsername: m.fromMe ? account.username : conversation.contactUsername,
      createdTime: m.sentAt.toISOString(),
      readTime: m.readAt?.toISOString() ?? null,
      attachment: m.attachment
        ? { type: m.attachment.type, mimeType: m.attachment.mimeType }
        : null,
    }));

    const data: ThreadResponse = { messages };
    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error("[Conversation Messages] Error:", err);
    const message =
      err instanceof MetaApiError ? err.message : "Failed to load messages";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

/**
 * Erase everything held about one person.
 *
 * The counterpart to the export: a deletion request, answered in one action
 * rather than by hand-written SQL. Removes the thread with its messages
 * (cascade) and the DM log entries that name them.
 *
 * LinkClick is deliberately untouched — it stores a hashed IP and no personal
 * identifier, which is why it can stay.
 *
 * This does not reach Instagram. The conversation still exists in the app for
 * both sides; what is erased is this system's copy.
 */
export async function DELETE(request: NextRequest, { params }: RouteProps) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { id: conversationId } = await params;

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

  const conversation = await prisma.conversation.findFirst({
    where: {
      id: conversationId,
      workspaceId,
      instagramAccountId: account.id,
    },
    select: { id: true, contactId: true },
  });

  if (!conversation) {
    return NextResponse.json(
      { success: false, error: "Conversation not found." },
      { status: 404 }
    );
  }

  // One transaction: a half-erased person — thread gone, funnel log still
  // naming them — would be worse than not having started.
  const [dmLogs] = await prisma.$transaction([
    prisma.dmLog.deleteMany({
      where: { commenterId: conversation.contactId, workspaceId },
    }),
    prisma.conversation.delete({ where: { id: conversation.id } }),
  ]);

  return NextResponse.json({
    success: true,
    data: { conversationDeleted: true, dmLogsDeleted: dmLogs.count },
  });
}
