/**
 * Recording what people do.
 *
 * Every comment on the account arrives by webhook, matched keyword or not, and
 * so does every inbound DM and every button tap. Until now anything that
 * matched no campaign was discarded. Keeping it costs nothing — no API call,
 * now or later — and is what makes a ranking of the most active contacts
 * possible at all.
 *
 * What it cannot be is a ranking of followers: Meta never discloses who follows
 * an account, only who interacts with it.
 */

import { prisma } from "@/lib/db/client";
import type { InteractionType } from "@/app/generated/prisma/client";

export interface InteractionInput {
  /// IGSID of the connected account, as webhooks report it.
  instagramAccountId: string;
  contactId: string;
  contactUsername?: string | null;
  type: InteractionType;
  externalId: string;
  at: Date;
}

/**
 * Store interactions, skipping any already recorded.
 *
 * Idempotent through the unique external id, which matters twice over: Meta
 * redelivers on any non-200, and the backfill replays payloads that were
 * already handled live.
 */
export async function recordInteractions(
  events: InteractionInput[]
): Promise<number> {
  if (events.length === 0) return 0;

  const accounts = await prisma.instagramAccount.findMany({
    where: {
      instagramId: { in: Array.from(new Set(events.map((e) => e.instagramAccountId))) },
    },
    select: { id: true, workspaceId: true, instagramId: true },
  });
  const byIgsid = new Map(accounts.map((a) => [a.instagramId, a]));

  const rows = events
    .map((event) => {
      const account = byIgsid.get(event.instagramAccountId);
      // An account this instance does not manage. Filing it under a guessed
      // workspace would put one workspace's contacts in another's ranking.
      if (!account) return null;
      return {
        workspaceId: account.workspaceId,
        instagramAccountId: account.id,
        contactId: event.contactId,
        contactUsername: event.contactUsername ?? null,
        type: event.type,
        externalId: event.externalId,
        at: event.at,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (rows.length === 0) return 0;

  const created = await prisma.interaction.createMany({
    data: rows,
    skipDuplicates: true,
  });
  return created.count;
}

/**
 * Map the parser's wording onto the stored type.
 *
 * Kept explicit rather than upper-casing the string: the parser belongs to the
 * Meta layer and the enum to the database, and a rename on either side should
 * fail to compile rather than silently stop matching.
 */
const KIND_TO_TYPE: Record<
  "comment" | "dm" | "button_tap",
  InteractionType
> = {
  comment: "COMMENT",
  dm: "DM",
  button_tap: "BUTTON_TAP",
};

export function toInteractionInputs(
  events: Array<{
    instagramAccountId: string;
    contactId: string;
    contactUsername?: string;
    kind: "comment" | "dm" | "button_tap";
    externalId: string;
    at: Date;
  }>
): InteractionInput[] {
  return events.map((event) => ({
    instagramAccountId: event.instagramAccountId,
    contactId: event.contactId,
    contactUsername: event.contactUsername ?? null,
    type: KIND_TO_TYPE[event.kind],
    externalId: event.externalId,
    at: event.at,
  }));
}
