import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerClaude, {
  boundedDiagnostic,
  buildClaudeArgs,
  formatBoundedClaudeOutput,
  hasFailedClaudeResult,
  parseClaudeOutput,
  runBoundedCommand,
} from "../claude/index.ts";

test("builds a Claude Code invocation with opus and high effort by default", () => {
  assert.deepEqual(buildClaudeArgs({ prompt: "Review this change" }), {
    model: "opus",
    effort: "high",
    input: "Review this change",
    args: [
      "-p",
      "--no-session-persistence",
      "--safe-mode",
      "--tools",
      "",
      "--output-format",
      "json",
      "--model",
      "opus",
      "--effort",
      "high",
    ],
  });
});

test("accepts model and effort overrides without shell or option interpolation", () => {
  const prompt = "--version";
  const invocation = buildClaudeArgs({ prompt, model: " fable ", effort: "max" });

  assert.equal(invocation.model, "fable");
  assert.equal(invocation.effort, "max");
  assert.equal(invocation.input, prompt);
  assert.equal(invocation.args.includes(prompt), false);
  assert.deepEqual(invocation.args.slice(-4), ["--model", "fable", "--effort", "max"]);
});

test("parses Claude JSON output and usage", () => {
  const parsed = parseClaudeOutput(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "The implementation looks good.",
      total_cost_usd: 0,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
      },
    }),
  );

  assert.deepEqual(parsed, {
    text: "The implementation looks good.",
    isError: false,
    usage: {
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      totalTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
});

test("preserves usage on structured errors and falls back to plain output", () => {
  const structured = parseClaudeOutput(
    JSON.stringify({
      subtype: "error_during_execution",
      result: "failed",
      usage: { input_tokens: 2, output_tokens: 3 },
    }),
  );
  assert.equal(structured.text, "failed");
  assert.equal(structured.isError, true);
  assert.equal(structured.usage?.totalTokens, 5);

  assert.deepEqual(parseClaudeOutput("plain response"), {
    text: "plain response",
    isError: false,
  });
});

test("bounds model-visible output including its truncation notice", () => {
  const output = `${"line\n".repeat(3000)}${"🙂".repeat(20_000)}`;
  const persisted = formatBoundedClaudeOutput(output, "/tmp/pi-claude-test/output.txt");
  const unpersisted = formatBoundedClaudeOutput(output);

  for (const bounded of [persisted, unpersisted]) {
    assert.ok(bounded.truncation?.truncated);
    assert.ok(Buffer.byteLength(bounded.text, "utf8") <= 50 * 1024);
    assert.ok(bounded.text.split("\n").length <= 2000);
  }
  assert.match(persisted.text, /Full output saved to/);
  assert.match(unpersisted.text, /Full output was not saved/);

  const singleLine = formatBoundedClaudeOutput("🙂".repeat(20_000));
  assert.ok(singleLine.text.startsWith("🙂"));
  assert.ok(Buffer.byteLength(singleLine.text, "utf8") <= 50 * 1024);
  assert.match(singleLine.text, /Full output was not saved/);
});

test("preserves a useful diagnostic when the first line exceeds the byte limit", () => {
  const diagnostic = boundedDiagnostic(`failure: ${"x".repeat(10_000)}`, 1024);

  assert.ok(diagnostic.length > 0);
  assert.ok(Buffer.byteLength(diagnostic, "utf8") <= 1024);
  assert.match(diagnostic, /^failure:/);
});

test("pipes child input, bounds output, and escalates cancellation", async () => {
  const piped = await runBoundedCommand(
    process.execPath,
    ["-e", "process.stdin.pipe(process.stdout)"],
    { cwd: process.cwd(), input: "--version" },
  );
  assert.equal(piped.stdout, "--version");

  const overflow = await runBoundedCommand(
    process.execPath,
    ["-e", 'process.stdout.write("x".repeat(10_000))'],
    { cwd: process.cwd(), maxStdoutBytes: 100, killGraceMs: 20 },
  );
  assert.equal(overflow.stdoutOverflow, true);
  assert.ok(Buffer.byteLength(overflow.stdout, "utf8") <= 100);

  const controller = new AbortController();
  const pending = runBoundedCommand(
    process.execPath,
    ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
    {
      cwd: process.cwd(),
      signal: controller.signal,
      killGraceMs: 20,
    },
  );
  setTimeout(() => controller.abort(), 100);
  const canceled = await pending;

  assert.equal(canceled.aborted, true);
  assert.equal(canceled.killed, true);
  assert.equal(canceled.signal, "SIGKILL");
});

test("marks failed Claude tool results as errors without discarding their payload", () => {
  let handler: ((event: { toolName: string; details: unknown }) => unknown) | undefined;

  registerClaude({
    on(event: string, candidate: typeof handler) {
      if (event === "tool_result") handler = candidate;
    },
    registerTool() {},
  } as unknown as ExtensionAPI);

  assert.equal(hasFailedClaudeResult({ failed: true }), true);
  assert.equal(hasFailedClaudeResult({ failed: false }), false);
  assert.ok(handler);
  assert.deepEqual(handler({ toolName: "claude", details: { failed: true } }), {
    isError: true,
  });
  assert.equal(handler({ toolName: "claude", details: { failed: false } }), undefined);
});
