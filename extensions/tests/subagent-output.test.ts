import assert from "node:assert/strict";
import { test } from "node:test";
import { substitutePrevious, truncateOutput } from "../subagent/index.ts";

test("truncation notice states what was omitted without promising hidden output", () => {
  const truncated = truncateOutput("x".repeat(5000), 1024);

  assert.match(truncated, /\[Output truncated: \d+ bytes omitted\.\]$/);
  assert.doesNotMatch(truncated, /tool details/);
});

test("chain steps receive previous output verbatim, including dollar sequences", () => {
  const previous = "cost $$ and $& then $` plus $' end";

  assert.equal(
    substitutePrevious("Start {previous} again {previous}", previous),
    `Start ${previous} again ${previous}`,
  );
  assert.equal(substitutePrevious("No placeholder", previous), "No placeholder");
});
