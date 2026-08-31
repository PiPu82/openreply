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
