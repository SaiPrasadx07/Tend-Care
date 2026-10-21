import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, daysBetween, formatTime12, isYMD, zonedParts, zonedToUtc } from "../src/domain/time.ts";

test("zonedToUtc round-trips wall-clock times", () => {
  for (const tz of ["America/Los_Angeles", "Asia/Kolkata", "Europe/London", "UTC"]) {
    for (const [d, t] of [["2026-10-21", "08:00"], ["2026-01-15", "23:30"], ["2026-07-04", "00:00"]] as const) {
      const utc = zonedToUtc(d, t, tz);
      const back = zonedParts(utc, tz);
      assert.equal(back.date, d, `${tz} ${d} ${t}`);
      assert.equal(back.time, t, `${tz} ${d} ${t}`);
    }
  }
});

test("zonedToUtc handles DST transitions (US spring forward / fall back)", () => {
  // 2026-03-08: clocks jump 02:00 -> 03:00 in Los Angeles; 08:00 is PDT (UTC-7).
  assert.equal(zonedToUtc("2026-03-08", "08:00", "America/Los_Angeles").toISOString(), "2026-03-08T15:00:00.000Z");
  // 2026-11-01: back to PST (UTC-8).
  assert.equal(zonedToUtc("2026-11-01", "08:00", "America/Los_Angeles").toISOString(), "2026-11-01T16:00:00.000Z");
  // Kolkata has a half-hour offset and no DST.
  assert.equal(zonedToUtc("2026-10-21", "08:00", "Asia/Kolkata").toISOString(), "2026-10-21T02:30:00.000Z");
});

test("date helpers", () => {
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(daysBetween("2026-10-15", "2026-10-21"), 6);
  assert.equal(formatTime12("00:05"), "12:05 AM");
  assert.equal(formatTime12("12:00"), "12:00 PM");
  assert.equal(formatTime12("20:30"), "8:30 PM");
  assert.ok(isYMD("2026-10-21"));
  assert.ok(!isYMD("2026-02-30"));
  assert.ok(!isYMD("21-10-2026"));
});
