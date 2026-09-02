import assert from "node:assert/strict";
import { test } from "node:test";
import { runBoundedCommand } from "../claude/index.ts";

test("kills a Claude child that exceeds its wall-clock limit", async () => {
  const result = await runBoundedCommand(
    process.execPath,
    ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
    { cwd: process.cwd(), timeoutMs: 100, killGraceMs: 20 },
  );

  assert.equal(result.timedOut, true);
  assert.equal(result.killed, true);
  assert.equal(result.aborted, false);
  assert.equal(result.signal, "SIGKILL");
});
