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
 * The only content types we will ever store, and therefore ever serve.
 *
 * This is a security boundary, not a tidiness rule. The type arrives in a
 * header on a file a stranger sent, and whatever is stored is later served
 * back from our own origin — the same origin the dashboard session lives on.
 * A file served as something the browser will execute is a script running as
 * the logged-in user.
 *
 * `image/svg+xml` is absent on purpose: an SVG is a document that can carry
 * <script>, not a picture. So are text/* and anything unrecognised.
 */
const ALLOWED_MIME_TYPES: Record<string, ReadonlySet<string>> = {
  image: new Set([
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/heic",
    "image/heif",
  ]),
  video: new Set([
    "video/mp4",
    "video/quicktime",
    "video/webm",
    "video/3gpp",
  ]),
  audio: new Set([
    "audio/mpeg",
    "audio/mp4",
    "audio/aac",
    "audio/ogg",
    "audio/webm",
    "audio/amr",
    "audio/x-m4a",
  ]),
};

/** Whether a stored type is one we are willing to hand back to a browser. */
export function isAllowedMimeType(kind: string, mimeType: string): boolean {
  return ALLOWED_MIME_TYPES[kind]?.has(mimeType) ?? false;
}

/**
 * Read a response body, giving up the moment it grows past the limit.
 *
 * Not `arrayBuffer()`: that buffers the whole thing first and checks the size
 * afterwards, which is no limit at all. The worker runs under a 220 MB cap, so
 * a response that lies about its length — or declares none — could take it
 * down. Reading in chunks means an oversized file costs a few kilobytes and a
 * cancelled connection.
 */
async function readCapped(
  response: Response,
  max: number
): Promise<Uint8Array<ArrayBuffer> | null> {
  const body = response.body;
  if (!body) return null;

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }

  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Redirect hops to follow. Meta's CDN uses one or two; three is slack. */
const MAX_REDIRECTS = 3;

/**
 * Whether a host is somewhere we are willing to send a request.
 *
 * Blocks the addresses that make an SSRF worth attempting: loopback, the
 * link-local range that serves cloud metadata, and the private ranges where
 * the rest of this droplet lives — Postgres and Redis included.
 */
function isPublicHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();

  if (host === "localhost" || host.endsWith(".localhost")) return false;
  // IPv6 loopback and the v4-mapped forms of everything below.
  if (host === "::1" || host.startsWith("::ffff:")) return false;
  // Unique-local and link-local IPv6.
  if (/^f[cd]/.test(host) || host.startsWith("fe80:")) return false;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return true;

  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 127 || a === 0 || a === 10) return false;
  if (a === 169 && b === 254) return false; // cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  return true;
}

/** A url we are willing to fetch: https, and not pointed inwards. */
function isFetchableUrl(candidate: string, base?: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(candidate, base);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (!isPublicHost(parsed.hostname)) return null;
  return parsed;
}

/**
 * Download a media file, or return null and let the caller carry on.
 *
 * Null is the ordinary outcome, not an error worth failing a job over: an
 * expired link, a file too big, a type we refuse to serve. All of them leave
 * the message exactly as it reads today.
 *
 * `kind` is what the message said the file is, and decides which content types
 * are acceptable — a "photo" that arrives as an SVG is refused rather than
 * stored under a type the browser would execute.
 *
 * Redirects are followed by hand rather than by fetch. The url comes out of a
 * signature-verified webhook, so this is depth rather than the only line — but
 * `redirect: "follow"` would check only the first hop, and a redirect to an
 * internal address is exactly what makes a fetch-by-url worth attacking.
 */
export async function fetchMedia(
  url: string,
  kind: string
): Promise<FetchedMedia | null> {
  let target = isFetchableUrl(url);
  if (!target) return null;

  let response: Response | null = null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const current: Response = await fetch(target.toString(), {
      redirect: "manual",
    });

    if (current.status < 300 || current.status >= 400) {
      response = current;
      break;
    }

    const location = current.headers.get("location");
    if (!location) return null;
    const next = isFetchableUrl(location, target.toString());
    if (!next) return null;
    target = next;
  }

  if (!response || !response.ok) return null;

  // Reject early where the server is honest about the size; readCapped is what
  // holds when it is not.
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_MEDIA_BYTES) return null;

  const mimeType = (response.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!isAllowedMimeType(kind, mimeType)) return null;

  const data = await readCapped(response, MAX_MEDIA_BYTES);
  if (!data || data.byteLength === 0) return null;

  return { data, mimeType, byteSize: data.byteLength };
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
