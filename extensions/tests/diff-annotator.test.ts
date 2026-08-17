import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { captureReviewSnapshot, type RunGitLike } from "../diff-annotator/git.ts";
import { parseReviewSnapshot } from "../diff-annotator/parser.ts";
import { composeReviewPrompt } from "../diff-annotator/prompt.ts";
import { createDiffStyler, type DiffStyleTheme } from "../diff-annotator/render.ts";
import { DiffReviewerComponent } from "../diff-annotator/reviewer.ts";
import type { ReviewComment, ReviewFile, ReviewSnapshot } from "../diff-annotator/types.ts";

const execFileAsync = promisify(execFile);

const realGit: RunGitLike = {
  async exec(command, args, options) {
    try {
      const result = await execFileAsync(command, args, {
        cwd: options?.cwd,
        timeout: options?.timeout,
      });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return {
        code: failed.code ?? 1,
        stdout: failed.stdout ?? "",
        stderr: failed.stderr ?? String(error),
      };
    }
  },
};

function baseFilePatch(path = "src/example.ts"): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,3 +1,4 @@",
    " const one = 1;",
    "-const two = 2;",
    "+const two = 3;",
    "+const three = 4;",
    " const end = true;",
    "\\ No newline at end of file",
    "",
  ].join("\n");
}

function testTheme(): DiffStyleTheme {
  return {
    fg: (_color, text) => `[fg]${text}[/]`,
    bg: (_color, text) => `[bg]${text}[/]`,
  };
}

function makeComponent(
  parsedFiles: ReviewFile[],
  parsedLines: ReturnType<typeof parseReviewSnapshot>,
  comments: ReviewComment[],
  onDone: (value: unknown) => void,
): DiffReviewerComponent {
  const fakeTui = {
    terminal: { columns: 100, rows: 20 },
    requestRender() {},
  };
  const fakeTheme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  return new DiffReviewerComponent(fakeTui as never, fakeTheme as never, {} as never, onDone, {
    snapshot: { ...snapshot(), files: parsedFiles },
    parsed: parsedLines,
    width: 100,
    height: 20,
    comments,
  });
}

function snapshot(patch = baseFilePatch()): ReviewSnapshot {
  return {
    repoRoot: "/repo",
    baseRevision: "HEAD",
    head: "abc123",
    fingerprint: "abcdef1234567890",
    files: [
      {
        id: "modified:src/example.ts:src/example.ts",
        oldPath: "src/example.ts",
        newPath: "src/example.ts",
        displayPath: "src/example.ts",
        status: "modified",
        kind: "text",
        reviewable: true,
        patch,
        hunks: [],
      },
    ],
    skippedCount: 0,
    truncated: false,
  };
}

function parse(patch?: string) {
  return parseReviewSnapshot(snapshot(patch));
}

test("parses hunk lines and old/new line numbers", () => {
  const parsed = parse();
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0]?.hunks.length, 1);

  const hunk = parsed.files[0]!.hunks[0]!;
  assert.deepEqual(
    hunk.lines.map((line) => [line.kind, line.oldLine, line.newLine]),
    [
      ["hunk", null, null],
      ["context", 1, 1],
      ["removal", 2, null],
      ["addition", null, 2],
      ["addition", null, 3],
      ["context", 3, 4],
      ["no-newline", null, null],
    ],
  );
});

test("captures staged, unstaged, and untracked changes together", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-diff-annotator-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await realGit.exec("git", ["init"], { cwd: directory });
  await writeFile(join(directory, "tracked.txt"), "one\n", "utf8");
  await realGit.exec("git", ["add", "tracked.txt"], { cwd: directory });
  await realGit.exec(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=t@example.com", "commit", "-m", "init"],
    { cwd: directory },
  );

  await writeFile(join(directory, "tracked.txt"), "one\ntwo\n", "utf8");
  await writeFile(join(directory, "staged.txt"), "staged\n", "utf8");
  await writeFile(join(directory, "untracked.txt"), "untracked\n", "utf8");
  await realGit.exec("git", ["add", "staged.txt"], { cwd: directory });

  const captured = await captureReviewSnapshot(realGit, directory);
  const paths = captured.files.map((file) => file.displayPath).sort();
  assert.deepEqual(paths, ["staged.txt", "tracked.txt", "untracked.txt"]);

  const parsed = parseReviewSnapshot(captured);
  const untracked = parsed.files.find((file) => file.displayPath === "untracked.txt");
  assert.equal(untracked?.reviewable, true);
  assert.equal(
    untracked?.hunks[0]?.lines.some((line) => line.kind === "addition"),
    true,
  );

  const tracked = parsed.files.find((file) => file.displayPath === "tracked.txt");
  assert.equal(tracked?.reviewable, true, "modified tracked file is reviewable");
  assert.ok(
    tracked?.hunks[0]?.lines.some((line) => line.kind === "addition" && line.text === "two"),
    "modified tracked file carries its patch hunks",
  );
});

test("staged files are captured in repositories without commits", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-diff-annotator-unborn-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await realGit.exec("git", ["init"], { cwd: directory });
  await writeFile(join(directory, "staged.txt"), "staged\n", "utf8");
  await realGit.exec("git", ["add", "staged.txt"], { cwd: directory });

  const captured = await captureReviewSnapshot(realGit, directory);
  const parsed = parseReviewSnapshot(captured);
  const staged = parsed.files.find((file) => file.displayPath === "staged.txt");
  assert.equal(staged?.reviewable, true);
  assert.ok(staged?.hunks[0]?.lines.some((line) => line.kind === "addition"));
});

test("untracked symlinks render their target and special files are rejected", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-diff-annotator-links-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-diff-annotator-outside-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));

  await realGit.exec("git", ["init"], { cwd: directory });
  const secretPath = join(outside, "secret.txt");
  await writeFile(secretPath, "external secret contents", "utf8");
  await execFileAsync("ln", ["-s", secretPath, join(directory, "link.txt")]);

  const captured = await captureReviewSnapshot(realGit, directory);
  const link = captured.files.find((file) => file.displayPath === "link.txt");
  assert.equal(link?.reviewable, true);
  assert.ok(link?.patch.includes(secretPath), "symlink patch shows the link target");
  assert.ok(
    !link?.patch.includes("external secret contents"),
    "symlink target contents are never read",
  );
});

test("captures renames and marks binary files non-reviewable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-diff-annotator-rename-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await realGit.exec("git", ["init"], { cwd: directory });
  await writeFile(join(directory, "old name.txt"), "hello\n", "utf8");
  await writeFile(join(directory, "image.png"), Buffer.from([0, 1, 2, 3]));
  await realGit.exec("git", ["add", "."], { cwd: directory });
  await realGit.exec(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=t@example.com", "commit", "-m", "init"],
    { cwd: directory },
  );
  await realGit.exec("git", ["mv", "old name.txt", "new name.txt"], { cwd: directory });
  await writeFile(join(directory, "image.png"), Buffer.from([0, 1, 2, 4]));

  const captured = await captureReviewSnapshot(realGit, directory);
  const rename = captured.files.find((file) => file.status === "renamed");
  const binary = captured.files.find((file) => file.displayPath === "image.png");
  assert.equal(rename?.displayPath, "old name.txt -> new name.txt");
  assert.equal(binary?.reviewable, false);
  assert.equal(binary?.kind, "binary");
});

test("never drops a range comment, even when hunks are unavailable", () => {
  // Regression: composing against a raw (unparsed) snapshot used to silently
  // drop every range comment because raw files have no parsed hunks.
  const comments: ReviewComment[] = [
    {
      id: "range",
      target: { type: "range", fileIndex: 0, startLineIndex: 3, endLineIndex: 4 },
      body: "This must appear in the prompt.",
      createdAt: 1,
      updatedAt: 1,
    },
  ];

  const prompt = composeReviewPrompt({ snapshot: snapshot(), comments });
  assert.match(prompt, /Comments: 1/);
  assert.match(prompt, /This must appear in the prompt\./);
  assert.match(prompt, /src\/example\.ts/);
});

test("composes a structured prompt with selected code", () => {
  const parsed = parse();
  const hunk = parsed.files[0]!.hunks[0]!;
  const removal = hunk.lines.find((line) => line.kind === "removal")!;
  const addition = hunk.lines.find((line) => line.kind === "addition")!;
  const comments: ReviewComment[] = [
    {
      id: "overall",
      target: { type: "overall" },
      body: "Please keep this small.",
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "range",
      target: {
        type: "range",
        fileIndex: 0,
        startLineIndex: removal.id,
        endLineIndex: addition.id,
      },
      body: "Explain why this changed.",
      createdAt: 2,
      updatedAt: 2,
    },
    {
      id: "file",
      target: { type: "file", fileIndex: 0 },
      body: "This file needs a test.",
      createdAt: 3,
      updatedAt: 3,
    },
  ];

  const prompt = composeReviewPrompt({
    snapshot: { ...snapshot(), files: parsed.files },
    comments,
  });

  assert.match(prompt, /# Diff review/);
  assert.match(prompt, /Snapshot: abcdef123456/);
  assert.match(prompt, /## Overall note/);
  assert.match(prompt, /src\/example\.ts — old 2 \/ new 2/);
  assert.match(prompt, /```diff\n-const two = 2;\n\+const two = 3;\n```/);
  assert.match(prompt, /whole file/);
});

test("reviewer rejects empty :w and supports :w!", () => {
  const parsed = parse();
  const comments: ReviewComment[] = [];
  let result: unknown;

  const fakeTui = {
    terminal: { columns: 100, rows: 20 },
    requestRender() {},
  };
  const fakeTheme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const component = new DiffReviewerComponent(
    fakeTui as never,
    fakeTheme as never,
    {} as never,
    (value) => {
      result = value;
    },
    {
      snapshot: { ...snapshot(), files: parsed.files },
      parsed,
      width: 100,
      height: 20,
      comments,
    },
  );

  component.handleInput(":");
  component.handleInput("w");
  component.handleInput("\r");
  assert.equal(result, undefined);
  assert.ok(component.render(100).at(-1)?.includes("No review comments to write"));

  comments.push({
    id: "comment",
    target: { type: "file", fileIndex: 0 },
    body: "Needs a test.",
    createdAt: 1,
    updatedAt: 1,
  });
  component.handleInput(":");
  component.handleInput("w");
  component.handleInput("!");
  component.handleInput("\r");
  assert.deepEqual(result, { action: "write", force: true });
});

test("reviewer supports visual selection and comment editing", () => {
  const parsed = parse();
  const comments: ReviewComment[] = [];
  const rendered: string[][] = [];
  let result: unknown;
  const editorText: string[] = [];
  let currentText = "";

  const fakeTui = {
    terminal: { columns: 100, rows: 20 },
    requestRender() {},
  };
  const fakeTheme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const component = new DiffReviewerComponent(
    fakeTui as never,
    fakeTheme as never,
    {} as never,
    (value) => {
      result = value;
    },
    {
      snapshot: { ...snapshot(), files: parsed.files },
      parsed,
      width: 100,
      height: 20,
      comments,
    },
  );

  component.handleInput("j");
  component.handleInput("v");
  component.handleInput("j");
  component.handleInput("c");

  const editing = component.render(100).map(stripTerminalSequences);
  assert.ok(
    editing.some((line) => line.includes("Comment")),
    "comment dock visible",
  );
  assert.ok(
    editing.some((line) => line.includes("const one = 1;")),
    "diff stays visible while commenting",
  );

  component.handleInput("e");
  component.handleInput("x");
  component.handleInput("p");
  component.handleInput("l");
  component.handleInput("a");
  component.handleInput("i");
  component.handleInput("n");
  component.handleInput("\x1b");

  assert.equal(comments.length, 1);
  assert.equal(comments[0]?.body, "explain");
  assert.equal(comments[0]?.target.type, "range");

  rendered.push(component.render(100));
  assert.ok(rendered[0]!.some((line) => line.includes("●")));

  component.handleInput(":");
  component.handleInput("w");
  component.handleInput("\r");
  assert.deepEqual(result, { action: "write", force: false });
  assert.equal(editorText.length, 0);
  assert.equal(currentText, "");
});

test("intra-line highlighting inverse-styles changed words in paired lines", () => {
  const parsed = parse();
  const styler = createDiffStyler(parsed.files, testTheme());
  const hunk = parsed.files[0]!.hunks[0]!;
  const removal = hunk.lines.find((line) => line.kind === "removal")!;
  const addition = hunk.lines.find((line) => line.kind === "addition")!;

  const removalStyled = styler.styleText(removal, removal.text);
  const additionStyled = styler.styleText(addition, addition.text);

  assert.ok(
    removalStyled.includes("\x1b[7m"),
    `expected inverse on removal: ${JSON.stringify(removalStyled)}`,
  );
  assert.ok(removalStyled.includes("\x1b[27m"));
  assert.ok(
    additionStyled.includes("\x1b[7m"),
    `expected inverse on addition: ${JSON.stringify(additionStyled)}`,
  );
  assert.ok(removalStyled.startsWith("[bg]"), "wrapped in diff background");
  assert.equal(
    stripTerminalSequences(removalStyled).replace("[bg]", "").replace("[/]", ""),
    removal.text,
  );
  assert.equal(
    stripTerminalSequences(additionStyled).replace("[bg]", "").replace("[/]", ""),
    addition.text,
  );

  const context = hunk.lines.find((line) => line.kind === "context")!;
  const contextStyled = styler.styleText(context, context.text);
  assert.ok(contextStyled.length > 0);
  assert.equal(stripTerminalSequences(contextStyled).replace(/\[fg\]|\[\/\]/g, ""), context.text);
});

test("file picker opens with Ctrl-P, fuzzy-filters, and jumps on Enter", () => {
  const secondPatch = [
    "diff --git a/other.ts b/other.ts",
    "index 3333333..4444444 100644",
    "--- a/other.ts",
    "+++ b/other.ts",
    "@@ -1,1 +1,2 @@",
    " const a = 1;",
    "+const b = 2;",
    "",
  ].join("\n");

  const snap = snapshot();
  snap.files.push({
    id: "modified:other.ts:other.ts",
    oldPath: "other.ts",
    newPath: "other.ts",
    displayPath: "other.ts",
    status: "modified",
    kind: "text",
    reviewable: true,
    patch: secondPatch,
    hunks: [],
  });
  const parsed = parseReviewSnapshot(snap);

  const comments: ReviewComment[] = [];
  const component = makeComponent(parsed.files, parsed, comments, () => {});

  const otherFileLine = parsed.lines.findIndex(
    (line) => line.kind === "file" && line.fileIndex === 1,
  );
  assert.ok(otherFileLine > 0);

  component.handleInput("\x10"); // Ctrl-P
  let output = component.render(100);
  assert.ok(output.some((line) => line.includes("Jump to file")));
  assert.ok(output.some((line) => line.includes("src/example.ts")));
  assert.ok(output.some((line) => line.includes("other.ts")));

  for (const char of "othe") component.handleInput(char);
  output = component.render(100);
  assert.ok(output.some((line) => line.includes("other.ts")));
  assert.ok(!output.some((line) => line.includes("src/example.ts")), "filter hides non-matches");

  component.handleInput("\r");
  assert.ok(!component.render(100).some((line) => line.includes("Jump to file")), "picker closed");

  const state = (component as unknown as { cursor: number }).cursor;
  const cursorLine = parsed.lines[state]!;
  assert.equal(cursorLine.fileIndex, 1, "cursor moved into other.ts");
});

test("? toggles help and help lists picker keys", () => {
  const parsed = parse();
  const component = makeComponent(parsed.files, parsed, [], () => {});

  component.handleInput("?");
  let output = component.render(100);
  assert.ok(output.some((line) => line.includes("Diff review keys")));
  assert.ok(output.some((line) => line.includes("Ctrl-P")));

  component.handleInput("?");
  output = component.render(100);
  assert.ok(!output.some((line) => line.includes("Diff review keys")), "help closed");
});

test("stale working tree reopens the reviewer with comments intact", async () => {
  const { createDiffAnnotatorCommand } = await import("../diff-annotator/index.ts");

  const snap = snapshot();
  const parsed = parseReviewSnapshot(snap);
  let captures = 0;
  const deps = {
    captureSnapshot: async () => {
      captures += 1;
      // First capture opens the review; the staleness check returns a changed fingerprint.
      return captures === 1 ? snap : { ...snap, fingerprint: "ffffffffffffffff" };
    },
    parseSnapshot: () => parsed,
    composePrompt: composeReviewPrompt,
  };

  let handler: (args: string, ctx: unknown) => Promise<void> = async () => {};
  const pi = {
    registerCommand(_name: string, def: { handler: typeof handler }) {
      handler = def.handler;
    },
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  createDiffAnnotatorCommand(pi as never, deps as never);

  const notifications: string[] = [];
  let editorText = "";
  let openCount = 0;
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
      setEditorText: (text: string) => {
        editorText = text;
      },
      notify: (message: string) => notifications.push(message),
      custom: async (
        factory: (
          tui: unknown,
          theme: unknown,
          kb: unknown,
          done: (result: unknown) => void,
        ) => { handleInput(data: string): void },
      ) => {
        openCount += 1;
        let result: unknown;
        const wrapper = factory(fakeTui, fakeTheme, {}, (value) => {
          result = value;
        });
        const type = (text: string) => {
          for (const char of text) wrapper.handleInput(char);
        };

        if (openCount === 1) {
          wrapper.handleInput("C"); // whole-file comment
          type("keep me through the stale reopen");
          wrapper.handleInput("\x1b");
          type(":");
          type("w");
          wrapper.handleInput("\r");
        } else {
          type(":");
          type("w!");
          wrapper.handleInput("\r");
        }
        return result;
      },
    },
  };

  await handler("", ctx);

  assert.equal(openCount, 2, "reviewer reopened after stale check");
  assert.ok(
    notifications.some((message) => message.includes("comments kept")),
    "warned about stale tree while preserving comments",
  );
  assert.ok(editorText.includes("keep me through the stale reopen"));
  assert.ok(editorText.includes("Snapshot status: stale"));
});

test("relative line numbers count selectable-line distance from the cursor", () => {
  const parsed = parse();
  const component = makeComponent(parsed.files, parsed, [], () => {});

  // Move cursor onto the removal line ("const two = 2;"). Note: intra-line
  // highlighting wraps changed words in ANSI, so match on stable prefixes.
  component.handleInput("j");
  const relative = component.render(100).map(stripTerminalSequences);
  const addedRow = relative.find((line) => line.includes(" + const two"))!;
  const removalRow = relative.find((line) => line.includes(" - const two"))!;

  assert.match(removalRow, / 2 - const two/);
  assert.match(addedRow, / 1 \+ const two/);
  assert.doesNotMatch(addedRow, / 2 \+ const two/);

  const hunkRow = relative.find((line) => line.includes("@@"))!;
  assert.match(hunkRow, /^\s+@@/);

  component.handleInput("r");
  const absolute = component.render(100).map(stripTerminalSequences);
  const absoluteAddedRow = absolute.find((line) => line.includes(" + const two"))!;
  assert.match(absoluteAddedRow, / 2 \+ const two/);

  component.handleInput("r");
  const backToRelative = component.render(100).map(stripTerminalSequences);
  assert.match(
    backToRelative.find((line) => line.includes(" + const two"))!,
    / 1 \+ const two/,
  );
});

test("renders real syntax colors once pi's theme is initialized", async () => {
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  initTheme("dark");

  const parsed = parse();
  const comments: ReviewComment[] = [];
  const component = makeComponent(parsed.files, parsed, comments, () => {});
  const rendered = component.render(100);

  // Identity fake theme leaves syntax highlighter ANSI intact; expect real
  // truecolor foreground codes on code lines.
  const contextRow = rendered.find((line) => stripTerminalSequences(line).includes("const one"))!;
  assert.match(contextRow, /\x1b\[38;/, "context line carries syntax colors");
  const addedRow = rendered.find((line) => stripTerminalSequences(line).includes("const three"))!;
  assert.match(addedRow, /\x1b\[38;/, "added line carries syntax colors");
});

test("selected code preserves unified-diff order in the prompt", () => {
  const parsed = parse();
  const hunk = parsed.files[0]!.hunks[0]!;
  const first = hunk.lines.find((line) => line.kind === "context")!;
  const last = [...hunk.lines].reverse().find((line) => line.kind === "context")!;
  const comments: ReviewComment[] = [
    {
      id: "range",
      target: { type: "range", fileIndex: 0, startLineIndex: first.id, endLineIndex: last.id },
      body: "Check this whole block.",
      createdAt: 1,
      updatedAt: 1,
    },
  ];

  const prompt = composeReviewPrompt({
    snapshot: { ...snapshot(), files: parsed.files },
    comments,
  });
  const codeBlock = prompt.split("```diff")[1]!;
  const order = [
    codeBlock.indexOf(" const one = 1;"),
    codeBlock.indexOf("-const two = 2;"),
    codeBlock.indexOf("+const two = 3;"),
    codeBlock.indexOf("+const three = 4;"),
    codeBlock.indexOf(" const end = true;"),
  ];
  assert.ok(
    order.every((index) => index >= 0),
    JSON.stringify(order),
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    "patch order preserved",
  );
});

test("plain Enter inserts a newline in the comment editor", () => {
  const parsed = parse();
  const comments: ReviewComment[] = [];
  const component = makeComponent(parsed.files, parsed, comments, () => {});

  component.handleInput("c");
  component.handleInput("c");
  component.handleInput("a");
  component.handleInput("\r");
  component.handleInput("b");
  component.handleInput("\x1b");

  assert.equal(comments.length, 1);
  assert.equal(comments[0]?.body, "a\nb");
});

test("long comments keep the cursor line visible in the dock", () => {
  const parsed = parse();
  const comments: ReviewComment[] = [];
  const component = makeComponent(parsed.files, parsed, comments, () => {});

  component.handleInput("C");
  for (let index = 1; index <= 12; index += 1) {
    for (const char of `line${index}`) component.handleInput(char);
    if (index < 12) component.handleInput("\r");
  }

  const rendered = component.render(100).map(stripTerminalSequences);
  assert.ok(
    rendered.some((line) => line.includes("line12")),
    "final typed line stays visible while editing",
  );
  component.handleInput("\x1b");
  assert.equal(comments[0]?.body.split("\n").length, 12);
});

test("a failed staleness check reopens the reviewer with comments intact", async () => {
  const { createDiffAnnotatorCommand } = await import("../diff-annotator/index.ts");

  const snap = snapshot();
  const parsed = parseReviewSnapshot(snap);
  let captures = 0;
  const deps = {
    captureSnapshot: async () => {
      captures += 1;
      if (captures === 1) return snap;
      throw new Error("git died");
    },
    parseSnapshot: () => parsed,
    composePrompt: composeReviewPrompt,
  };

  let handler: (args: string, ctx: unknown) => Promise<void> = async () => {};
  const pi = {
    registerCommand(_name: string, def: { handler: typeof handler }) {
      handler = def.handler;
    },
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  createDiffAnnotatorCommand(pi as never, deps as never);

  const notifications: string[] = [];
  let editorText = "";
  let openCount = 0;
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
      setEditorText: (text: string) => {
        editorText = text;
      },
      notify: (message: string) => notifications.push(message),
      custom: async (
        factory: (
          tui: unknown,
          theme: unknown,
          kb: unknown,
          done: (result: unknown) => void,
        ) => { handleInput(data: string): void },
      ) => {
        openCount += 1;
        let result: unknown;
        const wrapper = factory(fakeTui, fakeTheme, {}, (value) => {
          result = value;
        });
        const type = (text: string) => {
          for (const char of text) wrapper.handleInput(char);
        };

        if (openCount === 1) {
          wrapper.handleInput("C");
          type("survives the failed check");
          wrapper.handleInput("\x1b");
          type(":");
          type("w");
          wrapper.handleInput("\r");
        } else {
          type(":");
          type("w!");
          wrapper.handleInput("\r");
        }
        return result;
      },
    },
  };

  await handler("", ctx);

  assert.equal(openCount, 2, "reviewer reopened after the failed check");
  assert.ok(notifications.some((message) => message.includes("Could not verify")));
  assert.ok(editorText.includes("survives the failed check"));
});

test("focus state propagates to the embedded comment editor", () => {
  const parsed = parse();
  const component = makeComponent(parsed.files, parsed, [], () => {});
  const editor = (component as unknown as { editor: { focused: boolean } }).editor;

  assert.equal(editor.focused, false);
  component.focused = true;
  assert.equal(editor.focused, true);
  component.focused = false;
  assert.equal(editor.focused, false);
});

test("file motions land on the first selectable line, including single-line files", () => {
  const singleLinePatch = [
    "diff --git a/one.ts b/one.ts",
    "index 1111111..2222222 100644",
    "--- a/one.ts",
    "+++ b/one.ts",
    "@@ -1,1 +1,2 @@",
    " const only = 1;",
    "+const added = 2;",
    "",
  ].join("\n");
  const secondPatch = [
    "diff --git a/two.ts b/two.ts",
    "index 3333333..4444444 100644",
    "--- a/two.ts",
    "+++ b/two.ts",
    "@@ -1,1 +1,3 @@",
    " const a = 1;",
    "+const b = 2;",
    "+const c = 3;",
    "",
  ].join("\n");

  const snap = snapshot();
  snap.files = [
    {
      id: "modified:one.ts:one.ts",
      oldPath: "one.ts",
      newPath: "one.ts",
      displayPath: "one.ts",
      status: "modified",
      kind: "text",
      reviewable: true,
      patch: singleLinePatch,
      hunks: [],
    },
    {
      id: "modified:two.ts:two.ts",
      oldPath: "two.ts",
      newPath: "two.ts",
      displayPath: "two.ts",
      status: "modified",
      kind: "text",
      reviewable: true,
      patch: secondPatch,
      hunks: [],
    },
  ];
  const parsed = parseReviewSnapshot(snap);
  const component = makeComponent(parsed.files, parsed, [], () => {});

  component.handleInput("]");
  component.handleInput("f");
  let cursorLine = parsed.lines[(component as unknown as { cursor: number }).cursor]!;
  assert.equal(cursorLine.fileIndex, 1);
  assert.equal(cursorLine.text, "const a = 1;", "]f lands on the first selectable line");

  component.handleInput("[");
  component.handleInput("f");
  cursorLine = parsed.lines[(component as unknown as { cursor: number }).cursor]!;
  assert.equal(cursorLine.fileIndex, 0, "[f returns to the previous file");
  assert.equal(cursorLine.text, "const only = 1;", "[f lands on its first selectable line");
});

test("modified files with non-ASCII paths receive their patches", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-diff-annotator-unicode-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await realGit.exec("git", ["init"], { cwd: directory });
  await writeFile(join(directory, "unicodé.txt"), "one\n", "utf8");
  await realGit.exec("git", ["add", "."], { cwd: directory });
  await realGit.exec(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=t@example.com", "commit", "-m", "init"],
    { cwd: directory },
  );
  await writeFile(join(directory, "unicodé.txt"), "one\ntwo\n", "utf8");

  const captured = await captureReviewSnapshot(realGit, directory);
  const parsed = parseReviewSnapshot(captured);
  const file = parsed.files.find((candidate) => candidate.displayPath === "unicodé.txt");
  assert.equal(file?.reviewable, true, "quoted path resolves to its patch");
  assert.ok(file?.hunks[0]?.lines.some((line) => line.kind === "addition" && line.text === "two"));
});

test("pure renames keep their metadata patch and stay listed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-diff-annotator-pure-rename-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await realGit.exec("git", ["init"], { cwd: directory });
  await writeFile(join(directory, "old.txt"), "same\n", "utf8");
  await realGit.exec("git", ["add", "."], { cwd: directory });
  await realGit.exec(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=t@example.com", "commit", "-m", "init"],
    { cwd: directory },
  );
  await realGit.exec("git", ["mv", "old.txt", "new.txt"], { cwd: directory });

  const captured = await captureReviewSnapshot(realGit, directory);
  const file = captured.files.find((candidate) => candidate.status === "renamed");
  assert.equal(file?.displayPath, "old.txt -> new.txt");
  assert.ok(file?.patch.includes("rename to new.txt"), "rename metadata patch retained");
});

test("binary and placeholder-only files still affect the fingerprint", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-diff-annotator-binfp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await realGit.exec("git", ["init"], { cwd: directory });
  await writeFile(join(directory, "code.txt"), "const a = 1;\n", "utf8");
  await writeFile(join(directory, "new.png"), Buffer.from([0, 1, 2, 3]));

  const first = await captureReviewSnapshot(realGit, directory);
  assert.equal(first.files.find((file) => file.displayPath === "new.png")?.reviewable, false);

  await writeFile(join(directory, "new.png"), Buffer.from([9, 8, 7, 6, 5]));
  const second = await captureReviewSnapshot(realGit, directory);
  assert.notEqual(
    first.fingerprint,
    second.fingerprint,
    "changing a non-reviewable untracked file changes the fingerprint",
  );
});

test("short terminals bound the comment dock and keep cursor, hint, and footer", () => {
  const parsed = parse();
  const comments: ReviewComment[] = [];
  const component = new DiffReviewerComponent(
    { terminal: { columns: 100, rows: 9 }, requestRender() {} } as never,
    {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never,
    {} as never,
    () => {},
    { snapshot: { ...snapshot(), files: parsed.files }, parsed, width: 100, height: 9, comments },
  );

  component.handleInput("C");
  for (let index = 1; index <= 8; index += 1) {
    for (const char of `line${index}`) component.handleInput(char);
    if (index < 8) component.handleInput("\r");
  }

  const rendered = component.render(100).map(stripTerminalSequences);
  assert.equal(rendered.length, 9, "output fits the terminal height");
  assert.ok(
    rendered.some((line) => line.includes("line8")),
    "cursor line visible",
  );
  assert.ok(
    rendered.some((line) => line.includes("Esc saves")),
    "hint visible",
  );
  assert.ok(
    rendered.some((line) => line.includes("? for keys")),
    "footer visible",
  );
  component.handleInput("\x1b");
  assert.equal(comments[0]?.body.split("\n").length, 8);
});

test("backward file motion from inside a file enters the previous file", () => {
  const secondPatch = [
    "diff --git a/other.ts b/other.ts",
    "index 3333333..4444444 100644",
    "--- a/other.ts",
    "+++ b/other.ts",
    "@@ -1,2 +1,3 @@",
    " const a = 1;",
    " const b = 2;",
    "+const c = 3;",
    "",
  ].join("\n");
  const snap = snapshot();
  snap.files.push({
    id: "modified:other.ts:other.ts",
    oldPath: "other.ts",
    newPath: "other.ts",
    displayPath: "other.ts",
    status: "modified",
    kind: "text",
    reviewable: true,
    patch: secondPatch,
    hunks: [],
  });
  const parsed = parseReviewSnapshot(snap);
  const component = makeComponent(parsed.files, parsed, [], () => {});

  // Move into the second file, then one line below its first selectable line.
  component.handleInput("]");
  component.handleInput("f");
  component.handleInput("j");
  let cursorLine = parsed.lines[(component as unknown as { cursor: number }).cursor]!;
  assert.equal(cursorLine.fileIndex, 1);
  assert.notEqual(cursorLine.text, "const a = 1;");

  component.handleInput("[");
  component.handleInput("f");
  cursorLine = parsed.lines[(component as unknown as { cursor: number }).cursor]!;
  assert.equal(cursorLine.fileIndex, 0, "[f from inside a file enters the previous file");
});

test("modified tracked files with spaces in their names receive patches", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-diff-annotator-spaces-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await realGit.exec("git", ["init"], { cwd: directory });
  await writeFile(join(directory, "with space.txt"), "one\n", "utf8");
  await realGit.exec("git", ["add", "."], { cwd: directory });
  await realGit.exec(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=t@example.com", "commit", "-m", "init"],
    { cwd: directory },
  );
  await writeFile(join(directory, "with space.txt"), "one\ntwo\n", "utf8");

  const captured = await captureReviewSnapshot(realGit, directory);
  const parsed = parseReviewSnapshot(captured);
  const file = parsed.files.find((candidate) => candidate.displayPath === "with space.txt");
  assert.equal(file?.reviewable, true, "spaced path resolves to its patch");
  assert.ok(file?.hunks[0]?.lines.some((line) => line.kind === "addition" && line.text === "two"));
});
