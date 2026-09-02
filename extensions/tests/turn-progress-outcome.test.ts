import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type {
  CustomEntry,
  EntryRenderer,
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import turnProgressExtension, { formatDuration, formatTimeOfDay } from "../ui/turn-progress.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface TurnProgressData {
  durationMs: number;
  completedAtMs?: number;
  outcome?: string;
}

function setup(t: TestContext) {
  const handlers = new Map<string, Handler>();
  const entries: unknown[] = [];
  let renderer: EntryRenderer | undefined;
  const setIntervalMock = t.mock.method(globalThis, "setInterval");
  const clearIntervalMock = t.mock.method(globalThis, "clearInterval");

  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerEntryRenderer(_customType: string, entryRenderer: EntryRenderer) {
      renderer = entryRenderer;
    },
    appendEntry(_customType: string, data: unknown) {
      entries.push(data);
    },
  } as unknown as ExtensionAPI;
  const theme = {
    fg(color: string, text: string) {
      return `<${color}>${text}</${color}>`;
    },
  } as unknown as Theme;
  const ctx = {
    mode: "tui",
    ui: { theme, setWorkingMessage() {} },
  } as unknown as ExtensionContext;

  turnProgressExtension(pi);

  const render = (data: TurnProgressData): string => {
    assert.ok(renderer);
    const component = renderer(
      {
        type: "custom",
        id: "entry-id",
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: "working-message",
        data,
      } satisfies CustomEntry,
      { expanded: false },
      theme,
    );
    assert.ok(component);
    return component.render(100)[0]?.trimEnd() ?? "";
  };

  const run = (stopReasons: string[]): TurnProgressData => {
    handlers.get("before_agent_start")?.({}, ctx);
    for (const stopReason of stopReasons) {
      handlers.get("message_end")?.(
        { message: { role: "assistant", usage: { output: 1 }, stopReason } },
        ctx,
      );
    }
    handlers.get("agent_settled")?.({}, ctx);
    assert.equal(entries.length, 1);
    return entries[0] as TurnProgressData;
  };

  const assertTimerCleared = () => {
    const timer = setIntervalMock.mock.calls[0]?.result;
    assert.ok(timer, "the working timer was started");
    assert.equal(clearIntervalMock.mock.calls.length, 1);
    assert.equal(clearIntervalMock.mock.calls[0]?.arguments[0], timer);
  };

  return { run, render, assertTimerCleared };
}

function finishedAt(data: TurnProgressData): string {
  assert.ok(data.completedAtMs !== undefined);
  return `${formatDuration(data.durationMs)} at ${formatTimeOfDay(data.completedAtMs)}`;
}

test("persists an aborted run as stopped in the warning colour", (t) => {
  const { run, render, assertTimerCleared } = setup(t);

  const data = run(["aborted"]);

  assert.equal(data.outcome, "aborted");
  assertTimerCleared();
  assert.equal(render(data), `<warning>■</warning> <dim>Stopped after ${finishedAt(data)}</dim>`);
});

test("persists a failed run as failed in the error colour", (t) => {
  const { run, render, assertTimerCleared } = setup(t);

  const data = run(["error"]);

  assert.equal(data.outcome, "failed");
  assertTimerCleared();
  assert.equal(render(data), `<error>✗</error> <dim>Failed after ${finishedAt(data)}</dim>`);
});

test("judges a retried run by its final message", (t) => {
  const { run, render, assertTimerCleared } = setup(t);

  const data = run(["error", "stop"]);

  assert.equal(data.outcome, "done");
  assertTimerCleared();
  assert.equal(render(data), `<success>✓</success> <dim>Done in ${finishedAt(data)}</dim>`);
});

test("renders entries recorded without an outcome as done", (t) => {
  const { render } = setup(t);

  assert.equal(render({ durationMs: 1_000 }), "<success>✓</success> <dim>Done in 1s</dim>");
});
