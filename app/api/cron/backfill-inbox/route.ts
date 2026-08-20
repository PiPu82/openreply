import { NextRequest, NextResponse } from "next/server";
import { backfillInboxFromWebhookEvents } from "@/lib/inbox/backfill";

/**
 * Rebuild the conversation store from stored webhook payloads.
 *
 * Meant to be run once after the store is introduced — it recovers everything
 * back to the first webhook ever received, which reaches further than the
 * Conversations API does (20 messages per thread). Idempotent, so a repeat run
 * costs time but changes nothing.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;

  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  try {
    const result = await backfillInboxFromWebhookEvents();
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error("[Cron] Inbox backfill failed:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Backfill failed",
      },
      { status: 500 }
    );
  }
}
