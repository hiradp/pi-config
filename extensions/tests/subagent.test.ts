import assert from "node:assert/strict";
import { test } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSubagent, {
  classifyChildExit,
  combineUsage,
  hasFailedSubagentResult,
  resolveDispatchConfig,
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

test("exposes model overrides in every subagent mode", () => {
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

  const taskSchema = parameters.properties.tasks as { items: Schema };
  const chainSchema = parameters.properties.chain as { items: Schema };
  assert.ok(taskSchema.items.properties.model);
  assert.ok(chainSchema.items.properties.model);
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
