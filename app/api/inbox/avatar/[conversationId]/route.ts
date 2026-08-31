import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { isAllowedMimeType } from "@/lib/inbox/media";

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

  // An avatar is always a picture; anything else stored here is refused rather
  // than served back from the origin the dashboard session lives on.
  if (!avatar || !isAllowedMimeType("image", avatar.mimeType)) {
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
      // Layered on purpose; any one of these alone is a single point of
      // failure for a stored file served from the app's own origin.
      //   nosniff  — a mislabelled file must not be sniffed into HTML.
      //   CSP      — even if something got stored as an executable type, it
      //              may load nothing and run nothing.
      //   sandbox  — no scripts, no same-origin, so an SVG cannot reach the
      //              session it would be rendered next to.
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
    },
  });
}
