import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { parseReviewSnapshot } from "../diff-annotator/parser.ts";
import { composeReviewPrompt } from "../diff-annotator/prompt.ts";
import { createDiffStyler } from "../diff-annotator/render.ts";
import type { DiffReviewerComponent } from "../diff-annotator/reviewer.ts";
import type { ReviewComment } from "../diff-annotator/types.ts";
import { makeComponent, parse, snapshot, testTheme, textFile } from "./diff-annotator-helpers.ts";

function patchOf(path: string, header: string, body: string[]): string {
  return `${[
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    header,
    ...body,
  ].join("\n")}\n`;
}

function cursorOf(component: DiffReviewerComponent): number {
  return (component as unknown as { cursor: number }).cursor;
}

function footerOf(component: DiffReviewerComponent): string {
  return stripTerminalSequences(component.render(100).at(-1) ?? "");
}

function press(component: DiffReviewerComponent, ...keys: string[]): void {
  for (const key of keys) component.handleInput(key);
}

test("Esc and Ctrl-C refuse to discard comments", () => {
  const parsed = parse();
  const comments: ReviewComment[] = [
    { id: "c", target: { type: "file", fileIndex: 0 }, body: "keep", createdAt: 1, updatedAt: 1 },
  ];
  let result: unknown;
  const component = makeComponent(parsed.files, parsed, comments, (value) => {
    result = value;
  });

  press(component, "\x1b");
  assert.equal(result, undefined, "Esc keeps the review open");
  assert.ok(footerOf(component).includes("use :q! to discard"));

  press(component, "\x03");
  assert.equal(result, undefined, "Ctrl-C keeps the review open");

  press(component, ":", "q", "!", "\r");
  assert.deepEqual(result, { action: "cancel" }, ":q! is the explicit discard");
});

test("Esc clears pending keys and counts before it quits", () => {
  const parsed = parse();
  let result: unknown;
  const component = makeComponent(parsed.files, parsed, [], (value) => {
    result = value;
  });
  const start = cursorOf(component);

  press(component, "g");
  assert.equal(footerOf(component).trim(), "g", "the pending key is shown");
  press(component, "\x1b");
  assert.equal(result, undefined, "Esc with a pending key only cancels the key");
  assert.notEqual(footerOf(component).trim(), "g");

  press(component, "3", "\x1b");
  assert.equal(result, undefined, "Esc with a count only cancels the count");
  press(component, "j");
  assert.equal(cursorOf(component), start + 1, "the count did not survive Esc");

  press(component, "\x1b");
  assert.deepEqual(result, { action: "cancel" }, "a bare Esc with no comments quits");
});

test("intra-line highlighting skips very long lines", () => {
  const long = (word: string) => `${"a".repeat(1500)} ${word} ${"b".repeat(1500)}`;
  const patch = patchOf("x.txt", "@@ -1,2 +1,2 @@", [
    `-${long("old")}`,
    `+${long("new")}`,
    "-short old",
    "+short new",
  ]);
  const parsed = parseReviewSnapshot({ ...snapshot(patch), files: [textFile("x.txt", patch)] });
  const styler = createDiffStyler(parsed.files, testTheme());
  const [longRemoval, shortRemoval] = parsed.lines.filter((line) => line.kind === "removal");

  assert.ok(
    !styler.styleText(longRemoval!, longRemoval!.text).includes("\x1b[7m"),
    "long pairs keep plain colouring",
  );
  assert.ok(
    styler.styleText(shortRemoval!, shortRemoval!.text).includes("\x1b[7m"),
    "short pairs are still word-diffed",
  );
});

test("rendering a huge changed line pair does not stall", () => {
  const words = (seed: string) =>
    Array.from({ length: 12000 }, (_, index) => `${seed}${(index * 7919) % 1000}`).join(" ");
  const patch = patchOf("x.txt", "@@ -1 +1 @@", [`-${words("a")}`, `+${words("b")}`]);
  const parsed = parseReviewSnapshot({ ...snapshot(patch), files: [textFile("x.txt", patch)] });
  const component = makeComponent(parsed.files, parsed, [], () => {});

  const started = performance.now();
  component.render(100);
  assert.ok(performance.now() - started < 2000, "the first render stays responsive");
});

test("intra-line highlights align with tab-expanded text", () => {
  const patch = patchOf("notes.txt", "@@ -1 +1 @@", ["-\tfoo bar baz", "+\tfoo qux baz"]);
  const parsed = parseReviewSnapshot({ ...snapshot(patch), files: [textFile("notes.txt", patch)] });
  const component = makeComponent(parsed.files, parsed, [], () => {});

  const row = component
    .render(100)
    .find((line) => stripTerminalSequences(line).includes("foo bar"))!;
  const inverse = /\x1b\[7m(.*?)\x1b\[27m/.exec(row);
  assert.equal(inverse?.[1], "bar", "the highlight covers the changed word");
});

test("counts reach absolute lines and accept zero digits", () => {
  const body = [...Array.from({ length: 15 }, (_, index) => ` l${index + 1}`), "+added"];
  const patch = patchOf("long.ts", "@@ -1,15 +1,16 @@", body);
  const parsed = parseReviewSnapshot(snapshot(patch));
  const component = makeComponent(parsed.files, parsed, [], () => {});
  const textAtCursor = () => parsed.lines[cursorOf(component)]!.text;

  press(component, "1", "0", "j");
  assert.equal(textAtCursor(), "l11", "10j moves ten lines");

  // Absolute targets count buffer lines, as shown in the footer position:
  // the file header, two metadata lines, and the hunk header come first.
  press(component, "7", "G");
  assert.equal(textAtCursor(), "l3", "7G goes to buffer line 7");
  press(component, "G");
  assert.equal(textAtCursor(), "added", "G alone goes to the end");
  press(component, "5", "g", "g");
  assert.equal(textAtCursor(), "l1", "5gg goes to buffer line 5");
  press(component, "j", "g", "g");
  assert.equal(textAtCursor(), "l1", "gg alone goes to the start");
});

test("[c and ]c move between changed blocks", () => {
  const patch = patchOf("blocks.ts", "@@ -1,4 +1,6 @@", [" a", "-b", "+c", " d", "+e", "+f", " g"]);
  const parsed = parseReviewSnapshot(snapshot(patch));
  const component = makeComponent(parsed.files, parsed, [], () => {});
  const textAtCursor = () => parsed.lines[cursorOf(component)]!.text;

  press(component, "]", "c");
  assert.equal(textAtCursor(), "b");
  press(component, "]", "c");
  assert.equal(textAtCursor(), "e", "]c skips to the next block, not the next changed line");
  press(component, "]", "c");
  assert.equal(textAtCursor(), "e", "no block follows");
  press(component, "j");
  assert.equal(textAtCursor(), "f");
  press(component, "[", "c");
  assert.equal(textAtCursor(), "e", "[c goes to the start of the current block");
  press(component, "[", "c");
  assert.equal(textAtCursor(), "b", "[c then reaches the previous block");
});

test("a refused cross-hunk selection keeps its anchor", () => {
  const patch = patchOf("hunks.ts", "@@ -1,2 +1,2 @@", [
    " a",
    "-b",
    "+c",
    "@@ -10,2 +10,2 @@",
    " x",
    "-y",
    "+z",
  ]);
  const parsed = parseReviewSnapshot(snapshot(patch));
  const comments: ReviewComment[] = [];
  const component = makeComponent(parsed.files, parsed, comments, () => {});
  const textAtCursor = () => parsed.lines[cursorOf(component)]!.text;

  press(component, "v", "]", "h");
  assert.equal(textAtCursor(), "x");
  press(component, "c");
  assert.ok(footerOf(component).includes("Selection must stay within one hunk"));

  press(component, "k", "c");
  assert.ok(
    component.render(100).some((line) => stripTerminalSequences(line).includes("Esc saves")),
    "the comment editor opens once the selection is back inside one hunk",
  );
  press(component, "w", "h", "y", "\x1b");
  const first = parsed.lines.find((line) => line.text === "a")!;
  const last = parsed.lines.find((line) => line.text === "c")!;
  assert.deepEqual(comments[0]?.target, {
    type: "range",
    fileIndex: 0,
    startLineIndex: first.id,
    endLineIndex: last.id,
  });
});

test("help explains which comments dd can delete", () => {
  const parsed = parse();
  const component = makeComponent(parsed.files, parsed, [], () => {});

  // The comment keys sit below the first screen of help; page down once.
  press(component, "?", "\x04");
  const help = component.render(100).map(stripTerminalSequences);
  const line = help.find((candidate) => /^\s+dd\s/.test(candidate));
  assert.ok(line?.includes("line comment"), `dd help names line comments: ${line}`);
  assert.ok(
    help.some((candidate) => candidate.includes("saving them empty")),
    "help says how file and overall comments are removed",
  );
});

test("the header reports files skipped from the review", () => {
  const parsed = parse();
  const component = makeComponent(parsed.files, parsed, [], () => {}, { skippedCount: 2 });

  assert.ok(stripTerminalSequences(component.render(100)[0]!).includes("2 skipped"));
});

test("the command reports skipped files when the review opens", async () => {
  const { createDiffAnnotatorCommand } = await import("../diff-annotator/index.ts");

  const snap = snapshot();
  snap.files.push(
    textFile("image.png", "", { kind: "binary", reviewable: false, note: "Binary file" }),
  );
  snap.skippedCount = 1;
  snap.truncated = true;
  const parsed = parseReviewSnapshot(snap);
  const deps = {
    captureSnapshot: async () => snap,
    parseSnapshot: () => parsed,
    composePrompt: composeReviewPrompt,
  };

  let handler: (args: string, ctx: unknown) => Promise<void> = async () => {};
  const pi = {
    registerCommand(_name: string, def: { handler: typeof handler }) {
      handler = def.handler;
    },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  };
  createDiffAnnotatorCommand(pi as never, deps as never);

  const notifications: string[] = [];
  const fakeTui = { terminal: { columns: 100, rows: 30 }, requestRender() {} };
  const fakeTheme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const ctx = {
    mode: "tui",
    cwd: "/repo",
    isIdle: () => true,
    ui: {
      getEditorText: () => "",
      setEditorText: () => {},
      notify: (message: string) => notifications.push(message),
      custom: async (
        factory: (
          tui: unknown,
          theme: unknown,
          kb: unknown,
          done: (result: unknown) => void,
        ) => { handleInput(data: string): void },
      ) => {
        let result: unknown;
        const wrapper = factory(fakeTui, fakeTheme, {}, (value) => {
          result = value;
        });
        for (const char of ":q") wrapper.handleInput(char);
        wrapper.handleInput("\r");
        return result;
      },
    },
  };

  await handler("", ctx);

  assert.ok(
    notifications.some(
      (message) => /Skipped 1 of 2 changed files/.test(message) && message.includes("1MB"),
    ),
    JSON.stringify(notifications),
  );
});
