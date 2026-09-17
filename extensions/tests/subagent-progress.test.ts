import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  JsonAgentSessionEvent,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import registerSubagent from "../subagent/index.ts";
import { ChildProgressTracker } from "../subagent/progress.ts";

function tracker() {
  return new ChildProgressTracker(
    1000,
    (name, args) => `${name} ${args.command ?? args.path ?? ""}`,
  );
}

function record(progress: ChildProgressTracker, event: Record<string, unknown>, now: number) {
  progress.record(event as JsonAgentSessionEvent, now);
}

const result = (text: string) => ({ content: [{ type: "text" as const, text }] });

function renderer() {
  let render: ToolDefinition["renderResult"];
  registerSubagent({
    on() {},
    registerTool(tool: ToolDefinition) {
      render = tool.renderResult;
    },
  } as unknown as ExtensionAPI);
  assert.ok(render);
  return render;
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function child(progress: ChildProgressTracker) {
  return {
    agent: "worker",
    agentSource: "user",
    task: "Inspect the checkout without changing it.",
    startedAt: 1000,
    exitCode: -1,
    messages: [],
    stderr: "",
    progress: progress.snapshot(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
  };
}

function renderProgress(progress: ChildProgressTracker, expanded: boolean, extra = {}) {
  const render = renderer();
  const context = {
    state: {},
    lastComponent: undefined,
    invalidate() {},
  } as Parameters<typeof render>[3];
  return render(
    {
      ...result("running"),
      details: { mode: "single", results: [{ ...child(progress), ...extra }] },
    },
    { expanded, isPartial: true },
    theme,
    context,
  );
}

test("keeps simultaneous commands separate and replaces cumulative output instead of duplicating it", () => {
  const progress = tracker();
  for (const [id, time] of [
    ["test", 2000],
    ["lint", 3000],
  ] as const) {
    record(
      progress,
      { type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: id } },
      time,
    );
  }
  record(
    progress,
    { type: "tool_execution_update", toolCallId: "test", partialResult: result("first") },
    4000,
  );
  const oldSnapshot = progress.snapshot();
  record(
    progress,
    { type: "tool_execution_update", toolCallId: "test", partialResult: result("first\nsecond") },
    5000,
  );
  record(
    progress,
    {
      type: "tool_execution_end",
      toolCallId: "lint",
      result: result("lint failed"),
      isError: true,
    },
    6000,
  );

  const running = progress.snapshot();
  assert.equal(running.phase, "tools");
  assert.equal(running.activeToolCount, 1);
  assert.equal(running.activeTools[0].startedAt, 2000);
  assert.equal(running.activeTools[0].output, "first\nsecond");
  assert.equal(oldSnapshot.activeTools[0].output, "first");
  assert.equal(running.recentTools[0].isError, true);
  assert.equal(running.recentTools[0].finishedAt, 6000);

  record(
    progress,
    { type: "tool_execution_end", toolCallId: "test", result: result("passed"), isError: false },
    7000,
  );
  assert.equal(progress.snapshot().phase, "waiting");
  assert.equal(progress.snapshot().activeToolCount, 0);
});

test("bounds text previews and tool history while never treating reasoning as assistant output", () => {
  const progress = tracker();
  record(progress, { type: "message_start", message: { role: "assistant" } }, 2000);
  record(
    progress,
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "old line\n".repeat(1000) },
    },
    2100,
  );
  record(
    progress,
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "latest answer" },
    },
    2200,
  );
  record(
    progress,
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "not displayable output" },
    },
    2300,
  );
  assert.equal(progress.snapshot().phaseStartedAt, 2100);
  assert.equal(progress.snapshot().lastEventAt, 2300);
  assert.ok(progress.snapshot().assistantText.endsWith("latest answer"));
  assert.ok(progress.snapshot().assistantText.length < 5000);
  assert.doesNotMatch(progress.snapshot().assistantText, /not displayable/);

  for (let index = 0; index < 12; index++) {
    record(
      progress,
      {
        type: "tool_execution_start",
        toolCallId: `${index}`,
        toolName: "read",
        args: { path: `file-${index}` },
      },
      3000 + index,
    );
    record(
      progress,
      {
        type: "tool_execution_end",
        toolCallId: `${index}`,
        result: result("x".repeat(100_000) + "LATEST"),
        isError: false,
      },
      4000 + index,
    );
  }
  const history = progress.snapshot().recentTools;
  assert.equal(history.length, 5);
  assert.equal(history.at(-1)?.description, "read file-11");
  assert.ok(history.every((tool) => tool.output.length <= 4096 && tool.output.endsWith("LATEST")));
});

test("expanded running view exposes the assigned task, tool failures, output and assistant text safely", (t) => {
  t.mock.method(Date, "now", () => 10000);
  const progress = tracker();
  record(
    progress,
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Checking the restart path." },
    },
    2000,
  );
  record(
    progress,
    {
      type: "tool_execution_start",
      toolCallId: "lint",
      toolName: "bash",
      args: { command: "lint" },
    },
    3000,
  );
  record(
    progress,
    { type: "tool_execution_end", toolCallId: "lint", result: result("bad import"), isError: true },
    4000,
  );
  record(
    progress,
    {
      type: "tool_execution_start",
      toolCallId: "test",
      toolName: "bash",
      args: { command: "go test ./..." },
    },
    5000,
  );
  record(
    progress,
    {
      type: "tool_execution_update",
      toolCallId: "test",
      partialResult: result("\u001b]52;c;clipboard\u0007test started\n" + "🙂".repeat(100)),
    },
    6000,
  );
  const extra = { task: "Check {previous}", assignedTask: "Check the resolved previous result." };

  const expanded = renderProgress(progress, true, extra);
  const output = expanded.render(100).join("\n");
  assert.match(output, /Check the resolved previous result/);
  assert.doesNotMatch(output, /\{previous\}/);
  assert.match(output, /error · 1s · bash lint/);
  assert.match(output, /bad import/);
  assert.match(output, /running · 5s · bash go test/);
  assert.match(output, /test started/);
  assert.match(output, /Checking the restart path/);
  for (const unsafe of ["clipboard", "\u001b]52", "\u0007"]) {
    assert.equal(output.includes(unsafe), false);
  }
  for (const width of [0, 12, 32, 100]) {
    assert.ok(expanded.render(width).every((line) => visibleWidth(line) <= width));
  }

  const collapsed = renderProgress(progress, false, extra).render(100).join("\n");
  assert.match(collapsed, /Running for 5s/);
  assert.match(collapsed, /Last event 4s ago/);
  assert.doesNotMatch(collapsed, /bad import|test started|Checking the restart path/);
});

test("silence ages on render without declaring failure, and a new event clears the warning", (t) => {
  let now = 5000;
  t.mock.method(Date, "now", () => now);
  const progress = tracker();
  record(
    progress,
    {
      type: "tool_execution_start",
      toolCallId: "test",
      toolName: "bash",
      args: { command: "quiet-test" },
    },
    2000,
  );
  const component = renderProgress(progress, false);
  assert.match(component.render(100).join("\n"), /Last event 3s ago/);
  now = 100000;
  const quiet = component.render(100).join("\n");
  assert.match(quiet, /No events received for 1m 38s/);
  assert.match(quiet, /1 running/);
  assert.doesNotMatch(quiet, /failed|stuck/);

  record(
    progress,
    { type: "tool_execution_update", toolCallId: "test", partialResult: result("still working") },
    now,
  );
  const refreshed = renderProgress(progress, false).render(100).join("\n");
  assert.match(refreshed, /Last event 0s ago/);
  assert.doesNotMatch(refreshed, /No events received/);
});

test("shows provider retry and compaction as distinct activity rather than a hung model request", (t) => {
  t.mock.method(Date, "now", () => 10000);
  const progress = tracker();
  record(progress, { type: "auto_retry_start" }, 2000);
  assert.match(renderProgress(progress, false).render(100).join("\n"), /Waiting to retry · 8s/);
  record(progress, { type: "auto_retry_end" }, 3000);
  record(progress, { type: "compaction_start" }, 4000);
  assert.match(renderProgress(progress, false).render(100).join("\n"), /Compacting context · 6s/);
  record(progress, { type: "compaction_end" }, 5000);
  assert.match(
    renderProgress(progress, false).render(100).join("\n"),
    /Waiting for model response · 5s/,
  );
});
