/**
 * Messages split into the days they belong to.
 *
 * The bubbles in a thread carried a clock time and nothing else, so a
 * conversation spanning a week read as one long morning. A separator per day
 * answers "when" once for the whole block instead of repeating a date on
 * every line — the same thing Instagram itself does, which matters here
 * because this inbox is read side by side with it.
 *
 * The day is the German one (`toDateKey`), not the UTC one: everything sent
 * between midnight and 02:00 would otherwise sit under the day before.
 */
import { formatDayLabel, toDateKey } from "@/lib/utils/datetime";

export interface DayGroup<T> {
  key: string;
  label: string;
  messages: T[];
}

export function groupMessagesByDay<T extends { createdTime: string | null }>(
  messages: T[],
  now: Date = new Date()
): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];

  for (const message of messages) {
    const d = message.createdTime ? new Date(message.createdTime) : null;
    const key = d && !Number.isNaN(d.getTime()) ? toDateKey(d) : null;

    const last = groups[groups.length - 1];
    // A message without a usable timestamp still has to appear. It joins the
    // group above it rather than opening one of its own — and only opens
    // "Ohne Datum" when it is the first thing in the thread.
    if (last && (key === null || key === last.key)) {
      last.messages.push(message);
      continue;
    }

    groups.push({
      key: key ?? "unbekannt",
      label: d && key ? formatDayLabel(d, now) : "Ohne Datum",
      messages: [message],
    });
  }

  return groups;
}
