import assert from "node:assert/strict";
import { test } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  aggregateUsage,
  displayRows,
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

function porterEntry(
  id: string,
  at: Date,
  nested: ReturnType<typeof assistantEntry>[],
  aggregate: Usage,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: at.toISOString(),
    message: {
      role: "toolResult",
      toolCallId: `call-${id}`,
      toolName: "porter",
      content: [],
      details: {
        model: "openai-codex/gpt-5.6-luna:high",
        messages: nested.map((entry) =>
          entry.type === "message" && entry.message.role === "assistant" ? entry.message : null,
        ),
      },
      usage: aggregate,
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

function branchSummaryEntry(id: string, at: Date, summaryUsage: Usage): SessionEntry {
  return {
    type: "branch_summary",
    id,
    parentId: null,
    timestamp: at.toISOString(),
    summary: "branch summary",
    fromId: "from",
    usage: summaryUsage,
  } as SessionEntry;
}

function model(
  period: PeriodUsage,
  provider: string,
  modelId: string,
  source?: string,
): ModelUsage {
  const result = period.models.find(
    (item) => item.provider === provider && item.model === modelId && item.source === source,
  );
  assert.ok(result, `missing ${source ? `${source} · ` : ""}${provider}/${modelId}`);
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
  assert.equal(report.eventCount, 5);
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

test("builds a rolling seven-day trend with empty calendar-day buckets", () => {
  const now = new Date(2026, 2, 18, 12);
  const firstDay = assistantEntry({
    id: "first-day",
    at: new Date(2026, 2, 12, 8),
    usage: usage(10, 2),
  });
  const today = assistantEntry({
    id: "today",
    at: new Date(2026, 2, 18, 8),
    usage: usage(20, 3),
  });
  const beforeRange = assistantEntry({
    id: "before-range",
    at: new Date(2026, 2, 11, 8),
    usage: usage(30, 4),
  });

  const report = aggregateUsage([[firstDay, today, beforeRange]], now);
  const buckets = report.trends.daily7;

  assert.equal(buckets.length, 7);
  assert.equal(buckets[0]?.start, new Date(2026, 2, 12).getTime());
  assert.equal(buckets[0]?.totals.input, 10);
  assert.equal(buckets[1]?.totals.input, 0);
  assert.equal(buckets[6]?.totals.input, 20);
  assert.equal(
    buckets.reduce((sum, bucket) => sum + bucket.totals.input, 0),
    30,
  );
});

test("groups the trailing 30 days into Monday-based weeks clipped to the range", () => {
  const now = new Date(2026, 2, 18, 12);
  const firstPartialWeek = assistantEntry({
    id: "first-partial-week",
    at: new Date(2026, 1, 17, 8),
    usage: usage(10, 2),
  });
  const firstMonday = assistantEntry({
    id: "first-monday",
    at: new Date(2026, 1, 23, 8),
    usage: usage(20, 3),
  });
  const currentWeek = assistantEntry({
    id: "current-week",
    at: new Date(2026, 2, 16, 8),
    usage: usage(30, 4),
  });

  const report = aggregateUsage([[firstPartialWeek, firstMonday, currentWeek]], now);
  const buckets = report.trends.weekly30;

  assert.equal(buckets.length, 5);
  assert.equal(buckets[0]?.start, new Date(2026, 1, 17).getTime());
  assert.equal(buckets[0]?.endExclusive, new Date(2026, 1, 23).getTime());
  assert.equal(buckets[0]?.totals.input, 10);
  assert.equal(buckets[1]?.start, new Date(2026, 1, 23).getTime());
  assert.equal(buckets[1]?.totals.input, 20);
  assert.equal(buckets[4]?.start, new Date(2026, 2, 16).getTime());
  assert.equal(buckets[4]?.endExclusive, new Date(2026, 2, 19).getTime());
  assert.equal(buckets[4]?.totals.input, 30);
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
    category: "primary",
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

test("attributes Porter usage to its nested provider and model without double-counting", () => {
  const now = new Date(2026, 2, 18, 12);
  const at = new Date(2026, 2, 18, 8);
  const first = assistantEntry({
    id: "porter-first",
    at,
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    usage: usage(100, 20, 30, 0, 0.01),
  });
  const second = assistantEntry({
    id: "porter-second",
    at: new Date(2026, 2, 18, 8, 1),
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    usage: usage(50, 10, 15, 0, 0.005),
  });
  const aggregate = usage(150, 30, 45, 0, 0.015);

  const report = aggregateUsage([[porterEntry("porter", at, [first, second], aggregate)]], now);
  const luna = model(report.periods.day, "openai-codex", "gpt-5.6-luna", "Porter");

  assert.equal(luna.category, "delegated");
  assert.equal(luna.input, 150);
  assert.equal(luna.output, 30);
  assert.equal(luna.cacheRead, 45);
  assert.equal(luna.cost, 0.015);
  assert.equal(report.periods.day.totals.input, 150);
  assert.equal(report.eventCount, 2);
  assert.equal(
    report.periods.day.models.some((item) => item.category === "overhead"),
    false,
  );
});

test("falls back to unattributed Porter usage when nested messages are unavailable", () => {
  const now = new Date(2026, 2, 18, 12);
  const at = new Date(2026, 2, 18, 8);
  const entry = toolEntry("porter-fallback", at, usage(10, 2, 3, 4, 0.1));
  if (entry.type === "message" && entry.message.role === "toolResult") {
    entry.message.toolName = "porter";
    entry.message.details = { model: "openai-codex/gpt-5.6-luna:high", messages: [] };
  }

  const report = aggregateUsage([[entry]], now);
  const unattributed = model(report.periods.day, "", "", "porter");

  assert.equal(unattributed.category, "tool");
  assert.equal(unattributed.input, 10);
  assert.equal(unattributed.cost, 0.1);
});

test("breaks down tool and summary usage by source", () => {
  const now = new Date(2026, 2, 18, 12);
  const at = new Date(2026, 2, 18, 8);
  const report = aggregateUsage(
    [
      [
        toolEntry("tool", at, usage(10, 2, 3, 4, 0.1)),
        compactionEntry("summary", at, usage(5, 1, 0, 0, 0.2)),
        branchSummaryEntry("branch", at, usage(3, 1, 0, 0, 0.05)),
      ],
    ],
    now,
  );
  const tool = model(report.periods.day, "", "", "nested-agent");
  const compaction = model(report.periods.day, "", "", "Compaction");
  const branchSummary = model(report.periods.day, "", "", "Branch summary");

  assert.equal(tool.category, "tool");
  assert.equal(tool.input, 10);
  assert.equal(tool.output, 2);
  assert.equal(tool.cacheRead, 3);
  assert.equal(tool.cacheWrite, 4);
  assert.equal(tool.cost, 0.1);
  assert.equal(compaction.category, "overhead");
  assert.equal(compaction.input, 5);
  assert.equal(compaction.output, 1);
  assert.equal(compaction.cost, 0.2);
  assert.equal(branchSummary.input, 3);
  assert.equal(branchSummary.output, 1);
  assert.equal(branchSummary.cost, 0.05);
  assert.equal(report.periods.day.totals.cost, 0.35000000000000003);
});

test("renders source-first sections without provider subtotal rows", () => {
  const now = new Date(2026, 2, 18, 12);
  const at = new Date(2026, 2, 18, 8);
  const primary = assistantEntry({
    id: "primary",
    at,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    usage: usage(100, 20, 30, 0, 1),
  });
  const delegated = porterEntry(
    "porter",
    at,
    [
      assistantEntry({
        id: "delegated",
        at,
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        usage: usage(10, 2, 3, 0, 0.01),
      }),
    ],
    usage(10, 2, 3, 0, 0.01),
  );
  const report = aggregateUsage(
    [[primary, delegated, compactionEntry("summary", at, usage(5, 1, 0, 0, 0.2))]],
    now,
  );

  assert.deepEqual(
    displayRows(report.periods.day).map((row) => [row.label, row.heading]),
    [
      ["Primary models", true],
      ["  openai-codex / gpt-5.6-sol", false],
      ["Delegated agents", true],
      ["  Porter · openai-codex / gpt-5.6-luna", false],
      ["Session overhead", true],
      ["  Compaction", false],
    ],
  );
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
