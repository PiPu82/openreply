/**
 * Dates, times and numbers for a German audience.
 *
 * Every timestamp we store is UTC. Two things then have to be decided
 * explicitly, and both used to be left to whatever machine happened to run
 * the code:
 *
 *   1. The locale. `toLocaleString("en-US", …)` renders 00:30 as "12:30 AM",
 *      which a German reader parses as half past noon. A log entry from
 *      00:30 was misread as midday — that is what this module exists for.
 *   2. The zone. Node uses the process zone, and our containers run in UTC.
 *      Anything derived from "today" was therefore a UTC day: it began at
 *      02:00 German time, so the first two hours of every night counted
 *      towards the day before.
 *
 * So both are pinned here, in one place, for server and browser alike.
 * Never reach for `toLocaleString` / `toLocaleDateString` /
 * `toLocaleTimeString` directly — ESLint rejects them for this reason.
 *
 * The zone is a constant on purpose and not an env var: `NEXT_PUBLIC_*`
 * values are baked in at build time, so a missing build arg would silently
 * put the browser back on UTC.
 */

export const APP_TIME_ZONE = "Europe/Berlin";
export const APP_LOCALE = "de-DE";

type DateInput = Date | string | number;

function toDate(value: DateInput): Date {
  return value instanceof Date ? value : new Date(value);
}

function formatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(APP_LOCALE, {
    timeZone: APP_TIME_ZONE,
    // h23 rather than `hour12: false`: the latter renders midnight as "24:00"
    // on some runtimes.
    hourCycle: "h23",
    ...options,
  });
}

/** "24.08.2026, 00:30" — the full stamp, for logs and detail views. */
export function formatDateTime(value: DateInput): string {
  return formatter({
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(toDate(value));
}

/** "24. Aug., 00:30" — compact, for table columns. */
export function formatDateTimeShort(value: DateInput): string {
  return formatter({
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(toDate(value));
}

/** "24.08.2026" */
export function formatDate(value: DateInput): string {
  return formatter({ day: "2-digit", month: "2-digit", year: "numeric" }).format(toDate(value));
}

/** "24. Aug." */
export function formatDateShort(value: DateInput): string {
  return formatter({ day: "numeric", month: "short" }).format(toDate(value));
}

/** "00:30" */
export function formatTime(value: DateInput): string {
  return formatter({ hour: "2-digit", minute: "2-digit" }).format(toDate(value));
}

/** "Mo" — chart axis labels. */
export function formatWeekdayShort(value: DateInput): string {
  return formatter({ weekday: "short" }).format(toDate(value));
}

/**
 * "1.234" — German grouping. Lives here so the ESLint ban on `toLocale*`
 * can be absolute instead of "except for numbers".
 */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat(APP_LOCALE).format(value);
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock reading in APP_TIME_ZONE for an instant. */
function zonedParts(value: Date): ZonedParts {
  const parts = formatter({
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(value);

  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/** Offset of APP_TIME_ZONE at a given instant, in milliseconds. */
function zoneOffsetMs(value: Date): number {
  const p = zonedParts(value);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Milliseconds survive the round trip; formatToParts drops them.
  return asUtc - (value.getTime() - value.getMilliseconds());
}

/**
 * A wall-clock reading in APP_TIME_ZONE turned back into an instant.
 * Out-of-range fields are normalised by Date.UTC, so `day + 1` on the 31st
 * lands on the 1st.
 */
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  // The offset has to be read at the instant we are actually landing on, so
  // resolve it twice — the first guess can sit on the wrong side of a DST
  // switch and would otherwise be an hour off.
  const first = guess - zoneOffsetMs(new Date(guess));
  return new Date(guess - zoneOffsetMs(new Date(first)));
}

/** Midnight German time, as an instant. */
export function startOfDay(value: DateInput = new Date()): Date {
  const p = zonedParts(toDate(value));
  return zonedTimeToUtc(p.year, p.month, p.day);
}

/** First of the month, German time. */
export function startOfMonth(value: DateInput = new Date()): Date {
  const p = zonedParts(toDate(value));
  return zonedTimeToUtc(p.year, p.month, 1);
}

/**
 * Calendar-day arithmetic, not 24-hour arithmetic: the days on which the
 * clocks change are 23 or 25 hours long, and adding 86_400_000 ms would
 * drift the boundary into the previous or next day.
 */
export function addDays(value: DateInput, days: number): Date {
  const p = zonedParts(toDate(value));
  return zonedTimeToUtc(p.year, p.month, p.day + days, p.hour, p.minute, p.second);
}

/** "2026-08-24" in German time — for keying daily buckets. */
export function toDateKey(value: DateInput): string {
  const p = zonedParts(toDate(value));
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
