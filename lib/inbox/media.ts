import { prisma } from "@/lib/db/client";

/**
 * Fetching and storing the files Instagram will not keep for us.
 *
 * Every media URL Meta hands over — a message attachment, a profile picture —
 * is a signed CDN link with an expiry. Storing the address means storing
 * something that stops working, and stops working *silently*: no error, just
 * an image that quietly fails to load weeks later. So the bytes come across
 * once, at the only moment they are reachable, and are served from here after.
 */

/**
 * Refuse anything larger than this.
 *
 * A voice note is tens of kilobytes and a phone photo a few megabytes, but a
 * video has no such ceiling. The placeholder text stays either way, so a
 * refused file costs a preview, never the message.
 */
export const MAX_MEDIA_BYTES = 12 * 1024 * 1024;

/** Profile pictures change; refresh one once it is this old. */
export const AVATAR_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface FetchedMedia {
  /// Uint8Array rather than Buffer, and pinned to ArrayBuffer: that is the
  /// exact shape Prisma's Bytes column accepts.
  data: Uint8Array<ArrayBuffer>;
  mimeType: string;
  byteSize: number;
}

/**
 * Download a media file, or return null and let the caller carry on.
 *
 * Null is the ordinary outcome, not an error worth failing a job over: an
 * expired link, a file too big, a type we would not render. All of them leave
 * the message exactly as it reads today.
 */
export async function fetchMedia(url: string): Promise<FetchedMedia | null> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) return null;

  // Trust the header only to reject early — it can lie or be absent, so the
  // real check is the body length below.
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_MEDIA_BYTES) return null;

  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength === 0 || data.byteLength > MAX_MEDIA_BYTES) return null;

  const mimeType = (response.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim();

  return {
    data,
    mimeType: mimeType || "application/octet-stream",
    byteSize: data.byteLength,
  };
}

/**
 * Store an attachment against the message it arrived with.
 *
 * Idempotent: a redelivered webhook or a replayed backfill writes the same
 * file over itself rather than a second copy.
 */
export async function storeAttachment(params: {
  mid: string;
  type: string;
  media: FetchedMedia;
}): Promise<boolean> {
  const message = await prisma.message.findUnique({
    where: { mid: params.mid },
    select: { id: true, workspaceId: true },
  });
  // The message may not be written yet, or may have aged out of retention.
  if (!message) return false;

  const { data, mimeType, byteSize } = params.media;
  await prisma.messageAttachment.upsert({
    where: { messageId: message.id },
    create: {
      messageId: message.id,
      workspaceId: message.workspaceId,
      type: params.type,
      mimeType,
      data,
      byteSize,
    },
    update: { type: params.type, mimeType, data, byteSize, fetchedAt: new Date() },
  });
  return true;
}

/** Store a contact's profile picture against their thread. */
export async function storeAvatar(params: {
  conversationId: string;
  workspaceId: string;
  media: FetchedMedia;
}): Promise<void> {
  const { data, mimeType, byteSize } = params.media;
  await prisma.contactAvatar.upsert({
    where: { conversationId: params.conversationId },
    create: {
      conversationId: params.conversationId,
      workspaceId: params.workspaceId,
      mimeType,
      data,
      byteSize,
    },
    update: { mimeType, data, byteSize, fetchedAt: new Date() },
  });
}
