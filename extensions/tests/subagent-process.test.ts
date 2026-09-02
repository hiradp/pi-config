import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSubagent, {
  ChildProcessRegistry,
  classifyChildExit,
  runChildProcess,
  signalProcessTree,
} from "../subagent/index.ts";

function runNode(script: string, options: Parameters<typeof runChildProcess>[2]) {
  return runChildProcess(process.execPath, ["-e", script], options);
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Ignores SIGTERM and reports readiness as a JSON event once the handler is installed. */
const stubbornScript =
  'process.on("SIGTERM", () => {}); process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n"); setInterval(() => {}, 1000)';

function runStubborn(options: Parameters<typeof runChildProcess>[2]) {
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const outcome = runNode(stubbornScript, {
    ...options,
    onEvent: (event) => {
      if (event.type === "ready") markReady();
    },
  });
  return { outcome, ready };
}

test("kills a child that exceeds its wall-clock limit and reports the timeout", async () => {
  const outcome = await runNode(stubbornScript, {
    cwd: process.cwd(),
    timeoutMs: 100,
    killGraceMs: 20,
  });

  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.aborted, false);
  // SIGTERM ends the child when it fires before the handler is installed; SIGKILL otherwise.
  assert.ok(outcome.signal === "SIGTERM" || outcome.signal === "SIGKILL");

  const status = classifyChildExit(outcome.code, outcome.signal, false, 2_700_000);
  assert.equal(status.exitCode, 1);
  assert.equal(status.stopReason, "timeout");
  assert.match(status.errorMessage ?? "", /timed out after 45m 00s/);
  assert.equal(classifyChildExit(0, null, false, 2_700_000).exitCode, 1);
});

test("registry terminates every live child group on shutdown", async () => {
  const registry = new ChildProcessRegistry();
  const stubborn = runStubborn({ cwd: process.cwd(), registry });
  const polite = runNode("setInterval(() => {}, 1000)", { cwd: process.cwd(), registry });
  assert.equal(registry.size, 2);
  await stubborn.ready;

  await registry.shutdown(100);
  const [first, second] = await Promise.all([stubborn.outcome, polite]);

  assert.equal(first.signal, "SIGKILL");
  assert.equal(second.signal, "SIGTERM");
  assert.equal(registry.size, 0);
});

test("session shutdown reaps live subagents and exposes a per-child timeout", async () => {
  const registry = new ChildProcessRegistry(50);
  const handlers = new Map<string, (event: unknown) => unknown>();
  let parameters: { properties: Record<string, unknown> } | undefined;
  registerSubagent(
    {
      on(event: string, handler: (event: unknown) => unknown) {
        handlers.set(event, handler);
      },
      registerTool(definition: { parameters: { properties: Record<string, unknown> } }) {
        parameters = definition.parameters;
      },
    } as unknown as ExtensionAPI,
    undefined,
    registry,
  );

  assert.ok(parameters?.properties.timeoutMs);
  const child = runStubborn({ cwd: process.cwd(), registry, killGraceMs: 50 });
  assert.equal(registry.size, 1);
  await child.ready;

  await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" });
  const outcome = await child.outcome;

  assert.equal(outcome.signal, "SIGKILL");
  assert.equal(registry.size, 0);
});

test(
  "stops escalating once an aborted child exits and reports signal failures",
  { skip: process.platform === "win32" },
  async () => {
    const sent: string[] = [];
    const controller = new AbortController();
    const pending = runNode("setInterval(() => {}, 1000)", {
      cwd: process.cwd(),
      signal: controller.signal,
      killGraceMs: 50,
      signalTree: (pid, signal) => {
        sent.push(signal);
        signalProcessTree(pid, signal);
      },
    });
    await sleep(100);
    controller.abort();
    const outcome = await pending;
    await sleep(150);

    assert.equal(outcome.aborted, true);
    assert.equal(outcome.signal, "SIGTERM");
    assert.deepEqual(sent, ["SIGTERM"]);

    const failing = new AbortController();
    const unsignalled = runNode("setTimeout(() => {}, 300)", {
      cwd: process.cwd(),
      signal: failing.signal,
      killGraceMs: 20,
      signalTree: () => {
        throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
      },
    });
    await sleep(50);
    failing.abort();
    const reported = await unsignalled;

    assert.equal(reported.aborted, true);
    assert.equal(reported.code, 0);
    assert.match(reported.signalError ?? "", /Operation not permitted/);
  },
);

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
