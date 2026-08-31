import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getCurrentWorkspaceId } from "@/lib/auth";

/**
 * Serve a media file somebody sent in a thread.
 *
 * Scoped to the caller's workspace: these are photos and voice notes real
 * people sent in confidence, and an id-only URL would hand them to anyone who
 * guessed one. A file belonging to another workspace answers 404 rather than
 * 403 — a 403 confirms the id exists.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ messageId: string }> }
) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { messageId } = await params;
  const attachment = await prisma.messageAttachment.findFirst({
    where: { messageId, workspaceId },
    select: { data: true, mimeType: true, byteSize: true },
  });

  if (!attachment) {
    return NextResponse.json(
      { success: false, error: "Not found" },
      { status: 404 }
    );
  }

  return new NextResponse(Buffer.from(attachment.data), {
    headers: {
      "Content-Type": attachment.mimeType,
      "Content-Length": String(attachment.byteSize),
      // The bytes belong to one message and never change, so the browser may
      // keep them. Private: this is somebody's photo, not a public asset.
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
