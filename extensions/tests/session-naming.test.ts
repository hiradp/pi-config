import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  buildClassificationEvidence,
  fallbackClassification,
  formatSessionName,
  parseCategory,
  parseClassification,
  sessionUserRequests,
  titleFromSessionName,
} from "../session-naming/classifier.ts";
import sessionNaming from "../session-naming/index.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionCommandContext) => unknown;

function userEntry(id: string, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: text, timestamp: Date.now() },
  };
}

function fakeRuntime(options?: { initialName?: string; classifierAvailable?: boolean }) {
  const handlers = new Map<string, EventHandler>();
  const commands = new Map<string, CommandHandler>();
  const appended: Array<{ customType: string; data: unknown }> = [];
  const notifications: string[] = [];
  const entries: SessionEntry[] = [];
  const names: string[] = [];
  let name = options?.initialName;
  let completions = 0;

  const pi = {
    on(event: string, handler: EventHandler) {
      handlers.set(event, handler);
    },
    registerCommand(command: string, definition: { handler: CommandHandler }) {
      commands.set(command, definition.handler);
    },
    getSessionName() {
      return name;
    },
    setSessionName(next: string) {
      name = next;
      names.push(next);
    },
    appendEntry(customType: string, data: unknown) {
      appended.push({ customType, data });
    },
  } as unknown as ExtensionAPI;

  const model = {
    provider: "openai-codex",
    id: "gpt-5.6-luna",
    name: "Luna",
    api: "openai-codex-responses",
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => entries,
      getSessionFile: () => "/sessions/current.jsonl",
    },
    modelRegistry: {
      find: () => (options?.classifierAvailable === false ? undefined : model),
      hasConfiguredAuth: () => true,
      async complete() {
        completions++;
        return {
          role: "assistant",
          content: [
            {
              type: "text",
              text: '{"title":"Compare session naming approaches","category":"exploration"}',
            },
          ],
          stopReason: "stop",
          usage: { cost: { total: 0.001 } },
        };
      },
    },
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      async select() {
        return undefined;
      },
    },
    async waitForIdle() {},
  } as unknown as ExtensionCommandContext;

  sessionNaming(pi);
  return {
    handlers,
    commands,
    appended,
    notifications,
    entries,
    names,
    ctx,
    get completions() {
      return completions;
    },
  };
}

test("extracts user requests and bounds classifier evidence", () => {
  const entries = [
    userEntry("one", "First request"),
    {
      ...userEntry("assistant", "ignored"),
      message: {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "Assistant response" }],
        api: "test",
        provider: "test",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop" as const,
        timestamp: Date.now(),
      },
    },
    userEntry("two", "Second request"),
  ];

  assert.deepEqual(sessionUserRequests(entries), ["First request", "Second request"]);
  assert.match(buildClassificationEvidence(["x".repeat(9_000)]), /requests omitted/);
});

test("parses and formats the supported categories", () => {
  assert.deepEqual(
    parseClassification(
      'prefix {"title":"🔵 Compare session naming approaches!","category":"exploration"}',
    ),
    { title: "Compare session naming approaches", category: "exploration" },
  );
  assert.equal(
    formatSessionName({ title: "Refactor auth", category: "project" }),
    "🟢 Refactor auth",
  );
  assert.equal(titleFromSessionName("🔴 Investigate API latency"), "Investigate API latency");
  assert.equal(parseCategory("prod"), "production");
  assert.equal(parseCategory("explore"), "exploration");
  assert.equal(parseCategory("side"), undefined);
});

test("falls back to a bounded project title", () => {
  assert.deepEqual(
    fallbackClassification([
      "Implement the authentication middleware for the internal admin API today",
    ]),
    { title: "Implement the authentication middleware for the internal", category: "project" },
  );
});

test("automatically names a persisted TUI session after five user requests", async () => {
  const runtime = fakeRuntime();
  runtime.handlers.get("session_start")?.({}, runtime.ctx);

  for (let index = 1; index < 5; index++) {
    runtime.entries.push(userEntry(String(index), `Session naming request ${index}`));
    await runtime.handlers.get("agent_settled")?.({}, runtime.ctx);
    assert.equal(runtime.completions, 0);
  }

  runtime.entries.push(userEntry("five", "Use category colors"));
  await runtime.handlers.get("agent_settled")?.({}, runtime.ctx);
  assert.equal(runtime.completions, 1);
  assert.deepEqual(runtime.names, ["🔵 Compare session naming approaches"]);
  assert.equal(runtime.appended[0]?.customType, "session-naming:auto");
  assert.match(runtime.notifications[0] ?? "", /Session named 🔵/);

  await runtime.handlers.get("agent_settled")?.({}, runtime.ctx);
  assert.equal(runtime.completions, 1);
});

test("does not overwrite a manually named session", async () => {
  const runtime = fakeRuntime({ initialName: "🔴 Investigate latency" });
  runtime.entries.push(
    userEntry("one", "Investigate latency"),
    userEntry("two", "Check production"),
    userEntry("three", "Read recent logs"),
    userEntry("four", "Inspect the deployment"),
    userEntry("five", "Summarize the incident"),
  );
  runtime.handlers.get("session_start")?.({}, runtime.ctx);

  await runtime.handlers.get("agent_settled")?.({}, runtime.ctx);
  assert.equal(runtime.completions, 0);
  assert.deepEqual(runtime.names, []);
});

test("uses a deterministic project fallback when the classifier is unavailable", async () => {
  const runtime = fakeRuntime({ classifierAvailable: false });
  runtime.entries.push(
    userEntry("one", "Refactor authentication middleware"),
    userEntry("two", "Add regression tests"),
    userEntry("three", "Check the current handlers"),
    userEntry("four", "Update the implementation"),
    userEntry("five", "Run the test suite"),
  );
  runtime.handlers.get("session_start")?.({}, runtime.ctx);

  await runtime.handlers.get("agent_settled")?.({}, runtime.ctx);
  assert.deepEqual(runtime.names, ["🟢 Refactor authentication middleware"]);
});

test("changes the category without changing the title", async () => {
  const runtime = fakeRuntime({ initialName: "🔵 Compare session naming approaches" });
  runtime.handlers.get("session_start")?.({}, runtime.ctx);

  await runtime.commands.get("category")?.("production", runtime.ctx);
  assert.deepEqual(runtime.names, ["🔴 Compare session naming approaches"]);
  assert.equal(runtime.appended[0]?.customType, "session-naming:category");
});
