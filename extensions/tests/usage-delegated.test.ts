import assert from "node:assert/strict";
import { test } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { aggregateUsage, displayRows, type ModelUsage, type PeriodUsage } from "../usage/index.ts";

const now = new Date(2026, 2, 18, 12);
const at = new Date(2026, 2, 18, 8);

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

interface NestedOptions {
  provider?: string;
  model: string;
  responseModel?: string;
  usage: Usage;
}

function nestedAssistant(options: NestedOptions) {
  return {
    role: "assistant",
    content: [{ type: "text", text: `reply from ${options.model}` }],
    api: "anthropic-messages",
    provider: options.provider ?? "anthropic",
    model: options.model,
    responseModel: options.responseModel,
    usage: options.usage,
    stopReason: "stop",
    timestamp: at.getTime(),
  };
}

interface ChildResult {
  model?: string;
  messages: unknown[];
  usage: Usage;
}

function subagentEntry(id: string, results: ChildResult[], total: Usage): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: at.toISOString(),
    message: {
      role: "toolResult",
      toolCallId: `call-${id}`,
      toolName: "subagent",
      content: [{ type: "text", text: "done" }],
      details: {
        mode: results.length > 1 ? "parallel" : "single",
        agentScope: "user",
        projectAgentsDir: null,
        results: results.map((result, index) => ({
          agent: "worker",
          agentSource: "user",
          task: `task ${index}`,
          exitCode: 0,
          messages: result.messages,
          stderr: "",
          usage: { total: result.usage, contextTokens: 0, turns: 1 },
          model: result.model,
        })),
      },
      usage: total,
      isError: false,
      timestamp: at.getTime(),
    },
  } as SessionEntry;
}

function claudeEntry(id: string, model: string, total: Usage): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: at.toISOString(),
    message: {
      role: "toolResult",
      toolCallId: `call-${id}`,
      toolName: "claude",
      content: [{ type: "text", text: "done" }],
      details: { model, effort: "high", exitCode: 0, killed: false },
      usage: total,
      isError: false,
      timestamp: at.getTime(),
    },
  } as SessionEntry;
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

function toolEntry(id: string, toolName: string, toolUsage: Usage): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: at.toISOString(),
    message: {
      role: "toolResult",
      toolCallId: `call-${id}`,
      toolName,
      content: [],
      usage: toolUsage,
      isError: false,
      timestamp: at.getTime(),
    },
  } as SessionEntry;
}

function compactionEntry(id: string, compactionUsage: Usage): SessionEntry {
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

function row(period: PeriodUsage, source: string, provider: string, modelId: string): ModelUsage {
  const result = period.models.find(
    (item) => item.source === source && item.provider === provider && item.model === modelId,
  );
  assert.ok(result, `missing ${source} · ${provider}/${modelId}`);
  return result;
}

function categories(period: PeriodUsage): string[] {
  return [...new Set(period.models.map((item) => item.category))];
}

test("attributes subagent usage to each nested response model without double-counting", () => {
  const sonnet = usage(100, 20, 30, 0, 0.01);
  const luna = usage(50, 10, 15, 0, 0.005);
  const total = usage(150, 30, 45, 0, 0.015);
  const entry = subagentEntry(
    "subagent",
    [
      {
        model: "anthropic/claude-sonnet-4-5",
        messages: [
          nestedAssistant({
            model: "claude-sonnet-4-5",
            responseModel: "claude-sonnet-4-5-20250929",
            usage: sonnet,
          }),
          { role: "user", content: [{ type: "text", text: "steer" }], timestamp: at.getTime() },
          nestedAssistant({ provider: "openai-codex", model: "gpt-5.6-luna", usage: luna }),
        ],
        usage: total,
      },
    ],
    total,
  );

  const report = aggregateUsage([[entry]], now);
  const day = report.periods.day;
  const sonnetRow = row(day, "subagent", "anthropic", "claude-sonnet-4-5-20250929");
  const lunaRow = row(day, "subagent", "openai-codex", "gpt-5.6-luna");

  assert.equal(sonnetRow.category, "delegated");
  assert.deepEqual(
    [sonnetRow.input, sonnetRow.output, sonnetRow.cacheRead, sonnetRow.cost],
    [100, 20, 30, 0.01],
  );
  assert.deepEqual(
    [lunaRow.input, lunaRow.output, lunaRow.cacheRead, lunaRow.cost],
    [50, 10, 15, 0.005],
  );
  assert.deepEqual(categories(day), ["delegated"]);
  assert.equal(day.totals.input, 150);
  assert.equal(day.totals.output, 30);
  assert.equal(day.totals.cacheRead, 45);
  assert.ok(Math.abs(day.totals.cost - 0.015) < 1e-9);
  assert.equal(report.eventCount, 2);
});

test("attributes child overhead to the delegated model when a single model ran", () => {
  const reply = usage(100, 20, 0, 0, 0.01);
  // The child compacted once, so the result total exceeds the nested assistant usage.
  const total = usage(130, 25, 0, 0, 0.013);
  const entry = subagentEntry(
    "subagent",
    [
      {
        model: "anthropic/claude-sonnet-4-5",
        messages: [nestedAssistant({ model: "claude-sonnet-4-5", usage: reply })],
        usage: total,
      },
    ],
    total,
  );

  const report = aggregateUsage([[entry]], now);
  const day = report.periods.day;
  const sonnet = row(day, "subagent", "anthropic", "claude-sonnet-4-5");

  assert.equal(day.models.length, 1);
  assert.equal(sonnet.input, 130);
  assert.equal(sonnet.output, 25);
  assert.ok(Math.abs(sonnet.cost - 0.013) < 1e-9);
  assert.equal(day.totals.input, 130);
  assert.ok(Math.abs(day.totals.cost - 0.013) < 1e-9);
});

test("attributes a subagent result without nested messages to the model from its details", () => {
  const total = usage(40, 8, 0, 0, 0.02);
  const entry = subagentEntry(
    "subagent",
    [{ model: "anthropic/claude-sonnet-4-5", messages: [], usage: total }],
    total,
  );

  const report = aggregateUsage([[entry]], now);
  const fallback = row(report.periods.day, "subagent", "", "anthropic/claude-sonnet-4-5");

  assert.equal(fallback.category, "delegated");
  assert.equal(fallback.input, 40);
  assert.equal(fallback.cost, 0.02);
  assert.equal(report.periods.day.totals.input, 40);
  assert.deepEqual(
    displayRows(report.periods.day).map((item) => item.label),
    ["Delegated agents", "  subagent · anthropic/claude-sonnet-4-5"],
  );
});

test("never counts more than the result total when nested usage is inconsistent", () => {
  const total = usage(100, 10, 0, 0, 0.01);
  const entry = subagentEntry(
    "subagent",
    [
      {
        model: "anthropic/claude-sonnet-4-5",
        messages: [
          nestedAssistant({ model: "claude-sonnet-4-5", usage: usage(500, 50, 0, 0, 0.05) }),
        ],
        usage: total,
      },
    ],
    total,
  );

  const report = aggregateUsage([[entry]], now);
  const day = report.periods.day;

  assert.equal(day.totals.input, 100);
  assert.equal(day.totals.output, 10);
  assert.equal(day.totals.cost, 0.01);
  assert.equal(day.models.length, 1);
  assert.equal(day.models[0]?.category, "delegated");
});

test("attributes Claude Code usage to the claude tool and its model", () => {
  const entry = claudeEntry("claude", "opus", usage(10, 2, 3, 4, 0.1));

  const report = aggregateUsage([[entry]], now);
  const day = report.periods.day;
  const opus = row(day, "claude", "", "opus");

  assert.equal(opus.category, "delegated");
  assert.deepEqual(
    [opus.input, opus.output, opus.cacheRead, opus.cacheWrite, opus.cost],
    [10, 2, 3, 4, 0.1],
  );
  assert.equal(day.totals.cost, 0.1);
  assert.equal(report.eventCount, 1);
  assert.deepEqual(
    displayRows(day).map((item) => item.label),
    ["Delegated agents", "  claude · opus"],
  );
});

test("deduplicates delegated usage copied into forked sessions", () => {
  const reply = usage(100, 20, 0, 0, 0.01);
  const entry = subagentEntry(
    "subagent",
    [
      {
        model: "anthropic/claude-sonnet-4-5",
        messages: [nestedAssistant({ model: "claude-sonnet-4-5", usage: reply })],
        usage: reply,
      },
    ],
    reply,
  );
  const copy = { ...structuredClone(entry), id: "migrated" } as SessionEntry;

  const report = aggregateUsage(
    [[entry], [copy], [claudeEntry("claude", "opus", usage(10, 2))]],
    now,
  );

  assert.equal(report.periods.day.totals.input, 110);
  assert.equal(report.eventCount, 2);
  assert.equal(report.deduplicatedEntries, 1);
});

test("renders delegated agents between primary models and session overhead", () => {
  const report = aggregateUsage(
    [
      [
        assistantEntry("primary", "gpt-5.6-sol", usage(100, 20, 30, 0, 1)),
        claudeEntry("claude", "opus", usage(10, 2, 3, 0, 0.01)),
        subagentEntry(
          "subagent",
          [
            {
              model: "anthropic/claude-sonnet-4-5",
              messages: [
                nestedAssistant({ model: "claude-sonnet-4-5", usage: usage(20, 4, 0, 0, 0.05) }),
              ],
              usage: usage(20, 4, 0, 0, 0.05),
            },
          ],
          usage(20, 4, 0, 0, 0.05),
        ),
        compactionEntry("summary", usage(5, 1, 0, 0, 0.2)),
        toolEntry("tool", "nested-agent", usage(1, 1, 0, 0, 0.001)),
      ],
    ],
    now,
  );

  assert.deepEqual(
    displayRows(report.periods.day).map((item) => [item.label, item.heading]),
    [
      ["Primary models", true],
      ["  anthropic / gpt-5.6-sol", false],
      ["Delegated agents", true],
      ["  subagent · anthropic / claude-sonnet-4-5", false],
      ["  claude · opus", false],
      ["Session overhead", true],
      ["  Compaction", false],
      ["Tool usage", true],
      ["  nested-agent", false],
    ],
  );
});
