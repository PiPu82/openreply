import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { repairAttachments } from "@/lib/inbox/attachment-repair";

/**
 * Recover media whose webhook moment was missed.
 *
 * The live path downloads a file while Meta's link is still valid; this is the
 * second pass for the ones that slipped — a lost delivery, a worker restart, a
 * retry that outlived the url. Bounded by Meta's twenty-message window per
 * thread, so it is a repair and not a promise.
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

  const accounts = await prisma.instagramAccount.findMany({
    select: { id: true, workspaceId: true, accessToken: true },
  });

  let candidates = 0;
  let repaired = 0;
  const failures: string[] = [];

  for (const account of accounts) {
    try {
      const result = await repairAttachments(account);
      candidates += result.candidates;
      repaired += result.repaired;
    } catch (error) {
      failures.push(account.id);
      console.error("[repair-attachments] account failed", account.id, error);
    }
  }

  return NextResponse.json({
    success: true,
    data: { accounts: accounts.length, candidates, repaired, failures: failures.length },
  });
}
