import { NextRequest, NextResponse } from "next/server";
import { syncAllConversations } from "@/lib/inbox/sync";

/**
 * Reconcile the local conversation store with Meta.
 *
 * The inbox reads from the store, which is fed by webhooks. This closes the
 * gaps webhooks cannot: messages that arrived while the stack was down, and
 * contact usernames, which webhooks never carry.
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
    const result = await syncAllConversations();
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error("[Cron] Conversation sync failed:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Sync failed",
      },
      { status: 500 }
    );
  }
}
