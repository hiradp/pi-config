import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReviewSnapshot } from "../diff-annotator/parser.ts";
import type { ReviewLine } from "../diff-annotator/types.ts";
import { baseFilePatch, snapshot, textFile } from "./diff-annotator-helpers.ts";

function patchOf(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

function summarize(lines: ReviewLine[]): [string, string, number | null, number | null][] {
  return lines.map((line) => [line.kind, line.text, line.oldLine, line.newLine]);
}

test("dashes and pluses at the start of changed lines stay hunk content", () => {
  const patch = patchOf([
    "diff --git a/q.sql b/q.sql",
    "index 30c9d02..8bbf091 100644",
    "--- a/q.sql",
    "+++ b/q.sql",
    "@@ -1,4 +1,4 @@",
    " select 1",
    "--- foo",
    " select 2",
    "+++ bar",
    " select 3",
  ]);
  const parsed = parseReviewSnapshot(snapshot(patch));

  assert.deepEqual(summarize(parsed.files[0]!.hunks[0]!.lines), [
    ["hunk", "@@ -1,4 +1,4 @@", null, null],
    ["context", "select 1", 1, 1],
    ["removal", "-- foo", 2, null],
    ["context", "select 2", 3, 2],
    ["addition", "++ bar", null, 3],
    ["context", "select 3", 4, 4],
  ]);
  assert.deepEqual(
    parsed.lines.filter((line) => line.kind === "meta").map((line) => line.text),
    ["--- a/q.sql", "+++ b/q.sql"],
    "headers before the hunk remain metadata",
  );
});

test("a type change parses both of its sections", () => {
  const patch = patchOf([
    "diff --git a/x b/x",
    "deleted file mode 100644",
    "index d95f3ad..0000000",
    "--- a/x",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-content",
    "diff --git a/x b/x",
    "new file mode 120000",
    "index 0000000..1de5659",
    "--- /dev/null",
    "+++ b/x",
    "@@ -0,0 +1 @@",
    "+target",
    "\\ No newline at end of file",
  ]);
  const parsed = parseReviewSnapshot({ ...snapshot(patch), files: [textFile("x", patch)] });
  const hunks = parsed.files[0]!.hunks;

  assert.equal(hunks.length, 2);
  assert.deepEqual(summarize(hunks[0]!.lines), [
    ["hunk", "@@ -1 +0,0 @@", null, null],
    ["removal", "content", 1, null],
  ]);
  assert.deepEqual(summarize(hunks[1]!.lines), [
    ["hunk", "@@ -0,0 +1 @@", null, null],
    ["addition", "target", null, 1],
    ["no-newline", "\\ No newline at end of file", null, null],
  ]);
  assert.deepEqual(
    parsed.lines.filter((line) => line.kind === "meta").map((line) => line.text),
    [
      "deleted file mode 100644",
      "--- a/x",
      "+++ /dev/null",
      "new file mode 120000",
      "--- /dev/null",
      "+++ b/x",
    ],
  );
  assert.ok(!parsed.lines.some((line) => line.kind === "context"), "metadata is never content");
});

test("control characters in diff content and paths are rendered visibly", () => {
  const patch = patchOf([
    "diff --git a/evil.txt b/evil.txt",
    "index 1111111..2222222 100644",
    "--- a/evil.txt",
    "+++ b/evil.txt",
    "@@ -1 +1,2 @@ fn \x1b[31mred",
    " \tkeep\ttabs",
    "+\x1b]52;c;aGVsbG8=\x07 \x1b[?1049l \x00 \x7f \x9b",
  ]);
  const file = textFile("evil.txt", patch, { displayPath: "ev\x1bil\x07.txt" });
  const parsed = parseReviewSnapshot({ ...snapshot(patch), files: [file] });

  const addition = parsed.lines.find((line) => line.kind === "addition")!;
  assert.equal(addition.text, "^[]52;c;aGVsbG8=^G ^[[?1049l ^@ ^? <9b>");
  const context = parsed.lines.find((line) => line.kind === "context")!;
  assert.equal(context.text, "\tkeep\ttabs", "tabs are kept");
  assert.equal(parsed.files[0]?.displayPath, "ev^[il^G.txt");
  assert.equal(parsed.lines[0]?.text, "ev^[il^G.txt");
  assert.equal(parsed.files[0]?.hunks[0]?.header, "@@ -1 +1,2 @@ fn ^[[31mred");
  for (const line of parsed.lines) {
    assert.doesNotMatch(line.text, /[\x00-\x08\x0a-\x1f\x7f-\x9f]/);
  }
});

test("blank hunk lines and carriage returns keep line numbers aligned", () => {
  const patch =
    "diff --git a/f b/f\nindex a1a53b5..068025d 100644\n--- a/f\n+++ b/f\n@@ -1,3 +1,5 @@\n a\n\n b\n+c\r\n+d\re\n";
  const parsed = parseReviewSnapshot(snapshot(patch));

  assert.deepEqual(summarize(parsed.files[0]!.hunks[0]!.lines.slice(1)), [
    ["context", "a", 1, 1],
    ["context", "", 2, 2],
    ["context", "b", 3, 3],
    ["addition", "c", null, 4],
    ["addition", "d^Me", null, 5],
  ]);
});

test("non-reviewable files are not parsed into hunks", () => {
  const file = textFile("big.txt", baseFilePatch("big.txt"), {
    kind: "too-large",
    reviewable: false,
    note: "Patch is larger than 256KB",
  });
  const parsed = parseReviewSnapshot({ ...snapshot(), files: [file] });

  assert.equal(parsed.files[0]?.hunks.length, 0);
  assert.deepEqual(
    parsed.lines.map((line) => [line.kind, line.text]),
    [
      ["file", "big.txt"],
      ["meta", "Patch is larger than 256KB"],
    ],
  );
});
