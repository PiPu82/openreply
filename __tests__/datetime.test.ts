/**
 * The regression these guard against: a DM log entry written at
 * 2026-08-23T22:30:12Z was shown as "Aug 24, 12:30 AM" and read as midday.
 * It happened twice over — an en-US locale in a German dashboard, and a
 * process running in UTC deciding where a day begins.
 */
import { describe, expect, it, afterEach } from "vitest";
import {
  addDays,
  formatDate,
  formatDateShort,
  formatDateTime,
  formatDateTimeShort,
  formatNumber,
  formatTime,
  formatWeekdayShort,
  startOfDay,
  startOfMonth,
  toDateKey,
} from "@/lib/utils/datetime";

/** ICU likes narrow no-break spaces; they are noise for these assertions. */
const plain = (s: string) => s.replace(/[  ]/g, " ");

// The real entry, kept verbatim.
const DIRK = new Date("2026-08-23T22:30:12.952Z");

describe("formatting", () => {
  it("renders the DM log entry as half past midnight, not half past noon", () => {
    expect(plain(formatDateTime(DIRK))).toBe("24.08.2026, 00:30");
  });

  it("never emits AM/PM", () => {
    for (const value of [DIRK, new Date("2026-08-24T10:30:00Z"), new Date("2026-01-15T23:30:00Z")]) {
      const rendered = `${formatDateTime(value)} ${formatDateTimeShort(value)} ${formatTime(value)}`;
      expect(rendered).not.toMatch(/AM|PM/i);
    }
  });

  it("keeps the day in the short form too", () => {
    const short = plain(formatDateTimeShort(DIRK));
    expect(short).toMatch(/^24\./);
    expect(short).toContain("00:30");
  });

  it("shifts summer time by two hours and winter time by one", () => {
    expect(formatTime(new Date("2026-08-24T10:30:00Z"))).toBe("12:30");
    expect(formatTime(new Date("2026-01-15T10:30:00Z"))).toBe("11:30");
  });

  it("rolls the date over at German midnight, not UTC midnight", () => {
    expect(formatDate(new Date("2026-08-23T21:59:00Z"))).toBe("23.08.2026");
    expect(formatDate(new Date("2026-08-23T22:01:00Z"))).toBe("24.08.2026");
  });

  it("writes dates German-style", () => {
    expect(formatDate(new Date("2026-08-24T12:00:00Z"))).toBe("24.08.2026");
    expect(plain(formatDateShort(new Date("2026-08-24T12:00:00Z")))).toMatch(/^24\./);
    expect(formatWeekdayShort(new Date("2026-08-24T12:00:00Z"))).toMatch(/^Mo/);
    expect(formatNumber(1234567)).toBe("1.234.567");
  });
});

describe("day boundaries", () => {
  it("puts the start of the day at 22:00 UTC in summer", () => {
    expect(startOfDay(DIRK).toISOString()).toBe("2026-08-23T22:00:00.000Z");
  });

  it("puts it at 23:00 UTC in winter", () => {
    expect(startOfDay(new Date("2026-01-15T23:30:00Z")).toISOString()).toBe(
      "2026-01-15T23:00:00.000Z"
    );
  });

  it("counts an entry from 00:30 towards that day, not the one before", () => {
    // The bug in the daily chart: with UTC boundaries the entry fell into
    // the 23rd, because a UTC day only turns over at 02:00 German time.
    const dayStart = startOfDay(DIRK);
    const dayEnd = addDays(dayStart, 1);
    expect(DIRK >= dayStart && DIRK < dayEnd).toBe(true);
    expect(toDateKey(DIRK)).toBe("2026-08-24");
  });

  it("starts the month at German midnight", () => {
    expect(startOfMonth(DIRK).toISOString()).toBe("2026-07-31T22:00:00.000Z");
  });
});

describe("calendar arithmetic across a clock change", () => {
  // Summer time began on 29.03.2026; that day is 23 hours long.
  it("adds calendar days, not 24-hour blocks", () => {
    const before = startOfDay(new Date("2026-03-28T12:00:00Z"));
    expect(before.toISOString()).toBe("2026-03-27T23:00:00.000Z");
    expect(addDays(before, 1).toISOString()).toBe("2026-03-28T23:00:00.000Z");
    // Naive +24h would land at 23:00Z — an hour into the wrong day.
    expect(addDays(before, 2).toISOString()).toBe("2026-03-29T22:00:00.000Z");
  });

  it("steps back over the autumn change as well", () => {
    // Summer time ended on 25.10.2026.
    const after = startOfDay(new Date("2026-10-26T12:00:00Z"));
    expect(after.toISOString()).toBe("2026-10-25T23:00:00.000Z");
    expect(addDays(after, -1).toISOString()).toBe("2026-10-24T22:00:00.000Z");
  });

  it("normalises across month ends", () => {
    expect(toDateKey(addDays(new Date("2026-08-31T12:00:00Z"), 1))).toBe("2026-09-01");
  });
});

describe("independence from the process zone", () => {
  const original = process.env.TZ;
  afterEach(() => {
    process.env.TZ = original;
  });

  it("renders the same in New York, Tokyo or UTC", () => {
    // The containers run in UTC, a laptop does not. Neither may change what
    // Sophie reads.
    const seen = new Set<string>();
    for (const zone of ["UTC", "America/New_York", "Asia/Tokyo", "Europe/Berlin"]) {
      process.env.TZ = zone;
      seen.add(plain(formatDateTime(DIRK)));
      seen.add(startOfDay(DIRK).toISOString());
    }
    expect([...seen].sort()).toEqual(["2026-08-23T22:00:00.000Z", "24.08.2026, 00:30"]);
  });
});
