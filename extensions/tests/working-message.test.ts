import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CustomEntry,
  EntryRenderer,
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import workingMessageExtension, { formatDuration } from "../working-message.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface AppendedEntry {
  customType: string;
  data: unknown;
}

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

  workingMessageExtension(pi);
  handlers.get("before_agent_start")?.({}, ctx);
  handlers.get("agent_settled")?.({}, ctx);

  assert.equal(entryType, "working-message");
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.customType, "working-message");
  assert.equal(workingMessages.at(-1), undefined);

  const data = entries[0]?.data as { phrase: string; durationMs: number };
  assert.ok(data.phrase.length > 0);
  assert.ok(data.durationMs >= 0);
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
    `✓ ${data.phrase}... ${formatDuration(data.durationMs)}`,
  );
});
