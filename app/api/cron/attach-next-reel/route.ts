import { NextRequest, NextResponse } from "next/server";
import { attachPendingCampaigns } from "@/lib/campaigns/attach-next-post";

/**
 * Binds "next post" campaigns to a real post.
 *
 * The logic lives in `lib/campaigns/attach-next-post` because the comment path
 * runs it too — the first comment on a new post is the earliest signal Meta
 * gives us that the post exists. This route is the safety net for the window
 * before anyone comments, and runs on a short timer (see run-attach.py).
 *
 * The path still says "reel" for the deployed timer's sake; the campaign type
 * covers every post.
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

  const { checked, bound, failedAccounts } = await attachPendingCampaigns();

  return NextResponse.json({
    success: true,
    data: { checked, bound, failedAccounts: failedAccounts.length },
  });
}
