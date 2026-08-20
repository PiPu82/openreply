import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";

type RouteProps = { params: Promise<{ id: string }> };

/**
 * Everything held about one person, as a file.
 *
 * Built for a subject access request: someone asks what is stored about them,
 * and the answer has to be complete and legible. Until now that meant querying
 * the database by hand, which makes a deadline dependent on whoever can write
 * SQL.
 *
 * Includes the DM log as well as the thread — the log is where the funnel
 * recorded their comment and handle, and it is just as much their data as the
 * conversation is.
 */
export async function GET(request: NextRequest, { params }: RouteProps) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { id } = await params;
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
    where: { id, workspaceId, instagramAccountId: account.id },
    select: {
      contactId: true,
      contactUsername: true,
      createdAt: true,
      messages: {
        orderBy: { sentAt: "asc" },
        select: {
          text: true,
          fromMe: true,
          sentAt: true,
          readAt: true,
          source: true,
        },
      },
    },
  });

  if (!conversation) {
    return NextResponse.json(
      { success: false, error: "Conversation not found." },
      { status: 404 }
    );
  }

  const dmLogs = await prisma.dmLog.findMany({
    where: { commenterId: conversation.contactId, workspaceId },
    orderBy: { createdAt: "asc" },
    select: {
      commentText: true,
      matchedKeyword: true,
      status: true,
      errorMessage: true,
      dmSentAt: true,
      createdAt: true,
      automation: { select: { name: true } },
    },
  });

  const exported = {
    exportedAt: new Date().toISOString(),
    account: account.username,
    contact: {
      instagramId: conversation.contactId,
      username: conversation.contactUsername,
      firstSeen: conversation.createdAt,
    },
    messages: conversation.messages,
    automationLog: dmLogs,
  };

  const name = conversation.contactUsername ?? conversation.contactId;
  return new NextResponse(JSON.stringify(exported, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Sanitised: a handle is user-controlled and must not be able to steer
      // the filename with quotes or path separators.
      "Content-Disposition": `attachment; filename="openreply-${name.replace(
        /[^a-zA-Z0-9._-]/g,
        "_"
      )}.json"`,
    },
  });
}
