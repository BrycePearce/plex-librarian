import { assertEquals } from "@std/assert";
import { hourInTimeZone, nextScheduledInstant, scheduleWindowKey } from "@shared/schedule";

Deno.test("hourInTimeZone resolves IANA zones independently of the process timezone", () => {
  const instant = new Date("2026-01-01T00:00:00Z");
  assertEquals(hourInTimeZone(instant, "UTC"), 0);
  assertEquals(hourInTimeZone(instant, "America/Los_Angeles"), 16);
});

Deno.test("nextScheduledInstant finds the next local schedule hour", () => {
  const next = nextScheduledInstant(
    new Date("2026-01-01T10:30:00Z"),
    3,
    "America/Los_Angeles",
  );
  assertEquals(next.toISOString(), "2026-01-01T11:00:00.000Z");
});

Deno.test("nextScheduledInstant handles non-integral UTC offsets", () => {
  const next = nextScheduledInstant(
    new Date("2026-01-01T20:40:00Z"),
    3,
    "Asia/Kolkata",
  );
  assertEquals(next.toISOString(), "2026-01-01T21:30:00.000Z");
});

Deno.test("nextScheduledInstant skips a nonexistent daylight-saving hour", () => {
  const next = nextScheduledInstant(
    new Date("2026-03-08T09:00:00Z"),
    2,
    "America/Los_Angeles",
  );
  assertEquals(next.toISOString(), "2026-03-09T09:00:00.000Z");
});

Deno.test("nextScheduledInstant returns an eligible instant within the current hour", () => {
  const eligibleAt = new Date("2026-01-01T11:30:00Z");
  const next = nextScheduledInstant(eligibleAt, 3, "America/Los_Angeles");
  assertEquals(next.toISOString(), eligibleAt.toISOString());
});

Deno.test("scheduleWindowKey treats both fall-back occurrences as one window", () => {
  const first = new Date("2026-11-01T08:30:00Z");
  const second = new Date("2026-11-01T09:30:00Z");
  assertEquals(
    scheduleWindowKey(first, "America/Los_Angeles"),
    scheduleWindowKey(second, "America/Los_Angeles"),
  );
});
