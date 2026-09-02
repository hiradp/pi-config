import assert from "node:assert/strict";
import { test } from "node:test";
import { runChildProcess } from "../subagent/index.ts";

function runNode(script: string, options: Parameters<typeof runChildProcess>[2]) {
  return runChildProcess(process.execPath, ["-e", script], options);
}

test("decodes multibyte characters split across stdout chunks", async () => {
  const line = JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "🙂 done" }] },
  });
  const bytes = Buffer.from(`${line}\n`, "utf8");
  const split = bytes.indexOf(Buffer.from("🙂")) + 2;
  const script = [
    `const first = Buffer.from(${JSON.stringify(bytes.subarray(0, split).toString("base64"))}, "base64")`,
    `const second = Buffer.from(${JSON.stringify(bytes.subarray(split).toString("base64"))}, "base64")`,
    "process.stdout.write(first)",
    "setTimeout(() => process.stdout.write(second), 150)",
  ].join(";");

  const events: any[] = [];
  const outcome = await runNode(script, {
    cwd: process.cwd(),
    onEvent: (event) => events.push(event),
  });

  assert.equal(outcome.code, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].message.content[0].text, "🙂 done");
});

test("keeps only the tail of oversized stderr", async () => {
  const outcome = await runNode(
    'process.stderr.write("é".repeat(60_000) + "\\n");process.stderr.write("tail marker\\n")',
    { cwd: process.cwd(), maxStderrBytes: 4096 },
  );

  assert.equal(outcome.code, 0);
  assert.equal(outcome.stderrTruncated, true);
  assert.ok(Buffer.byteLength(outcome.stderr, "utf8") <= 4096);
  assert.ok(outcome.stderr.endsWith("tail marker\n"));
  assert.equal(outcome.stderr.includes("�"), false);
});
