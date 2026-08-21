/**
 * Ranking the most active contacts.
 *
 * One point per action, counted per period rather than stored: a saved score
 * would have to be recomputed every time someone switches from 7 days to 30,
 * and would drift the moment the retention job removes old rows.
 */

import { prisma } from "@/lib/db/client";

export type RankingPeriod = "7d" | "14d" | "30d" | "all";

export const RANKING_PERIODS: Array<{ value: RankingPeriod; label: string }> = [
  { value: "7d", label: "7 Tage" },
  { value: "14d", label: "14 Tage" },
  { value: "30d", label: "30 Tage" },
  { value: "all", label: "Seit Beginn" },
];

const PERIOD_DAYS: Record<Exclude<RankingPeriod, "all">, number> = {
  "7d": 7,
  "14d": 14,
  "30d": 30,
};

export function periodStart(period: RankingPeriod): Date | null {
  if (period === "all") return null;
  return new Date(Date.now() - PERIOD_DAYS[period] * 24 * 60 * 60 * 1000);
}

export interface RankedContact {
  contactId: string;
  username: string | null;
  points: number;
  comments: number;
  dms: number;
  buttonTaps: number;
  lastAt: string;
  /// The thread with this contact, when one exists — so a row can open it.
  conversationId: string | null;
}

/**
 * The most active contacts in a period.
 *
 * Grouped by contact id rather than by handle: a handle can change, and the id
 * is what every event carries. The handle shown is whichever of their events
 * supplied one — comments always do, button taps never.
 */
export async function topContacts(
  workspaceId: string,
  instagramAccountId: string,
  period: RankingPeriod,
  limit = 100
): Promise<RankedContact[]> {
  const since = periodStart(period);

  const rows = await prisma.interaction.groupBy({
    by: ["contactId"],
    where: {
      workspaceId,
      instagramAccountId,
      ...(since ? { at: { gte: since } } : {}),
    },
    _count: { _all: true },
    _max: { at: true },
    orderBy: { _count: { contactId: "desc" } },
    take: limit,
  });

  if (rows.length === 0) return [];

  const contactIds = rows.map((r) => r.contactId);

  // Per-type counts and the handles, in one query each rather than per row.
  const [byType, conversations] = await Promise.all([
    prisma.interaction.groupBy({
      by: ["contactId", "type"],
      where: {
        workspaceId,
        instagramAccountId,
        contactId: { in: contactIds },
        ...(since ? { at: { gte: since } } : {}),
      },
      _count: { _all: true },
    }),
    prisma.conversation.findMany({
      where: { workspaceId, instagramAccountId, contactId: { in: contactIds } },
      select: { id: true, contactId: true, contactUsername: true },
    }),
  ]);

  const named = await prisma.interaction.findMany({
    where: {
      workspaceId,
      contactId: { in: contactIds },
      contactUsername: { not: null },
    },
    distinct: ["contactId"],
    select: { contactId: true, contactUsername: true },
  });

  const handleFromInteraction = new Map(
    named.map((n) => [n.contactId, n.contactUsername])
  );
  const conversationByContact = new Map(
    conversations.map((c) => [c.contactId, c])
  );

  const counts = new Map<string, { COMMENT: number; DM: number; BUTTON_TAP: number }>();
  for (const row of byType) {
    const entry = counts.get(row.contactId) ?? {
      COMMENT: 0,
      DM: 0,
      BUTTON_TAP: 0,
    };
    entry[row.type] = row._count._all;
    counts.set(row.contactId, entry);
  }

  return rows.map((row) => {
    const perType = counts.get(row.contactId);
    const conversation = conversationByContact.get(row.contactId);
    return {
      contactId: row.contactId,
      username:
        handleFromInteraction.get(row.contactId) ??
        conversation?.contactUsername ??
        null,
      points: row._count._all,
      comments: perType?.COMMENT ?? 0,
      dms: perType?.DM ?? 0,
      buttonTaps: perType?.BUTTON_TAP ?? 0,
      lastAt: (row._max.at ?? new Date()).toISOString(),
      conversationId: conversation?.id ?? null,
    };
  });
}
