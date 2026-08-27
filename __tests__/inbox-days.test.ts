/**
 * A thread showed clock times only, so a message from last Monday read as if
 * it had arrived this morning. These guard the day separators that answer it.
 */
import { describe, expect, it } from "vitest";
import { groupMessagesByDay } from "@/lib/inbox/days";

const NOW = new Date("2026-08-27T09:00:00Z");
const msg = (id: string, createdTime: string | null) => ({ id, createdTime });

describe("groupMessagesByDay", () => {
  it("names today and yesterday instead of dating them", () => {
    const groups = groupMessagesByDay(
      [msg("a", "2026-08-26T14:00:00Z"), msg("b", "2026-08-27T07:30:00Z")],
      NOW
    );
    expect(groups.map((g) => g.label)).toEqual(["Gestern", "Heute"]);
  });

  it("dates anything older, with its weekday", () => {
    const [group] = groupMessagesByDay([msg("a", "2026-08-24T10:00:00Z")], NOW);
    expect(group.label).toBe("Mo., 24.08.2026");
  });

  it("keeps a day's messages together and in order", () => {
    const groups = groupMessagesByDay(
      [
        msg("a", "2026-08-25T08:00:00Z"),
        msg("b", "2026-08-25T20:00:00Z"),
        msg("c", "2026-08-27T06:00:00Z"),
      ],
      NOW
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].messages.map((m) => m.id)).toEqual(["a", "b"]);
    expect(groups[1].messages.map((m) => m.id)).toEqual(["c"]);
  });

  it("splits on the German midnight, not the UTC one", () => {
    // 22:30 UTC is already half past midnight in Berlin: these two belong to
    // different days on screen, though UTC calls them the same one.
    const groups = groupMessagesByDay(
      [msg("a", "2026-08-25T21:00:00Z"), msg("b", "2026-08-25T22:30:00Z")],
      NOW
    );
    expect(groups.map((g) => g.key)).toEqual(["2026-08-25", "2026-08-26"]);
  });

  it("lets a message without a timestamp ride along rather than vanish", () => {
    const groups = groupMessagesByDay(
      [msg("a", "2026-08-27T06:00:00Z"), msg("b", null), msg("c", "nonsense")],
      NOW
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].messages.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("opens an own group when the thread starts without a timestamp", () => {
    const groups = groupMessagesByDay([msg("a", null)], NOW);
    expect(groups[0].label).toBe("Ohne Datum");
  });

  it("has nothing to show for an empty thread", () => {
    expect(groupMessagesByDay([], NOW)).toEqual([]);
  });
});
