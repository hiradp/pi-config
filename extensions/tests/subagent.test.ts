import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import registerSubagent, {
  classifyChildExit,
  combineUsage,
  formatElapsed,
  formatParallelProgress,
  hasFailedSubagentResult,
  resolveDispatchConfig,
  resultStatus,
  sanitizeDashboardText,
  signalProcessTree,
  truncateOutput,
} from "../subagent/index.ts";

test("resolves invocation, agent, and parent models in precedence order", () => {
  const defaults = {
    model: "openai-codex/gpt-5.6-sol",
    thinkingLevel: "xhigh" as const,
  };

  assert.deepEqual(resolveDispatchConfig(undefined, undefined, defaults), {
    model: "openai-codex/gpt-5.6-sol",
    thinkingLevel: "xhigh",
  });
  assert.deepEqual(
    resolveDispatchConfig("fireworks/accounts/fireworks/models/kimi-k3", undefined, defaults),
    {
      model: "fireworks/accounts/fireworks/models/kimi-k3",
      thinkingLevel: undefined,
    },
  );
  assert.deepEqual(
    resolveDispatchConfig(
      "fireworks/accounts/fireworks/models/kimi-k3",
      "anthropic/claude-sonnet-5",
      defaults,
    ),
    {
      model: "anthropic/claude-sonnet-5",
      thinkingLevel: "xhigh",
    },
  );
  assert.deepEqual(
    resolveDispatchConfig("fireworks/accounts/fireworks/models/kimi-k3", "  ", defaults),
    {
      model: "fireworks/accounts/fireworks/models/kimi-k3",
      thinkingLevel: undefined,
    },
  );
});

test("exposes model overrides and display labels in every subagent mode", () => {
  type Schema = { description?: string; properties: Record<string, unknown> };
  let parameters: Schema | undefined;

  registerSubagent({
    on() {},
    registerTool(definition: { parameters: Schema }) {
      parameters = definition.parameters;
    },
  } as unknown as ExtensionAPI);

  assert.ok(parameters);
  const singleModel = parameters.properties.model as Schema;
  assert.match(singleModel.description ?? "", /single mode/);
  assert.ok(parameters.properties.label);

  const taskSchema = parameters.properties.tasks as { items: Schema };
  const chainSchema = parameters.properties.chain as { items: Schema };
  assert.ok(taskSchema.items.properties.model);
  assert.ok(taskSchema.items.properties.label);
  assert.ok(chainSchema.items.properties.model);
  assert.ok(chainSchema.items.properties.label);
});

test("aggregates complete nested model usage", () => {
  const first: Usage = {
    input: 10,
    output: 4,
    cacheRead: 3,
    cacheWrite: 2,
    cacheWrite1h: 1,
    reasoning: 2,
    totalTokens: 19,
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
  };
  const second: Usage = {
    input: 20,
    output: 8,
    cacheRead: 6,
    cacheWrite: 4,
    cacheWrite1h: 2,
    reasoning: 3,
    totalTokens: 38,
    cost: { input: 2, output: 4, cacheRead: 6, cacheWrite: 8, total: 20 },
  };

  assert.deepEqual(combineUsage([first, second]), {
    input: 30,
    output: 12,
    cacheRead: 9,
    cacheWrite: 6,
    cacheWrite1h: 3,
    reasoning: 5,
    totalTokens: 57,
    cost: { input: 3, output: 6, cacheRead: 9, cacheWrite: 12, total: 30 },
  });
});

test("marks any failed child result as a failed subagent result", () => {
  assert.equal(hasFailedSubagentResult({ results: [{ exitCode: 0 }, { exitCode: 1 }] }), true);
  assert.equal(hasFailedSubagentResult({ results: [{ exitCode: 0, stopReason: "error" }] }), true);
  assert.equal(
    hasFailedSubagentResult({ results: [{ exitCode: 0, stopReason: "aborted" }] }),
    true,
  );
  assert.equal(hasFailedSubagentResult({ results: [{ exitCode: 0, stopReason: "length" }] }), true);
  assert.equal(hasFailedSubagentResult({ results: [{ exitCode: 0, stopReason: "stop" }] }), false);
  assert.equal(hasFailedSubagentResult(undefined), false);
});

test("classifies signal exits and user cancellation as failures", () => {
  assert.deepEqual(classifyChildExit(null, "SIGKILL", false), {
    exitCode: 1,
    errorMessage: "Subagent terminated by signal SIGKILL",
  });
  assert.deepEqual(classifyChildExit(null, "SIGTERM", true), {
    exitCode: 1,
    stopReason: "aborted",
    errorMessage: "Subagent was aborted (SIGTERM)",
  });
  assert.deepEqual(classifyChildExit(0, null, false), { exitCode: 0 });
});

test("bounds model-visible output while preserving a truncation notice", () => {
  const byteLimited = truncateOutput("🙂".repeat(1000), 1024);
  assert.ok(Buffer.byteLength(byteLimited, "utf8") <= 1024);
  assert.match(byteLimited, /Output truncated/);

  const lineLimited = truncateOutput("line\n".repeat(3000), 50 * 1024, 100);
  assert.ok(lineLimited.split("\n").length <= 102);
  assert.match(lineLimited, /2901 lines/);
});

test("marks subagent tool results as errors without discarding details or usage", () => {
  let handler: ((event: { toolName: string; details: unknown }) => unknown) | undefined;

  registerSubagent({
    on(event: string, candidate: typeof handler) {
      if (event === "tool_result") handler = candidate;
    },
    registerTool() {},
  } as unknown as ExtensionAPI);

  assert.ok(handler);
  assert.deepEqual(handler({ toolName: "subagent", details: { results: [{ exitCode: 1 }] } }), {
    isError: true,
  });
  assert.equal(
    handler({ toolName: "subagent", details: { results: [{ exitCode: 0 }] } }),
    undefined,
  );
  assert.equal(handler({ toolName: "other", details: { results: [{ exitCode: 1 }] } }), undefined);
});

test("formats compact subagent elapsed times", () => {
  assert.equal(formatElapsed(9_999), "9s");
  assert.equal(formatElapsed(65_000), "1m 05s");
  assert.equal(formatElapsed(3_720_000), "1h 02m");
});

test("derives child states and reports queued parallel work separately", () => {
  const base = {
    agent: "reviewer",
    agentSource: "user" as const,
    task: "Review",
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: {
      total: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      contextTokens: 0,
      turns: 0,
    },
  };
  const queued = { ...base };
  const running = { ...base, startedAt: Date.now() };
  const completed = { ...base, exitCode: 0 };
  const failed = { ...base, exitCode: 1 };

  assert.equal(resultStatus(queued), "queued");
  assert.equal(resultStatus(running), "running");
  assert.equal(resultStatus(completed), "completed");
  assert.equal(resultStatus(failed), "failed");
  assert.equal(
    formatParallelProgress([queued, running, completed, failed]),
    "Parallel: 2/4 done, 1 running, 1 queued...",
  );
});

test("removes terminal sequences and C0/C1 controls from dashboard text", () => {
  const unsafe =
    "safe\u001bc reset \u001b[2Acursor \u009b3BC1 \u0007bell \u001b]52;c;clipboard\u0007done";
  const sanitized = sanitizeDashboardText(unsafe);

  assert.equal(sanitized, "safe reset cursor C1 bell done");
  assert.equal(
    Array.from(sanitized).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    }),
    false,
  );
});

test(
  "signals the detached subagent process group",
  { skip: process.platform === "win32" },
  async () => {
    const grandchildScript =
      "process.on('SIGTERM',()=>process.stdout.write('grandchild-term\\n'));process.stdout.write('grandchild-ready\\n');setInterval(()=>{},1000)";
    const parentScript = [
      "const {spawn}=require('node:child_process')",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(grandchildScript)}],{stdio:['ignore','inherit','ignore']})`,
      "console.log('grandchild:'+child.pid)",
      "process.on('SIGTERM',()=>process.stdout.write('parent-term\\n'))",
      "setInterval(()=>{},1000)",
    ].join(";");
    const child = spawn(process.execPath, ["-e", parentScript], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    let output = "";
    child.stdout.on("data", (data) => {
      output += data.toString();
    });
    const waitFor = async (pattern: RegExp) => {
      for (let attempt = 0; attempt < 100 && !pattern.test(output); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.match(output, pattern);
    };

    try {
      await waitFor(/grandchild:\d+/);
      await waitFor(/grandchild-ready/);
      assert.ok(child.pid);
      signalProcessTree(child.pid, "SIGTERM");
      await waitFor(/parent-term/);
      await waitFor(/grandchild-term/);
    } finally {
      if (child.pid) signalProcessTree(child.pid, "SIGKILL");
      await closed;
    }
  },
);

test("expanded results preserve early failures and identify unrun chain steps", () => {
  type Renderer = (
    result: { content: Array<{ type: "text"; text: string }>; details: unknown },
    options: { expanded: boolean; isPartial: boolean },
    theme: Theme,
    context: {
      state: Record<string, unknown>;
      lastComponent: unknown;
      invalidate: () => void;
      toolCallId: string;
    },
  ) => { render(width: number): string[] };

  let renderResult: Renderer | undefined;
  registerSubagent({
    on() {},
    registerTool(definition: { renderResult?: Renderer }) {
      renderResult = definition.renderResult;
    },
  } as unknown as ExtensionAPI);
  assert.ok(renderResult);

  const usage = {
    total: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    contextTokens: 0,
    turns: 0,
  };
  const failed = {
    agent: "worker",
    agentSource: "user",
    task: "Start work",
    exitCode: 1,
    messages: [],
    stderr: "spawn failed\u001b[2A",
    usage,
    step: 1,
  };
  const queued = {
    agent: "reviewer",
    agentSource: "user",
    task: "Review {previous}",
    exitCode: -1,
    messages: [],
    stderr: "",
    usage,
    model: "anthropic/claude-sonnet-5",
    step: 2,
  };
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const context = {
    state: {},
    lastComponent: undefined,
    invalidate() {},
    toolCallId: "restored",
  };

  const parallel = renderResult(
    {
      content: [{ type: "text", text: "failed" }],
      details: {
        mode: "parallel",
        agentScope: "user",
        projectAgentsDir: null,
        results: [failed],
      },
    },
    { expanded: true, isPartial: false },
    theme,
    context,
  )
    .render(100)
    .join("\n");
  assert.match(parallel, /Error: spawn failed/);
  assert.equal(parallel.includes("\u001b[2A"), false);

  const chain = renderResult(
    {
      content: [{ type: "text", text: "failed" }],
      details: {
        mode: "chain",
        agentScope: "user",
        projectAgentsDir: null,
        results: [failed, queued],
      },
    },
    { expanded: true, isPartial: false },
    theme,
    { ...context, toolCallId: "chain" },
  )
    .render(100)
    .join("\n");
  assert.match(chain, /Step 2: reviewer/);
  assert.match(chain, /\(not run\)/);
});

test("renders restored legacy usage details", () => {
  let renderResult: any;
  registerSubagent({
    on() {},
    registerTool(definition: { renderResult?: unknown }) {
      renderResult = definition.renderResult;
    },
  } as unknown as ExtensionAPI);

  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const component = renderResult(
    {
      content: [{ type: "text", text: "restored" }],
      details: {
        mode: "single",
        agentScope: "user",
        projectAgentsDir: null,
        results: [
          {
            agent: "legacy",
            agentSource: "user",
            task: "Old task",
            exitCode: 0,
            messages: [],
            stderr: "",
            usage: {
              input: 10,
              output: 20,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.5,
              contextTokens: 30,
              turns: 2,
            },
            model: "provider/old-model",
          },
        ],
      },
    },
    { expanded: false, isPartial: false },
    theme,
    { state: {}, lastComponent: undefined, invalidate() {}, toolCallId: "legacy" },
  );

  assert.match(component.render(100).join("\n"), /2 turns · ↓20 · \$0\.5000 · old-model/);
});

test("renders running subagents as a stable dashboard", () => {
  type Renderer = (
    result: { content: Array<{ type: "text"; text: string }>; details: unknown },
    options: { expanded: boolean; isPartial: boolean },
    theme: Theme,
    context: {
      state: Record<string, unknown>;
      lastComponent: unknown;
      invalidate: () => void;
    },
  ) => { render(width: number): string[] };

  let renderResult: Renderer | undefined;
  registerSubagent({
    on() {},
    registerTool(definition: { renderResult?: Renderer }) {
      renderResult = definition.renderResult;
    },
  } as unknown as ExtensionAPI);
  assert.ok(renderResult);

  const usage = {
    total: {
      input: 2000,
      output: 1200,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3200,
      cost: { input: 0, output: 0.0123, cacheRead: 0, cacheWrite: 0, total: 0.0123 },
    },
    contextTokens: 3200,
    turns: 2,
  };
  const runningDetails = {
    mode: "parallel",
    agentScope: "user",
    projectAgentsDir: null,
    results: [
      {
        agent: "code-reviewer",
        agentSource: "user",
        task: "Review the current code for correctness and completeness",
        label: "Checking correctness",
        exitCode: -1,
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                name: "bash",
                arguments: { command: "echo first\n\u001b[31mecho second\u001b[0m" },
              },
            ],
          },
        ],
        stderr: "",
        usage,
        model: "openai-codex/gpt-5.6-sol",
        startedAt: Date.now(),
      },
      {
        agent: "plan-reviewer",
        agentSource: "unknown",
        task: "Review the implementation plan",
        exitCode: -1,
        messages: [],
        stderr: "",
        usage: { ...usage, turns: 0 },
        model: "openai-codex/gpt-5.6-sol",
      },
    ],
  };
  const finalDetails = {
    ...runningDetails,
    results: runningDetails.results.map((result) => ({
      ...result,
      exitCode: 0,
      completedAt: Date.now(),
    })),
  };
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const state: Record<string, unknown> = {};
  const context = {
    state,
    lastComponent: undefined,
    invalidate() {},
    toolCallId: "subagent-call",
  };

  const component = renderResult(
    { content: [{ type: "text", text: "running" }], details: runningDetails },
    { expanded: false, isPartial: true },
    theme,
    context,
  );
  const lines = component.render(100);
  const dashboard = lines.join("\n");

  assert.match(dashboard, /0\/2 finished · 1 running · 1 queued/);
  assert.match(dashboard, /Checking correctness…/);
  assert.match(dashboard, /code-reviewer · \d+s · 2 turns · ↓1\.2k · \$0\.0123 · gpt-5\.6-sol/);
  assert.match(dashboard, /\$ echo first echo second/);
  assert.equal(dashboard.includes("\u001b[31m"), false);
  assert.ok(lines.every((line) => !line.includes("\n") && !line.includes("\r")));
  assert.match(dashboard, /Review the implementation plan/);
  assert.match(dashboard, /plan-reviewer · queued · gpt-5\.6-sol/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 100));
  assert.ok(component.render(32).every((line) => visibleWidth(line) <= 32));

  const finalComponent = renderResult(
    { content: [{ type: "text", text: "done" }], details: finalDetails },
    { expanded: false, isPartial: false },
    theme,
    context,
  );
  assert.match(finalComponent.render(100).join("\n"), /2\/2 complete/);
});
