/**
 * The stand-in text a media message carries.
 *
 * Shared, rather than declared twice: the webhook writes these into the
 * thread, and the inbox has to recognise them again to know when a preview
 * makes the words redundant. Dependency-free on purpose — the client bundle
 * imports it, and `lib/meta/webhook` pulls in node:crypto.
 */
export const ATTACHMENT_PLACEHOLDERS: Record<string, string> = {
  image: "[Bild]",
  video: "[Video]",
  audio: "[Sprachnachricht]",
  file: "[Datei]",
  share: "[Geteilter Beitrag]",
  story_mention: "[Story-Erwähnung]",
  ig_reel: "[Reel]",
};

const PLACEHOLDER_TEXTS = new Set([
  ...Object.values(ATTACHMENT_PLACEHOLDERS),
  "[Anhang]",
]);

/**
 * Whether a message says nothing but "there was a file here".
 *
 * Used to drop the caption once the file itself is on screen — "[Bild]" above
 * a picture is noise. Anything the sender actually typed is kept.
 */
export function isAttachmentPlaceholder(text: string): boolean {
  return PLACEHOLDER_TEXTS.has(text.trim());
}

/**
 * The media kind a placeholder stands for — the inverse of the table above.
 *
 * A repair needs this because Meta's own hint is not enough: a voice note
 * comes back under `file_url`, indistinguishable from a document. What the
 * message already says it was is the better answer, and it decides both the
 * player the inbox draws and which content types are acceptable.
 */
const KIND_BY_PLACEHOLDER = new Map(
  Object.entries(ATTACHMENT_PLACEHOLDERS).map(([kind, text]) => [text, kind])
);

export function kindFromPlaceholder(text: string): string | null {
  return KIND_BY_PLACEHOLDER.get(text.trim()) ?? null;
}

/**
 * Every placeholder, for querying on.
 *
 * The repair has to narrow by this in the database, not after fetching a page
 * of rows: almost no message has an attachment, so "newest messages without
 * one" is just the newest messages, and a page of them contains no
 * placeholders at all.
 */
export const ALL_PLACEHOLDERS: string[] = [...KIND_BY_PLACEHOLDER.keys()];
