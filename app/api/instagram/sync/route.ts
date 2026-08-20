import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { syncAccountConversations } from "@/lib/inbox/sync";
import { MetaApiError } from "@/lib/meta/client";

/**
 * Reconcile with Meta on request — the inbox's refresh button.
 *
 * The inbox is fed by webhooks and reconciled in the background every few
 * minutes, so this is not needed to see new messages. It exists for the moment
 * someone knows a message should be there and it is not: rather than wondering
 * whether the automatic pass has run, they can force one and watch it happen.
 *
 * Awaited rather than fired off in the background, because here somebody is
 * deliberately waiting for the result.
 */
export async function POST(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  let body: { instagramAccountId?: string } = {};
  try {
    body = await request.json();
  } catch {
    // No body is fine — fall back to the workspace's default account.
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
    const result = await syncAccountConversations(account);
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    console.error("[Inbox] Manual sync failed:", err);
    const message =
      err instanceof MetaApiError ? err.message : "Refresh failed";
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
