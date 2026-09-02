import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerClaude, { runBoundedCommand } from "../claude/index.ts";

test("kills a Claude child that exceeds its wall-clock limit", async () => {
  const result = await runBoundedCommand(
    process.execPath,
    ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
    { cwd: process.cwd(), timeoutMs: 100, killGraceMs: 20 },
  );

  assert.equal(result.timedOut, true);
  assert.equal(result.killed, true);
  assert.equal(result.aborted, false);
  // SIGTERM ends the child when it fires before the handler is installed; SIGKILL otherwise.
  assert.ok(result.signal === "SIGTERM" || result.signal === "SIGKILL");
});

test("execute consumes the arming so exactly one invocation runs per arming", async () => {
  type Execute = (
    toolCallId: string,
    params: { prompt: string },
    signal: undefined,
    onUpdate: undefined,
    ctx: { cwd: string },
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details: { failed?: boolean } }>;
  let activeTools = ["read"];
  let commandHandler: ((args: string, ctx: unknown) => unknown) | undefined;
  let execute: Execute | undefined;
  const prompts: string[] = [];

  registerClaude(
    {
      on() {},
      getActiveTools: () => activeTools,
      setActiveTools(names: string[]) {
        activeTools = names;
      },
      registerCommand(name: string, command: { handler: typeof commandHandler }) {
        if (name === "claude-tool") commandHandler = command.handler;
      },
      registerTool(definition: { execute: Execute }) {
        execute = definition.execute;
      },
    } as unknown as ExtensionAPI,
    async (_command, _args, options) => {
      prompts.push(options.input ?? "");
      return {
        stdout: JSON.stringify({ result: "Claude answered", is_error: false }),
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        aborted: false,
        timedOut: false,
        stdoutOverflow: false,
        stderrTruncated: false,
      };
    },
  );
  assert.ok(execute);
  assert.ok(commandHandler);
  const ctx = { cwd: process.cwd() };

  const disarmed = await execute("c0", { prompt: "first" }, undefined, undefined, ctx);
  assert.match(disarmed.content[0].text ?? "", /not armed/);
  assert.equal(disarmed.details.failed, true);
  assert.deepEqual(prompts, []);

  commandHandler("on", { ui: { notify() {} } });
  const [first, second] = await Promise.all([
    execute("c1", { prompt: "one" }, undefined, undefined, ctx),
    execute("c2", { prompt: "two" }, undefined, undefined, ctx),
  ]);

  assert.deepEqual(prompts, ["one"]);
  assert.equal(first.content[0].text, "Claude answered");
  assert.match(second.content[0].text ?? "", /not armed/);
  assert.equal(second.details.failed, true);
  assert.deepEqual(activeTools, ["read"]);
});
