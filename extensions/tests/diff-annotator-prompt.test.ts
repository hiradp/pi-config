import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReviewSnapshot } from "../diff-annotator/parser.ts";
import { composeReviewPrompt } from "../diff-annotator/prompt.ts";
import { snapshot, textFile } from "./diff-annotator-helpers.ts";

test("selected code containing backtick fences stays inside its code block", () => {
  const patch = [
    "diff --git a/README.md b/README.md",
    "index 1111111..2222222 100644",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1,3 +1,3 @@",
    " ```",
    "-old",
    "+new",
    " ```",
    "",
  ].join("\n");
  const parsed = parseReviewSnapshot({ ...snapshot(patch), files: [textFile("README.md", patch)] });
  const hunk = parsed.files[0]!.hunks[0]!;
  const first = hunk.lines.find((line) => line.kind === "context")!;
  const last = [...hunk.lines].reverse().find((line) => line.kind === "context")!;

  const prompt = composeReviewPrompt({
    snapshot: { ...snapshot(patch), files: parsed.files },
    comments: [
      {
        id: "range",
        target: { type: "range", fileIndex: 0, startLineIndex: first.id, endLineIndex: last.id },
        body: "Check the fence.",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  });

  const block = prompt.slice(prompt.indexOf("Selected code:"), prompt.indexOf("Comment:"));
  const fences = block.split("\n").filter((line) => /^`{4,}/.test(line));
  assert.equal(fences.length, 2, "a fence longer than the content's backticks wraps the block");
  assert.ok(block.includes("\n ```\n-old\n+new\n ```\n"), "content fences are kept verbatim");
});
