import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionCosts } from "../ui/status-footer.ts";

function context(entries: unknown[]): ExtensionContext {
  return { sessionManager: { getEntries: () => entries } } as unknown as ExtensionContext;
}

test("counts Claude Code results as agent cost", () => {
  const ctx = context([
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "claude", arguments: {} }],
        usage: { cost: { total: 1 } },
      },
    },
    {
      type: "message",
      message: { role: "toolResult", toolName: "claude", usage: { cost: { total: 0.5 } } },
    },
  ]);

  assert.deepEqual(sessionCosts(ctx), { total: 1.5, main: 1, subagents: 0.5, hasSubagents: true });
});

test("marks a session as delegating while a Claude Code call is still running", () => {
  const ctx = context([
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "claude", arguments: {} }],
        usage: { cost: { total: 0.25 } },
      },
    },
  ]);

  assert.deepEqual(sessionCosts(ctx), {
    total: 0.25,
    main: 0.25,
    subagents: 0,
    hasSubagents: true,
  });
});

test("tolerates tool results whose usage carries no cost", () => {
  const ctx = context([
    { type: "message", message: { role: "assistant", content: [], usage: { cost: { total: 1 } } } },
    {
      type: "message",
      message: { role: "toolResult", toolName: "subagent", usage: { input: 10, output: 2 } },
    },
    {
      type: "message",
      message: { role: "toolResult", toolName: "summarize", usage: { input: 5, output: 1 } },
    },
  ]);

  assert.deepEqual(sessionCosts(ctx), { total: 1, main: 1, subagents: 0, hasSubagents: true });
});
