import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import {
  RANKING_PERIODS,
  topContacts,
  type RankedContact,
  type RankingPeriod,
} from "@/lib/engagement/ranking";

export interface EngagementResponse {
  contacts: RankedContact[];
  period: RankingPeriod;
  /// Earliest interaction on record, so the page can say how far "since the
  /// beginning" actually reaches instead of implying it covers everything.
  since: string | null;
  account: { id: string; username: string };
}

const VALID_PERIODS = RANKING_PERIODS.map((p) => p.value);

export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

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

  const requested = request.nextUrl.searchParams.get("period");
  const period: RankingPeriod = VALID_PERIODS.includes(
    requested as RankingPeriod
  )
    ? (requested as RankingPeriod)
    : "7d";

  const limit = Math.min(
    Number.parseInt(request.nextUrl.searchParams.get("limit") ?? "100", 10) ||
      100,
    100
  );

  try {
    const [contacts, earliest] = await Promise.all([
      topContacts(workspaceId, account.id, period, limit),
      prisma.interaction.findFirst({
        where: { workspaceId, instagramAccountId: account.id },
        orderBy: { at: "asc" },
        select: { at: true },
      }),
    ]);

    const data: EngagementResponse = {
      contacts,
      period,
      since: earliest?.at.toISOString() ?? null,
      account: { id: account.id, username: account.username },
    };
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("[Engagement] Failed to rank contacts:", error);
    return NextResponse.json(
      { success: false, error: "Auswertung konnte nicht geladen werden" },
      { status: 500 }
    );
  }
}
