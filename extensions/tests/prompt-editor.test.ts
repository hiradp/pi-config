import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters as strip } from "node:util";
import {
  getSelectListTheme,
  initTheme,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, getKeybindings, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { RadEditor } from "../ui/prompt-editor.ts";
import { uiPalette } from "../ui/palette.ts";

function editor() {
  initTheme("dark", false);
  let currentTheme = { name: "dark" } as Theme;
  const input = new RadEditor(
    { terminal: { rows: 30, columns: 80 }, requestRender() {} } as unknown as TUI,
    { borderColor: (text) => text, selectList: getSelectListTheme() },
    getKeybindings() as unknown as KeybindingsManager,
    () => currentTheme,
  );
  input.focused = true;
  input.setPaddingX(1);
  return {
    input,
    setTheme: (name: string) => {
      currentTheme = { name } as Theme;
    },
  };
}

function cursorColumn(lines: string[]): number {
  const line = lines.find((line) => line.includes(CURSOR_MARKER));
  assert.ok(line, "the focused editor must retain its IME cursor marker");
  return visibleWidth(line.slice(0, line.indexOf(CURSOR_MARKER)));
}

test("the prompt gutter preserves wrapped cursor positioning and vertical editing", () => {
  const { input } = editor();
  input.setText("abcdefghijk");
  let lines = input.render(12);
  assert.equal(cursorColumn(lines), 6);
  assert.match(strip(lines[1]!), /^ › abcdefgh/u);

  input.handleInput("X");
  input.render(12);
  input.handleInput("\x1b[A");
  input.handleInput("Y");
  assert.equal(input.getText(), "abcdYefghijkX");
  lines = input.render(12);
  assert.ok(lines.every((line) => visibleWidth(line) <= 12));

  input.setText("你好🤘");
  assert.equal(cursorColumn(input.render(20)), 9);
  for (const width of [0, 1, 2, 3, 4, 12, 80]) {
    assert.ok(input.render(width).every((line) => visibleWidth(line) <= width));
  }
});

test("only the marker changes for bash mode and light mode keeps a readable prompt", () => {
  const { input, setTheme } = editor();
  const dark = uiPalette({ name: "dark" } as Theme);
  input.setText("hello");
  const ordinary = input.render(40);
  assert.ok(ordinary[0]!.includes(dark.ansi.border));
  assert.ok(ordinary[1]!.includes(dark.fg("prompt", "›")));
  // Pi's thinking/bashing border assignments must not recolor the whole frame.
  input.borderColor = () => "LOUD";
  input.setText("!git status");
  const bash = input.render(40);
  assert.equal(bash[0], ordinary[0]);
  assert.ok(bash[1]!.includes(dark.fg("warning", "›")));
  assert.equal(input.getText(), "!git status");

  setTheme("rustic-light");
  input.invalidate();
  const light = uiPalette({ name: "rustic-light" } as Theme);
  const changed = input.render(40);
  assert.ok(changed[1]!.includes(light.ansi.text));
  assert.ok(!changed[1]!.includes(dark.ansi.text));
  assert.equal(cursorColumn(changed), cursorColumn(bash));
});

test("autocomplete stays selectable and keeps its own styling below the prompt", async () => {
  const { input } = editor();
  input.setAutocompleteProvider({
    getSuggestions: async () => ({
      prefix: "/lo",
      items: [{ value: "/loadout", label: "loadout" }],
    }),
    applyCompletion: () => ({ lines: ["/loadout "], cursorLine: 0, cursorCol: 9 }),
  });
  input.handleInput("/lo");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const lines = input.render(40);
  assert.match(lines.map(strip).join("\n"), /loadout/u);
  assert.equal(cursorColumn(lines), 6);
  input.handleInput("\t");
  assert.equal(input.getText(), "/loadout ");
});
