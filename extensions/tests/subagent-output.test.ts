import assert from "node:assert/strict";
import { test } from "node:test";
import { truncateOutput } from "../subagent/index.ts";

test("truncation notice states what was omitted without promising hidden output", () => {
  const truncated = truncateOutput("x".repeat(5000), 1024);

  assert.match(truncated, /\[Output truncated: \d+ bytes omitted\.\]$/);
  assert.doesNotMatch(truncated, /tool details/);
});
