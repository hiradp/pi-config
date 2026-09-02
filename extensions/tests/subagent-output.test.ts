import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import registerSubagent, { substitutePrevious, truncateOutput } from "../subagent/index.ts";

type Renderable = { render(width: number): string[] };

function captureRenderers() {
  let renderCall: ((args: any, theme: Theme, context: any) => Renderable) | undefined;
  let renderResult:
    | ((result: any, options: any, theme: Theme, context: any) => Renderable)
    | undefined;
  registerSubagent({
    on() {},
    registerTool(definition: {
      renderCall?: typeof renderCall;
      renderResult?: typeof renderResult;
    }) {
      renderCall = definition.renderCall;
      renderResult = definition.renderResult;
    },
  } as unknown as ExtensionAPI);
  assert.ok(renderCall);
  assert.ok(renderResult);
  return { renderCall, renderResult };
}

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const emptyUsage = {
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

test("renders task text through the sanitiser in every view", () => {
  const { renderCall, renderResult } = captureRenderers();
  const unsafeTask = "Inspect\u001b[2A the \u009b3Bbuild\u0007 output";
  const context = { state: {}, lastComponent: undefined, invalidate() {}, toolCallId: "call" };

  const call = renderCall({ agent: "worker", task: unsafeTask }, plainTheme, context)
    .render(100)
    .join("\n");
  assert.match(call, /Inspect the build output/);
  assert.equal(call.includes("\u001b[2A"), false);

  const result = (agent: string, step?: number) => ({
    agent,
    agentSource: "user",
    task: unsafeTask,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: emptyUsage,
    stopReason: "stop",
    step,
  });
  for (const details of [
    { mode: "single", results: [result("worker")] },
    { mode: "chain", results: [result("worker", 1), result("worker", 2)] },
    { mode: "parallel", results: [result("worker"), result("worker")] },
  ]) {
    const rendered = renderResult(
      {
        content: [{ type: "text", text: "done" }],
        details: { ...details, agentScope: "user", projectAgentsDir: null },
      },
      { expanded: true, isPartial: false },
      plainTheme,
      { ...context, toolCallId: details.mode },
    )
      .render(100)
      .join("\n");
    assert.match(rendered, /Inspect the build output/, details.mode);
    assert.equal(rendered.includes("\u001b"), false, details.mode);
    assert.equal(rendered.includes("\u009b"), false, details.mode);
  }
});

test("renders child tool calls with non-string arguments", () => {
  const { renderResult } = captureRenderers();
  const rendered = renderResult(
    {
      content: [{ type: "text", text: "done" }],
      details: {
        mode: "single",
        agentScope: "user",
        projectAgentsDir: null,
        results: [
          {
            agent: "worker",
            agentSource: "user",
            task: "Write config",
            exitCode: 0,
            stopReason: "stop",
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    name: "write",
                    arguments: { file_path: 42, content: { nested: true } },
                  },
                  { type: "toolCall", name: "read", arguments: { path: null, offset: "3" } },
                  { type: "text", text: "Wrote it" },
                ],
              },
            ],
            stderr: "",
            usage: emptyUsage,
          },
        ],
      },
    },
    { expanded: true, isPartial: false },
    plainTheme,
    { state: {}, lastComponent: undefined, invalidate() {}, toolCallId: "write" },
  )
    .render(100)
    .join("\n");

  assert.match(rendered, /→ write/);
  assert.match(rendered, /→ read/);
  assert.match(rendered, /Wrote it/);
});

test("truncation notice states what was omitted without promising hidden output", () => {
  const truncated = truncateOutput("x".repeat(5000), 1024);

  assert.match(truncated, /\[Output truncated: \d+ bytes omitted\.\]$/);
  assert.doesNotMatch(truncated, /tool details/);
});

test("chain steps receive previous output verbatim, including dollar sequences", () => {
  const previous = "cost $$ and $& then $` plus $' end";

  assert.equal(
    substitutePrevious("Start {previous} again {previous}", previous),
    `Start ${previous} again ${previous}`,
  );
  assert.equal(substitutePrevious("No placeholder", previous), "No placeholder");
});
