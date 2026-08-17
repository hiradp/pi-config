import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CustomEntry,
  EntryRenderer,
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import turnProgressExtension, {
  formatDuration,
  formatTimeOfDay,
  formatTokenCount,
  formatWorkingStats,
} from "../turn-progress.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface AppendedEntry {
  customType: string;
  data: unknown;
}

test("formats Claude-style working statistics", () => {
  assert.equal(formatTokenCount(22_900), "22.9k");
  assert.equal(formatWorkingStats(376_000, 22_900, null), "(6m 16s · ↓ 22.9k tokens)");
  assert.equal(
    formatWorkingStats(376_000, 22_900, 10_000),
    "(6m 16s · ↓ 22.9k tokens · thought for 10s)",
  );
});

test("formats the time of day in 12-hour clock", () => {
  assert.equal(formatTimeOfDay(new Date(2025, 0, 15, 15, 45).getTime()), "3:45 PM");
  assert.equal(formatTimeOfDay(new Date(2025, 0, 15, 0, 5).getTime()), "12:05 AM");
  assert.equal(formatTimeOfDay(new Date(2025, 0, 15, 12, 0).getTime()), "12:00 PM");
});

test("persists the completed working message in the session transcript", () => {
  const handlers = new Map<string, Handler>();
  const entries: AppendedEntry[] = [];
  const workingMessages: Array<string | undefined> = [];
  let entryType: string | undefined;
  let entryRenderer: EntryRenderer | undefined;

  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerEntryRenderer(customType: string, renderer: EntryRenderer) {
      entryType = customType;
      entryRenderer = renderer;
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
  } as unknown as ExtensionAPI;

  const theme = {
    fg(_color: string, text: string) {
      return text;
    },
  } as unknown as Theme;
  const ctx = {
    mode: "tui",
    ui: {
      theme,
      setWorkingMessage(message?: string) {
        workingMessages.push(message);
      },
    },
  } as unknown as ExtensionContext;

  turnProgressExtension(pi);
  handlers.get("before_agent_start")?.({}, ctx);
  handlers.get("agent_settled")?.({}, ctx);

  assert.equal(entryType, "working-message");
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.customType, "working-message");
  assert.match(workingMessages[0] ?? "", /… \(0s\)$/);
  assert.equal(workingMessages.at(-1), undefined);

  const data = entries[0]?.data as { durationMs: number; completedAtMs?: number };
  assert.ok(data.durationMs >= 0);
  assert.ok(data.completedAtMs !== undefined);
  assert.ok(entryRenderer);

  const component = entryRenderer(
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
  assert.equal(
    component.render(100)[0]?.trimEnd(),
    `✓ Done in ${formatDuration(data.durationMs)} at ${formatTimeOfDay(data.completedAtMs)}`,
  );
});
