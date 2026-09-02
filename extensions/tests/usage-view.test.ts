import assert from "node:assert/strict";
import { test } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { aggregateUsage, displayRows, formatTokenCount, type PeriodUsage } from "../usage/index.ts";

const now = new Date(2026, 2, 18, 12);
const at = new Date(2026, 2, 18, 8);

function usage(input: number, output: number, cost: number): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function assistantEntry(id: string, model: string, messageUsage: Usage): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: at.toISOString(),
    message: {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "anthropic",
      model,
      usage: messageUsage,
      stopReason: "stop",
      timestamp: at.getTime(),
    },
  } as SessionEntry;
}

function period(models: PeriodUsage["models"]): PeriodUsage {
  return {
    key: "day",
    start: new Date(2026, 2, 18).getTime(),
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    models,
  };
}

function hasControls(text: string): boolean {
  return [...text].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
}

test("strips control characters from usage labels before rendering", () => {
  const rows = displayRows(
    period([
      {
        category: "delegated",
        source: "sub\u0000agent",
        provider: "anthropic\u001b[31m",
        model: "claude\u0085sonnet\u0007\u007f",
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
      },
    ]),
  );

  assert.equal(rows[1]?.label, "  subagent · anthropic[31m / claudesonnet");
  assert.ok(rows.every((item) => !hasControls(item.label)));
});

test("rounds token counts into the next unit instead of printing 1000k", () => {
  assert.equal(formatTokenCount(999_999), "1.00M");
  assert.equal(formatTokenCount(999_999_999), "1.00B");
  assert.equal(formatTokenCount(99_999), "100k");
  assert.equal(formatTokenCount(999.6), "1.0k");
  assert.equal(formatTokenCount(100_000), "100k");
  assert.equal(formatTokenCount(9_999_999), "10.0M");
});

test("orders rows by cost within each section", () => {
  const cheap = assistantEntry("cheap", "cheap-model", usage(10, 1, 0.01));
  const pricey = assistantEntry("pricey", "pricey-model", usage(10, 1, 0.5));

  const report = aggregateUsage([[cheap, pricey]], now);

  assert.deepEqual(
    displayRows(report.periods.day).map((item) => item.label),
    ["Primary models", "  anthropic / pricey-model", "  anthropic / cheap-model"],
  );
});
