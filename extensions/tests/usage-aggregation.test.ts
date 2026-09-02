import assert from "node:assert/strict";
import { test } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { aggregateUsage } from "../usage/index.ts";

// Calendar bucketing depends on the local zone, so pin one with daylight-saving transitions.
process.env.TZ = "America/Los_Angeles";
const HOUR = 60 * 60 * 1000;

function usage(input: number): Usage {
  return {
    input,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistantEntry(
  id: string,
  at: Date,
  input: number,
  content: unknown[] = [],
): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: at.toISOString(),
    message: {
      role: "assistant",
      content,
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: usage(input),
      stopReason: "stop",
      timestamp: at.getTime(),
    },
  } as SessionEntry;
}

function dstAvailable(): boolean {
  return new Date(2026, 2, 9).getTime() - new Date(2026, 2, 8).getTime() === 23 * HOUR;
}

test("keeps calendar-day buckets aligned across the spring-forward transition", (t) => {
  if (!dstAvailable()) return t.skip("runtime time zone changes are unavailable");

  const now = new Date(2026, 2, 10, 12);
  const beforeMidnight = assistantEntry("before", new Date(2026, 2, 8, 23, 30), 10);
  const afterMidnight = assistantEntry("after", new Date(2026, 2, 9, 0, 30), 20);

  const report = aggregateUsage([[beforeMidnight, afterMidnight]], now);
  const shortDay = report.trends.daily7[4];
  const nextDay = report.trends.daily7[5];

  assert.equal(shortDay?.start, new Date(2026, 2, 8).getTime());
  assert.equal(shortDay!.endExclusive - shortDay!.start, 23 * HOUR);
  assert.equal(nextDay?.start, new Date(2026, 2, 9).getTime());
  assert.equal(shortDay?.totals.input, 10);
  assert.equal(nextDay?.totals.input, 20);
});

test("keeps calendar-day buckets aligned across the fall-back transition", (t) => {
  if (!dstAvailable()) return t.skip("runtime time zone changes are unavailable");

  const now = new Date(2026, 10, 3, 12);
  const lateOnLongDay = assistantEntry("late", new Date(2026, 10, 1, 23, 30), 10);
  const nextMorning = assistantEntry("next", new Date(2026, 10, 2, 0, 30), 20);

  const report = aggregateUsage([[lateOnLongDay, nextMorning]], now);
  const longDay = report.trends.daily7[4];

  assert.equal(longDay?.start, new Date(2026, 10, 1).getTime());
  assert.equal(longDay!.endExclusive - longDay!.start, 25 * HOUR);
  assert.equal(longDay?.totals.input, 10);
  assert.equal(report.trends.daily7[5]?.totals.input, 20);

  const onTheDay = aggregateUsage([[lateOnLongDay]], new Date(2026, 10, 1, 23, 45));
  assert.equal(onTheDay.periods.day.start, new Date(2026, 10, 1).getTime());
  assert.equal(onTheDay.periods.day.totals.input, 10);
});

test("builds the trailing trend from the 31st of a month", () => {
  const now = new Date(2026, 0, 31, 12);
  const first = assistantEntry("first", new Date(2026, 0, 2, 8), 10);
  const last = assistantEntry("last", new Date(2026, 0, 31, 11), 20);
  const outside = assistantEntry("outside", new Date(2026, 0, 1, 8), 30);

  const report = aggregateUsage([[first, last, outside]], now);
  const weekly = report.trends.weekly30;

  assert.equal(weekly.length, 5);
  assert.equal(weekly[0]?.start, new Date(2026, 0, 2).getTime());
  assert.equal(weekly[0]?.endExclusive, new Date(2026, 0, 5).getTime());
  assert.equal(weekly[0]?.totals.input, 10);
  assert.equal(weekly[4]?.start, new Date(2026, 0, 26).getTime());
  assert.equal(weekly[4]?.endExclusive, new Date(2026, 1, 1).getTime());
  assert.equal(weekly[4]?.totals.input, 20);
  assert.equal(
    weekly.reduce((sum, bucket) => sum + bucket.totals.input, 0),
    30,
  );
  assert.equal(report.trends.daily7[0]?.start, new Date(2026, 0, 25).getTime());
  assert.equal(report.periods.week.start, new Date(2026, 0, 26).getTime());
  assert.equal(report.periods.month.start, new Date(2026, 0, 1).getTime());
  assert.equal(report.periods.month.totals.input, 60);
});

test("skips entries outside the reporting window before fingerprinting them", () => {
  const now = new Date(2026, 2, 18, 12);
  // Fingerprints serialise message content; a BigInt makes that throw, so it must never run.
  const unserialisable = [{ type: "text", text: 1n }];
  const stale = assistantEntry("stale", new Date(2026, 0, 1, 8), 10, unserialisable);

  const report = aggregateUsage([[stale]], now);

  assert.equal(report.eventCount, 0);
  assert.equal(report.periods.month.totals.input, 0);
});
