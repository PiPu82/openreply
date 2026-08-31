import { prisma } from "@/lib/db/client";
import { getUserMedia, type InstagramMedia } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";

/**
 * Binds "next post" campaigns to a real post.
 *
 * Instagram sends no webhook when a media is published, so the binding has two
 * triggers, both of which land here: a short-interval cron, and the first
 * comment arriving on the new post (see `processComment`). Whoever gets there
 * first wins; the work is idempotent.
 */

/** How far back to look for the campaign's post. Well past a day of posting. */
const MEDIA_LOOKBACK = 25;

/**
 * Media a comment trigger can fire on.
 *
 * Anything but a story qualifies — feed posts, carousels and reels all carry
 * comments. The campaign builder promises "the next post or reel", so limiting
 * this to `REELS` (as it once did) left every plain feed post unbound and the
 * campaign waiting forever.
 *
 * `/me/media` does not return stories at all, so the check is a belt-and-braces
 * guard: binding to one would burn the campaign's single "next post" slot on
 * something nobody can comment under.
 */
export function isAttachable(media: InstagramMedia): boolean {
  return media.media_product_type !== "STORY";
}

export interface AttachResult {
  /** Campaigns that were waiting for a post. */
  checked: number;
  /** Campaigns bound to a post by this run. */
  bound: number;
  /** Accounts whose media could not be fetched. */
  failedAccounts: string[];
}

/**
 * Bind every campaign waiting for its creator's next post.
 *
 * Pass `instagramId` to limit the work to one connected account — the comment
 * path knows which account it is handling and has no reason to poll the others.
 *
 * Costs nothing when no campaign is waiting: the account loop never runs, so
 * there is no Graph call.
 */
export async function attachPendingCampaigns(scope?: {
  instagramId?: string;
}): Promise<AttachResult> {
  const pending = await prisma.automation.findMany({
    where: {
      pendingNextReel: true,
      ...(scope?.instagramId
        ? { instagramAccount: { instagramId: scope.instagramId } }
        : {}),
    },
    include: { instagramAccount: true },
  });

  // Group by connected account so we fetch each account's media only once.
  const byAccount = new Map<
    string,
    {
      account: (typeof pending)[number]["instagramAccount"];
      automations: typeof pending;
    }
  >();
  for (const automation of pending) {
    const entry = byAccount.get(automation.instagramAccountId);
    if (entry) entry.automations.push(automation);
    else
      byAccount.set(automation.instagramAccountId, {
        account: automation.instagramAccount,
        automations: [automation],
      });
  }

  let bound = 0;
  let checked = 0;
  const failedAccounts: string[] = [];

  for (const { account, automations } of byAccount.values()) {
    checked += automations.length;
    if (!account?.accessToken) continue;

    let media: InstagramMedia[];
    try {
      const token = decryptToken(account.accessToken);
      const fetched = await getUserMedia(token, MEDIA_LOOKBACK);
      media = fetched
        .filter(isAttachable)
        .sort(
          (a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );
    } catch (error) {
      failedAccounts.push(account.id);
      console.error("[attach-next-post] media fetch failed", account.id, error);
      continue;
    }

    for (const automation of automations) {
      // The "next" post = the earliest one published after the campaign was
      // created. Earliest, not newest: if two posts went out before this ran,
      // the campaign belongs to the one the creator meant it for.
      const nextPost = media.find(
        (item) => new Date(item.timestamp) > automation.createdAt
      );
      if (!nextPost) continue;

      await prisma.automation.update({
        where: { id: automation.id },
        data: {
          postId: nextPost.id,
          postUrl: nextPost.permalink ?? null,
          pendingNextReel: false,
        },
      });
      bound += 1;
    }
  }

  return { checked, bound, failedAccounts };
}
