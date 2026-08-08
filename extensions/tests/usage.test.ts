import assert from "node:assert/strict";
import { test } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  aggregateUsage,
  formatTokenCount,
  formatUsageCost,
  type ModelUsage,
  type PeriodUsage,
} from "../usage.ts";

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0, cost = 0): Usage {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function assistantEntry(options: {
  id: string;
  at: Date;
  provider?: string;
  model?: string;
  responseModel?: string;
  usage: Usage;
}): SessionEntry {
  return {
    type: "message",
    id: options.id,
    parentId: null,
    timestamp: options.at.toISOString(),
    message: {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: options.provider ?? "anthropic",
      model: options.model ?? "claude-requested",
      responseModel: options.responseModel,
      usage: options.usage,
      stopReason: "stop",
      timestamp: options.at.getTime(),
    },
  } as SessionEntry;
}

function toolEntry(id: string, at: Date, toolUsage: Usage): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: at.toISOString(),
    message: {
      role: "toolResult",
      toolCallId: `call-${id}`,
      toolName: "nested-agent",
      content: [],
      usage: toolUsage,
      isError: false,
      timestamp: at.getTime(),
    },
  } as SessionEntry;
}

function compactionEntry(id: string, at: Date, compactionUsage: Usage): SessionEntry {
  return {
    type: "compaction",
    id,
    parentId: null,
    timestamp: at.toISOString(),
    summary: "summary",
    firstKeptEntryId: "first",
    tokensBefore: 10_000,
    usage: compactionUsage,
  };
}

function model(period: PeriodUsage, provider: string, modelId: string): ModelUsage {
  const result = period.models.find((item) => item.provider === provider && item.model === modelId);
  assert.ok(result, `missing ${provider}/${modelId}`);
  return result;
}

test("aggregates calendar day, Monday-based week, and month in local time", () => {
  const now = new Date(2026, 2, 18, 12);
  const today = assistantEntry({ id: "today", at: new Date(2026, 2, 18, 8), usage: usage(10, 2) });
  const monday = assistantEntry({
    id: "monday",
    at: new Date(2026, 2, 16, 8),
    usage: usage(20, 3),
  });
  const sunday = assistantEntry({
    id: "sunday",
    at: new Date(2026, 2, 15, 8),
    usage: usage(30, 4),
  });
  const monthStart = assistantEntry({
    id: "month-start",
    at: new Date(2026, 2, 1, 8),
    usage: usage(40, 5),
  });
  const previousMonth = assistantEntry({
    id: "previous-month",
    at: new Date(2026, 1, 28, 8),
    usage: usage(50, 6),
  });

  const report = aggregateUsage([[today, monday, sunday, monthStart, previousMonth]], now);

  assert.equal(report.periods.day.totals.input, 10);
  assert.equal(report.periods.week.totals.input, 30);
  assert.equal(report.periods.month.totals.input, 100);
  assert.equal(report.eventCount, 4);
  assert.equal(report.periods.week.start, new Date(2026, 2, 16).getTime());
  assert.equal(report.periods.month.start, new Date(2026, 2, 1).getTime());
});

test("includes the previous month when the current week crosses a month boundary", () => {
  const now = new Date(2026, 2, 1, 12);
  const previousMonday = assistantEntry({
    id: "previous-monday",
    at: new Date(2026, 1, 23, 8),
    usage: usage(20, 3),
  });

  const report = aggregateUsage([[previousMonday]], now);

  assert.equal(report.periods.week.totals.input, 20);
  assert.equal(report.periods.month.totals.input, 0);
});

test("groups assistant usage by provider and actual response model", () => {
  const now = new Date(2026, 2, 18, 12);
  const entry = assistantEntry({
    id: "response-model",
    at: new Date(2026, 2, 18, 8),
    provider: "openrouter",
    model: "requested-model",
    responseModel: "actual-model",
    usage: usage(100, 25, 10, 5, 1.25),
  });

  const report = aggregateUsage([[entry]], now);
  const actual = model(report.periods.day, "openrouter", "actual-model");

  assert.deepEqual(actual, {
    provider: "openrouter",
    model: "actual-model",
    input: 100,
    output: 25,
    cacheRead: 10,
    cacheWrite: 5,
    cost: 1.25,
  });
  assert.equal(
    report.periods.day.models.some((item) => item.model === "requested-model"),
    false,
  );
});

test("keeps tool and summary usage in an unattributed bucket", () => {
  const now = new Date(2026, 2, 18, 12);
  const at = new Date(2026, 2, 18, 8);
  const report = aggregateUsage(
    [
      [
        toolEntry("tool", at, usage(10, 2, 3, 4, 0.1)),
        compactionEntry("summary", at, usage(5, 1, 0, 0, 0.2)),
      ],
    ],
    now,
  );
  const unattributed = model(report.periods.day, "Unattributed", "Tools / summaries");

  assert.equal(unattributed.input, 15);
  assert.equal(unattributed.output, 3);
  assert.equal(unattributed.cacheRead, 3);
  assert.equal(unattributed.cacheWrite, 4);
  assert.equal(unattributed.cost, 0.30000000000000004);
});

test("deduplicates usage copied into forked and cloned sessions", () => {
  const now = new Date(2026, 2, 18, 12);
  const copied = assistantEntry({
    id: "copied",
    at: new Date(2026, 2, 18, 8),
    usage: usage(100, 20, 0, 0, 0.5),
  });
  const distinct = assistantEntry({
    id: "copied",
    at: new Date(2026, 2, 18, 9),
    usage: usage(50, 10, 0, 0, 0.25),
  });

  const migratedCopy = { ...structuredClone(copied), id: "different-migrated-id" };
  const report = aggregateUsage([[copied], [migratedCopy], [distinct]], now);

  assert.equal(report.periods.day.totals.input, 150);
  assert.equal(report.periods.day.totals.output, 30);
  assert.equal(report.periods.day.totals.cost, 0.75);
  assert.equal(report.eventCount, 2);
  assert.equal(report.deduplicatedEntries, 1);
});

test("formats token and cost totals compactly", () => {
  assert.equal(formatTokenCount(999), "999");
  assert.equal(formatTokenCount(1_500), "1.5k");
  assert.equal(formatTokenCount(1_250_000), "1.25M");
  assert.equal(formatUsageCost(0.00125), "$0.0013");
  assert.equal(formatUsageCost(2.5), "$2.50");
});
