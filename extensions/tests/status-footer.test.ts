import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import statusFooter, {
  compactDirectory,
  modelDisplayName,
  sessionCost,
  sessionCosts,
} from "../ui/status-footer.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

async function settleRemoteRefreshes(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

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

test("remote status polling skips settled turns and uses explicit five-minute refreshes", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const handlers = new Map<string, Handler>();
  const intervals: Array<{ callback: () => void; delay: number }> = [];
  let quotaRequests = 0;
  let pullRequestRequests = 0;
  let clearedIntervals = 0;
  let branch = "main";
  let notifyBranchChange: (() => void) | undefined;
  let footer: { dispose(): void } | undefined;

  globalThis.fetch = (async () => {
    quotaRequests++;
    return new Response(JSON.stringify({ five_hour: { utilization: 25 } }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  globalThis.setInterval = ((callback: () => void, delay?: number) => {
    intervals.push({ callback, delay: delay ?? 0 });
    return intervals.length as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => {
    clearedIntervals++;
  }) as typeof clearInterval;

  const footerData = {
    getGitBranch() {
      return branch;
    },
    onBranchChange(callback: () => void) {
      notifyBranchChange = callback;
      return () => {
        notifyBranchChange = undefined;
      };
    },
  };
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    async exec() {
      pullRequestRequests++;
      return {
        code: 0,
        stdout: JSON.stringify({
          number: 42,
          state: "OPEN",
          isDraft: false,
          mergeStateStatus: "CLEAN",
          statusCheckRollup: [],
          latestReviews: [],
        }),
        stderr: "",
      };
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: "tui",
    cwd: "/repo",
    model: { provider: "anthropic", id: "claude" },
    modelRegistry: {
      async getProviderAuth() {
        return { auth: { apiKey: "oauth-token" }, source: "oauth" };
      },
    },
    ui: {
      setFooter(
        factory: (
          tui: { requestRender(): void },
          theme: object,
          data: typeof footerData,
        ) => { dispose(): void },
      ) {
        footer = factory({ requestRender() {} }, {}, footerData);
      },
    },
  } as unknown as ExtensionContext;

  try {
    statusFooter(pi);
    handlers.get("session_start")?.({}, ctx);
    await settleRemoteRefreshes();

    assert.equal(quotaRequests, 1);
    assert.equal(pullRequestRequests, 1);
    assert.equal(handlers.has("agent_settled"), false);

    handlers.get("agent_settled")?.({}, ctx);
    await settleRemoteRefreshes();
    assert.equal(quotaRequests, 1);
    assert.equal(pullRequestRequests, 1);

    handlers.get("model_select")?.({}, ctx);
    await settleRemoteRefreshes();
    assert.equal(quotaRequests, 2);
    assert.equal(pullRequestRequests, 1);

    branch = "feature";
    notifyBranchChange?.();
    await settleRemoteRefreshes();
    assert.equal(quotaRequests, 2);
    assert.equal(pullRequestRequests, 2);

    // The 2s git status poller runs alongside the two five-minute remote refreshes.
    assert.deepEqual(
      intervals.map(({ delay }) => delay),
      [2000, 5 * 60 * 1000, 5 * 60 * 1000],
    );
    for (const { callback } of intervals) callback();
    await settleRemoteRefreshes();
    assert.equal(quotaRequests, 3);
    assert.equal(pullRequestRequests, 3);
  } finally {
    footer?.dispose();
    globalThis.fetch = originalFetch;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }

  assert.equal(clearedIntervals, 3);
  assert.equal(notifyBranchChange, undefined);
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
