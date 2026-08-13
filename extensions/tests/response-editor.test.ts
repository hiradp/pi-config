import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { findLastAssistantText, resolveEditorInvocation } from "../response-editor.ts";

function messageEntry(id: string, message: AssistantMessage | UserMessage): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message,
  };
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

test("resolves configured and named external editors", () => {
  assert.deepEqual(resolveEditorInvocation("", "nvim -f", "darwin"), {
    command: "nvim",
    args: ["-f"],
    label: "nvim -f",
  });
  assert.deepEqual(resolveEditorInvocation("zed", "nvim", "darwin"), {
    command: "zed",
    args: ["--wait"],
    label: "zed --wait",
  });
  assert.deepEqual(resolveEditorInvocation("markedit", "nvim", "darwin"), {
    command: "open",
    args: ["-W", "-a", "MarkEdit"],
    label: "MarkEdit",
  });
  assert.deepEqual(resolveEditorInvocation('"Visual Studio Code"', "nvim", "darwin"), {
    command: "open",
    args: ["-W", "-a", "Visual Studio Code"],
    label: "Visual Studio Code",
  });
});

test("finds and joins text from the latest assistant response", () => {
  const entries: SessionEntry[] = [
    messageEntry("assistant-1", assistant([{ type: "text", text: "Old response" }])),
    messageEntry("user-1", { role: "user", content: "Continue", timestamp: 0 }),
    messageEntry(
      "assistant-2",
      assistant([
        { type: "thinking", thinking: "Hidden reasoning" },
        { type: "text", text: "# Plan" },
        { type: "text", text: "1. First step" },
      ]),
    ),
  ];

  assert.equal(findLastAssistantText(entries), "# Plan\n\n1. First step");
});

test("skips assistant messages without text", () => {
  const entries: SessionEntry[] = [
    messageEntry("assistant-1", assistant([{ type: "text", text: "Usable response" }])),
    messageEntry(
      "assistant-2",
      assistant([{ type: "toolCall", id: "call-1", name: "read", arguments: {} }]),
    ),
  ];

  assert.equal(findLastAssistantText(entries), "Usable response");
  assert.equal(findLastAssistantText([]), undefined);
});
