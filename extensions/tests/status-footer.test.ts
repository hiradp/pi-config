import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  compactDirectory,
  modelDisplayName,
  sessionCost,
  sessionCosts,
} from "../ui/status-footer.ts";

test("compacts nested workspace paths", () => {
  assert.equal(
    compactDirectory("planetscale/src/.workspaces/pgbouncer-read-only"),
    "planetscale⎇pgbouncer-read-only",
  );
  assert.equal(
    compactDirectory("planetscale/src/.workspaces/pgbouncer-read-only/packages/auth"),
    "planetscale⎇pgbouncer-read-only/…/auth",
  );
});

test("compacts other deep paths but preserves short paths", () => {
  assert.equal(compactDirectory("planetscale/src"), "planetscale/src");
  assert.equal(compactDirectory("planetscale/src/packages"), "planetscale/…/packages");
});

test("uses the model name and falls back to the final id segment", () => {
  assert.equal(
    modelDisplayName({ id: "accounts/fireworks/models/kimi-k3", name: "Kimi K3" }),
    "Kimi K3",
  );
  assert.equal(modelDisplayName({ id: "accounts/fireworks/models/kimi-k3" }), "kimi-k3");
  assert.equal(modelDisplayName(undefined), "no-model");
});

test("detects subagent sessions before child usage is available", () => {
  const ctx = {
    sessionManager: {
      getEntries() {
        return [
          {
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "toolCall", name: "subagent", arguments: {} }],
              usage: { cost: { total: 0.5 } },
            },
          },
        ];
      },
    },
  } as unknown as ExtensionContext;

  assert.deepEqual(sessionCosts(ctx), {
    total: 0.5,
    main: 0.5,
    subagents: 0,
    hasSubagents: true,
  });
});

test("ordinary nested tool usage remains attributed to the main session", () => {
  const ctx = {
    sessionManager: {
      getEntries() {
        return [
          {
            type: "message",
            message: {
              role: "assistant",
              content: [
                { type: "toolCall", name: "subagent", arguments: {} },
                { type: "toolCall", name: "summarize", arguments: {} },
              ],
              usage: { cost: { total: 1 } },
            },
          },
          {
            type: "message",
            message: {
              role: "toolResult",
              toolName: "summarize",
              usage: { cost: { total: 0.75 } },
            },
          },
          {
            type: "message",
            message: {
              role: "toolResult",
              toolName: "subagent",
              usage: { cost: { total: 2.25 } },
            },
          },
        ];
      },
    },
  } as unknown as ExtensionContext;

  assert.deepEqual(sessionCosts(ctx), {
    total: 4,
    main: 1.75,
    subagents: 2.25,
    hasSubagents: true,
  });
});

test("session cost includes all persisted usage", () => {
  const ctx = {
    sessionManager: {
      getEntries() {
        return [
          {
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "toolCall", name: "subagent", arguments: {} }],
              usage: { cost: { total: 1 } },
            },
          },
          {
            type: "message",
            message: {
              role: "toolResult",
              toolName: "subagent",
              usage: { cost: { total: 2 } },
            },
          },
          { type: "branch_summary", usage: { cost: { total: 3 } } },
          { type: "compaction", usage: { cost: { total: 4 } } },
        ];
      },
    },
  } as unknown as ExtensionContext;

  assert.equal(sessionCost(ctx), 10);
  assert.deepEqual(sessionCosts(ctx), {
    total: 10,
    main: 8,
    subagents: 2,
    hasSubagents: true,
  });
});
