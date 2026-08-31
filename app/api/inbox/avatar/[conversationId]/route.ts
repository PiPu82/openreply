import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getCurrentWorkspaceId } from "@/lib/auth";

/**
 * Serve a contact's profile picture.
 *
 * Stored locally because Instagram's own link expires; see `lib/inbox/media`.
 * Workspace-scoped for the same reason as attachments, and 404 rather than 403
 * so an id cannot be confirmed by probing.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { conversationId } = await params;
  const avatar = await prisma.contactAvatar.findFirst({
    where: { conversationId, workspaceId },
    select: { data: true, mimeType: true, byteSize: true },
  });

  if (!avatar) {
    return NextResponse.json(
      { success: false, error: "Not found" },
      { status: 404 }
    );
  }

  return new NextResponse(Buffer.from(avatar.data), {
    headers: {
      "Content-Type": avatar.mimeType,
      "Content-Length": String(avatar.byteSize),
      // Shorter than an attachment's: a profile picture is replaced when the
      // sync refreshes it, so the browser should come back for it eventually.
      "Cache-Control": "private, max-age=86400",
    },
  });
}
