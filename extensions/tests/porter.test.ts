import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  PORTER_MODEL,
  createPorterRunner,
  createPorterTool,
  getFinalPorterOutput,
  parsePorterEvent,
  registerPorter,
  type PorterDetails,
} from "../porter/index.ts";

function usage(output = 0, cost = 0): Usage {
  return {
    input: 1,
    output,
    cacheRead: 2,
    cacheWrite: 3,
    totalTokens: 6 + output,
    cost: { input: 0.1, output: cost, cacheRead: 0.2, cacheWrite: 0.3, total: 0.6 + cost },
  };
}

function assistant(
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    usage: usage(4, 0.4),
    stopReason,
    timestamp: 1,
  };
}

function details(): PorterDetails {
  return {
    model: PORTER_MODEL,
    messages: [],
    stderr: "",
    exitCode: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

test("parses Porter events and aggregates nested usage", () => {
  const state = details();
  const toolResult: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "bash",
    content: [{ type: "text", text: "ok" }],
    usage: usage(2, 0.2),
    isError: false,
    timestamp: 2,
  };

  assert.equal(parsePorterEvent("not-json", state), false);
  assert.equal(parsePorterEvent(JSON.stringify({ type: "turn_start" }), state), false);
  assert.equal(
    parsePorterEvent(JSON.stringify({ type: "message_end", message: assistant("done") }), state),
    true,
  );
  assert.equal(
    parsePorterEvent(JSON.stringify({ type: "message_end", message: toolResult }), state),
    true,
  );

  assert.equal(getFinalPorterOutput(state.messages), "done");
  assert.equal(state.usage.input, 2);
  assert.equal(state.usage.output, 6);
  assert.equal(state.usage.cacheRead, 4);
  assert.equal(state.usage.cacheWrite, 6);
  assert.equal(state.usage.cost.total, 1.8);
});

test("runs Porter in an isolated Luna/high process with guardrails", async () => {
  let invocation:
    | { command: string; args: string[]; options: { cwd?: string; signal?: AbortSignal } }
    | undefined;
  const pi = {
    async exec(command: string, args: string[], options: { cwd?: string; signal?: AbortSignal }) {
      invocation = { command, args, options };
      return {
        stdout: `${JSON.stringify({ type: "message_end", message: assistant("Created abc123") })}\n`,
        stderr: "",
        code: 0,
        killed: false,
      };
    },
  } as unknown as Pick<ExtensionAPI, "exec">;

  const controller = new AbortController();
  const result = await createPorterRunner(pi)({
    cwd: "/repo",
    task: "The user explicitly requested a local commit only.",
    signal: controller.signal,
  });

  assert.equal(invocation?.command, "pi");
  assert.equal(invocation?.options.cwd, "/repo");
  assert.equal(invocation?.options.signal, controller.signal);
  assert.ok(invocation?.args.includes("--no-session"));
  assert.ok(invocation?.args.includes("--no-extensions"));
  assert.ok(invocation?.args.includes("--extension"));
  assert.ok(invocation?.args.includes("read,bash"));
  assert.ok(invocation?.args.includes(PORTER_MODEL));
  assert.match(invocation?.args.join("\n") ?? "", /local commit only/);
  assert.equal(getFinalPorterOutput(result.messages), "Created abc123");
});

test("registers a single Porter tool and returns its report", async () => {
  let registered: ReturnType<typeof createPorterTool> | undefined;
  const pi = {
    registerTool(tool: ReturnType<typeof createPorterTool>) {
      registered = tool;
    },
  } as unknown as ExtensionAPI;

  registerPorter(pi, async () => ({
    ...details(),
    messages: [assistant("Created abc123")],
    usage: usage(4, 0.4),
  }));

  assert.equal(registered?.name, "porter");
  assert.deepEqual(Object.keys(registered?.parameters.properties ?? {}), ["task"]);

  const ctx = { cwd: "/repo" } as ExtensionContext;
  const result = await registered?.execute(
    "call-1",
    { task: "commit only" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(result?.content[0]?.type, "text");
  assert.equal(result?.content[0]?.type === "text" ? result.content[0].text : "", "Created abc123");
  assert.equal(result?.usage?.output, 4);
});

test("fails the tool when the child agent fails", async () => {
  const tool = createPorterTool(async () => ({
    ...details(),
    messages: [{ ...assistant("", "error"), errorMessage: "provider unavailable" }],
    stopReason: "error",
    errorMessage: "provider unavailable",
  }));

  await assert.rejects(
    tool.execute("call-1", { task: "commit only" }, undefined, undefined, {
      cwd: "/repo",
    } as ExtensionContext),
    /provider unavailable/,
  );
});
