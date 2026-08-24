/**
 * Inbox filtering.
 *
 * Two kinds of filter meet here, and they cannot be expressed the same way.
 *
 * Anything about the thread itself — search text, date range, who spoke last —
 * is a condition on Conversation and Message, which are related, so Prisma can
 * express it directly.
 *
 * Anything about an automation is not: DmLog identifies people by their
 * Instagram id (`commenterId`), with no foreign key to Conversation, because
 * the DM log predates this store and records comment senders rather than
 * threads. Those filters are therefore resolved to a set of contact ids first,
 * and applied as `contactId IN (…)`. Fine at this scale — a few hundred to a
 * few thousand ids — and the alternative, a raw SQL join, would give up
 * Prisma's workspace scoping on the query that most needs it.
 */

import { prisma } from "@/lib/db/client";
import type { Prisma } from "@/app/generated/prisma/client";

export type ThreadState =
  | "awaiting_reply"
  | "dm_failed"
  | "delivered_unread"
  /// Their reply sits in Instagram's requests folder, because the account does
  /// not follow them back. Instagram exposes no field for the folder itself —
  /// this is the condition that puts a message there.
  | "in_requests"
  /// The contact follows the account, so our DMs reach their normal inbox.
  | "follows_us"
  | "all";

export interface InboxFilters {
  /** Free text, matched against the contact's handle and message bodies. */
  q?: string;
  /** Inclusive start of the period a thread must have activity in. */
  from?: Date;
  /** Inclusive end of that period. */
  to?: Date;
  /**
   * Automation id, or the two special cases: threads reached by any automation
   * at all, and threads reached by none — people who wrote in by themselves.
   */
  automationId?: string | "any" | "none";
  /** The keyword whose match triggered the automation, e.g. "strom". */
  keyword?: string;
  state?: ThreadState;
}

/**
 * Contact ids selected by the automation-related filters, or null when none of
 * them is active. An empty array is meaningful: it means "no thread matches",
 * which is not the same as "no filter".
 */
async function contactIdsForAutomationFilters(
  filters: InboxFilters
): Promise<string[] | null> {
  const wantsAutomation = Boolean(filters.automationId);
  const wantsKeyword = Boolean(filters.keyword);
  const wantsFailed = filters.state === "dm_failed";

  if (!wantsAutomation && !wantsKeyword && !wantsFailed) return null;

  // "none" is the inverse: every contact an automation ever reached is
  // excluded, so resolve the same set and negate it at the call site.
  const where: Prisma.DmLogWhereInput = {};
  if (filters.automationId && filters.automationId !== "any" && filters.automationId !== "none") {
    where.automationId = filters.automationId;
  }
  if (filters.keyword) {
    where.matchedKeyword = { equals: filters.keyword, mode: "insensitive" };
  }
  if (wantsFailed) {
    where.status = "FAILED";
  }

  const rows = await prisma.dmLog.findMany({
    where,
    select: { commenterId: true },
    distinct: ["commenterId"],
  });

  return rows.map((r) => r.commenterId);
}

export interface BuiltInboxQuery {
  where: Prisma.ConversationWhereInput;
}

/**
 * Translate the filters into a Conversation query, scoped to one account.
 */
export async function buildInboxQuery(
  workspaceId: string,
  instagramAccountId: string,
  filters: InboxFilters
): Promise<BuiltInboxQuery> {
  const and: Prisma.ConversationWhereInput[] = [
    { workspaceId, instagramAccountId },
  ];

  if (filters.q) {
    const q = filters.q.trim();
    if (q) {
      and.push({
        OR: [
          { contactUsername: { contains: q, mode: "insensitive" } },
          // Searching the id too: a thread whose handle is not known yet is
          // otherwise unreachable by search.
          { contactId: { contains: q } },
          { messages: { some: { text: { contains: q, mode: "insensitive" } } } },
        ],
      });
    }
  }

  if (filters.from || filters.to) {
    // Deliberately "has a message in the period" rather than "last message
    // falls in the period": a thread that was active last week and again today
    // belongs in last week's results too.
    and.push({
      messages: {
        some: {
          sentAt: {
            ...(filters.from ? { gte: filters.from } : {}),
            // `to` is the start of the day after the one picked, so the
            // comparison is exclusive — a half-open window needs no
            // 23:59:59.999 fudge and stays right across a clock change.
            ...(filters.to ? { lt: filters.to } : {}),
          },
        },
      },
    });
  }

  if (filters.state === "awaiting_reply") {
    // The last thing said came from them. lastMessageFromMe is maintained on
    // every write, so this needs no subquery.
    and.push({ lastMessageFromMe: false });
  }

  if (filters.state === "in_requests") {
    // Only meaningful once they have written: an outbound-only thread is not
    // sitting in anyone's requests folder.
    and.push({ weFollowContact: false });
    and.push({ messages: { some: { fromMe: false } } });
  }

  if (filters.state === "follows_us") {
    and.push({ contactFollowsUs: true });
  }

  if (filters.state === "delivered_unread") {
    // We sent something, and Instagram has never reported a read for anything
    // in the thread.
    and.push({ messages: { some: { fromMe: true } } });
    and.push({ messages: { none: { fromMe: true, readAt: { not: null } } } });
  }

  const contactIds = await contactIdsForAutomationFilters(filters);
  if (contactIds !== null) {
    and.push(
      filters.automationId === "none"
        ? { contactId: { notIn: contactIds } }
        : { contactId: { in: contactIds } }
    );
  }

  return { where: { AND: and } };
}

export interface ThreadAutomation {
  id: string;
  name: string;
  status: string;
  matchedKeyword: string | null;
  sentAt: Date | null;
}

/**
 * Which automation reached each of these contacts, if any.
 *
 * Looked up in one query for the whole page rather than per row. Where a
 * contact was reached more than once, the most recent one is kept — that is
 * the campaign the conversation most likely came from.
 */
export async function automationsForContacts(
  contactIds: string[]
): Promise<Map<string, ThreadAutomation>> {
  if (contactIds.length === 0) return new Map();

  const logs = await prisma.dmLog.findMany({
    where: { commenterId: { in: contactIds } },
    orderBy: { createdAt: "desc" },
    select: {
      commenterId: true,
      status: true,
      matchedKeyword: true,
      dmSentAt: true,
      automation: { select: { id: true, name: true } },
    },
  });

  const byContact = new Map<string, ThreadAutomation>();
  for (const log of logs) {
    if (byContact.has(log.commenterId)) continue;
    byContact.set(log.commenterId, {
      id: log.automation.id,
      name: log.automation.name,
      status: log.status,
      matchedKeyword: log.matchedKeyword,
      sentAt: log.dmSentAt,
    });
  }
  return byContact;
}

/** The automations and keywords present in the data, to populate the filters. */
export async function inboxFilterOptions(instagramAccountId: string): Promise<{
  automations: Array<{ id: string; name: string }>;
  keywords: string[];
}> {
  const [automations, keywords] = await Promise.all([
    prisma.automation.findMany({
      where: { instagramAccountId },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true },
    }),
    prisma.dmLog.findMany({
      where: { instagramAccountId, matchedKeyword: { not: null } },
      distinct: ["matchedKeyword"],
      select: { matchedKeyword: true },
    }),
  ]);

  return {
    automations,
    keywords: keywords
      .map((k) => k.matchedKeyword)
      .filter((k): k is string => Boolean(k))
      .sort(),
  };
}
