/**
 * Whether Meta still lets us write to someone.
 *
 * Standard messaging closes 24 hours after the contact's last action. Up to
 * 7 days a message may carry the HUMAN_AGENT tag, which says a person is
 * answering by hand — true of anything triggered from an open thread, and not
 * a way around the window for automation. After that there is no route to
 * them at all, in this tool or any other.
 *
 * Shared by the inbox and the endpoint behind it so both draw the same line:
 * the UI to say what is about to happen, the server to decide it.
 */

const HOUR_MS = 60 * 60 * 1000;
export const STANDARD_WINDOW_MS = 24 * HOUR_MS;
export const HUMAN_AGENT_WINDOW_MS = 7 * 24 * HOUR_MS;

export type ReachState = "open" | "human_agent" | "closed";

export function reachState(
  lastInboundAt: Date | string | null | undefined,
  now: Date = new Date()
): ReachState {
  if (!lastInboundAt) return "closed";

  const at = lastInboundAt instanceof Date ? lastInboundAt : new Date(lastInboundAt);
  if (Number.isNaN(at.getTime())) return "closed";

  const age = now.getTime() - at.getTime();
  // A timestamp in the future would be Meta's clock or ours being off; treat
  // it as freshly active rather than refusing to send.
  if (age < STANDARD_WINDOW_MS) return "open";
  if (age < HUMAN_AGENT_WINDOW_MS) return "human_agent";
  return "closed";
}

/** The contact's last message in a thread, whatever shape the caller has. */
export function lastInboundAt(
  messages: Array<{ fromMe: boolean; createdTime?: string | null }>
): string | null {
  const theirs = messages.filter((m) => !m.fromMe && m.createdTime);
  return theirs[theirs.length - 1]?.createdTime ?? null;
}
