import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";

const DEFAULT_RETENTION_DAYS = 180;

/**
 * Delete stored messages past their retention period.
 *
 * The store holds personal data — Instagram handles and whatever people wrote —
 * so it needs a limit from the start rather than one bolted on once the table
 * has grown. `INBOX_RETENTION_DAYS` sets it; the default matches the retention
 * already used for uploads.
 *
 * Threads left without any message are removed too: an empty thread still names
 * a person. The same cut-off applies to recorded interactions, which carry a
 * contact id and often a handle.
 *
 * Pass `?dryRun=1` to see what a run would remove without removing it.
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

  const configured = Number.parseInt(
    process.env.INBOX_RETENTION_DAYS ?? "",
    10
  );
  const retentionDays =
    Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_RETENTION_DAYS;

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const dryRun = request.nextUrl.searchParams.get("dryRun") === "1";

  try {
    if (dryRun) {
      const [messages, interactions] = await Promise.all([
        prisma.message.count({ where: { sentAt: { lt: cutoff } } }),
        prisma.interaction.count({ where: { at: { lt: cutoff } } }),
      ]);
      return NextResponse.json({
        success: true,
        data: { dryRun: true, retentionDays, cutoff, messages, interactions },
      });
    }

    const messages = await prisma.message.deleteMany({
      where: { sentAt: { lt: cutoff } },
    });
    const conversations = await prisma.conversation.deleteMany({
      where: { messages: { none: {} } },
    });
    const interactions = await prisma.interaction.deleteMany({
      where: { at: { lt: cutoff } },
    });

    return NextResponse.json({
      success: true,
      data: {
        retentionDays,
        cutoff,
        messages: messages.count,
        conversations: conversations.count,
        interactions: interactions.count,
      },
    });
  } catch (error) {
    console.error("[Cron] Message cleanup failed:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Cleanup failed",
      },
      { status: 500 }
    );
  }
}
