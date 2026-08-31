"use client";

import { useState } from "react";

/**
 * The pictures in the inbox: who a thread is with, and what they sent.
 *
 * Both are served from our own routes rather than Instagram's CDN. Meta hands
 * out signed links that expire, so an <img> pointed at one works today and
 * shows a broken frame next week — see `lib/inbox/media`.
 */

/** Initials for someone with no picture. Two letters, from their handle. */
function initials(label: string): string {
  const cleaned = label.replace(/^@/, "").trim();
  if (!cleaned) return "?";
  const parts = cleaned.split(/[._\s-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return cleaned.slice(0, 2).toUpperCase();
}

export function ContactAvatar({
  conversationId,
  hasAvatar,
  label,
  size = 36,
}: {
  conversationId: string;
  hasAvatar: boolean;
  /** The handle as shown, or the raw id when there is none. */
  label: string;
  size?: number;
}) {
  // A stored picture can still fail to render — a half-written file, a type the
  // browser will not decode. Falling back to initials keeps the row intact
  // instead of leaving a broken-image icon in the list.
  const [failed, setFailed] = useState(false);
  const dimension = { width: size, height: size };

  if (hasAvatar && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/api/inbox/avatar/${conversationId}`}
        alt=""
        width={size}
        height={size}
        style={dimension}
        onError={() => setFailed(true)}
        className="shrink-0 rounded-full object-cover"
      />
    );
  }

  return (
    <span
      style={dimension}
      className="grid shrink-0 place-items-center rounded-full bg-surface-hover text-[11px] font-medium text-muted"
      aria-hidden="true"
    >
      {initials(label)}
    </span>
  );
}

export interface MessageAttachmentInfo {
  type: string;
  mimeType: string;
}

/**
 * The file that came with a message.
 *
 * Renders nothing for a type there is no sensible player for — the message
 * keeps its "[Datei]" caption in that case, which is more use than an empty
 * box.
 */
export function MessageMedia({
  messageId,
  attachment,
}: {
  messageId: string;
  attachment: MessageAttachmentInfo;
}) {
  const [failed, setFailed] = useState(false);
  const src = `/api/inbox/attachment/${messageId}`;

  if (failed) return null;

  if (attachment.type === "image") {
    return (
      <a href={src} target="_blank" rel="noreferrer" className="block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt="Gesendetes Bild"
          onError={() => setFailed(true)}
          className="max-h-72 max-w-full rounded-md object-contain"
        />
      </a>
    );
  }

  if (attachment.type === "video") {
    return (
      <video
        src={src}
        controls
        preload="metadata"
        onError={() => setFailed(true)}
        className="max-h-72 max-w-full rounded-md"
      />
    );
  }

  if (attachment.type === "audio") {
    return (
      <audio
        src={src}
        controls
        preload="metadata"
        onError={() => setFailed(true)}
        className="w-56 max-w-full"
      />
    );
  }

  return null;
}

/** Whether {@link MessageMedia} will put something on screen. */
export function rendersMedia(attachment: MessageAttachmentInfo | null | undefined): boolean {
  return (
    attachment?.type === "image" ||
    attachment?.type === "video" ||
    attachment?.type === "audio"
  );
}
