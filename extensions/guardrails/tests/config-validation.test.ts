import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadGuardrailsConfig, parseGuardrailsSettings } from "../config.ts";
import guardrails from "../index.ts";

interface FakeRuntime {
  handlers: Map<string, Array<(event: any, ctx: any) => Promise<any>>>;
  commands: Map<string, (args: string, ctx: any) => Promise<void>>;
  notifications: Array<{ message: string; level: string }>;
  pi: ExtensionAPI;
}

let tempRoot: string;
let agentDir: string;
let previousAgentDir: string | undefined;

function createRuntime(): FakeRuntime {
  const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<any>>>();
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const notifications: Array<{ message: string; level: string }> = [];
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => Promise<any>) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, command.handler);
    },
    appendEntry() {},
    async exec() {
      return { stdout: "", stderr: "", code: 1, killed: false };
    },
  } as unknown as ExtensionAPI;
  return { handlers, commands, notifications, pi };
}

function createContext(runtime: FakeRuntime, hasUI = true): ExtensionContext {
  return {
    cwd: tempRoot,
    hasUI,
    signal: undefined,
    ui: {
      async confirm() {
        return false;
      },
      notify(message: string, level: string) {
        runtime.notifications.push({ message, level });
      },
    },
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
    },
  } as unknown as ExtensionContext;
}

async function emit(runtime: FakeRuntime, name: string, event: unknown, ctx: ExtensionContext) {
  let result: unknown;
  for (const handler of runtime.handlers.get(name) ?? []) result = await handler(event, ctx);
  return result as any;
}

async function start(settings?: unknown, hasUI = true) {
  if (settings !== undefined) {
    await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));
  }
  const runtime = createRuntime();
  guardrails(runtime.pi);
  const ctx = createContext(runtime, hasUI);
  await emit(runtime, "session_start", { reason: "startup" }, ctx);
  return { runtime, ctx };
}

before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "pi-guardrail-config-"));
  agentDir = join(tempRoot, "agent");
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

beforeEach(async () => {
  await rm(agentDir, { recursive: true, force: true });
  await mkdir(agentDir);
});

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(tempRoot, { recursive: true, force: true });
});

describe("configuration validation", { concurrency: false }, () => {
  test("treats a missing settings file as an invalid configuration", async () => {
    const result = await loadGuardrailsConfig();
    assert.equal(result.valid, false);
    assert.match(result.diagnostics[0] ?? "", /settings\.json: .*missing/);

    const { runtime, ctx } = await start();
    const write = await emit(
      runtime,
      "tool_call",
      { toolName: "write", input: { path: "notes.txt", content: "x" } },
      ctx,
    );
    const read = await emit(runtime, "tool_call", { toolName: "read", input: { path: "x" } }, ctx);
    assert.equal(write.block, true);
    assert.match(write.reason, /configuration is invalid/);
    assert.equal(read, undefined);
    assert.equal(
      runtime.notifications.some((entry) => /missing/.test(entry.message)),
      true,
    );

    await runtime.commands.get("guardrails")?.("status", ctx);
    assert.match(runtime.notifications.at(-1)?.message ?? "", /config: invalid/);
  });

  test("invalidates sections that contain unknown keys", () => {
    const result = parseGuardrailsSettings({
      guardrails: {
        commands: { block: ["wrangler"] },
        semanticReview: { enable: true },
      },
    });
    assert.equal(result.valid, false);
    assert.equal(
      result.diagnostics.some((line) => /Unknown guardrails\.commands\.block/.test(line)),
      true,
    );
    assert.equal(
      result.diagnostics.some((line) => /Unknown guardrails\.semanticReview\.enable/.test(line)),
      true,
    );
    assert.equal(parseGuardrailsSettings({ guardrails: { futurePolicy: true } }).valid, false);
    assert.equal(
      parseGuardrailsSettings({
        guardrails: { kubectl: { invocations: [{ command: "kubectl", skip: 1 }] } },
      }).valid,
      false,
    );
  });

  test("surfaces diagnostics at session start and fails closed", async () => {
    const { runtime, ctx } = await start({ guardrails: { commands: { block: ["wrangler"] } } });
    assert.equal(
      runtime.notifications.some(
        (entry) =>
          /Unknown guardrails\.commands\.block/.test(entry.message) && entry.level !== "info",
      ),
      true,
    );
    const result = await emit(
      runtime,
      "tool_call",
      { toolName: "bash", input: { command: "wrangler deploy" } },
      ctx,
    );
    assert.equal(result.block, true);
    assert.match(result.reason, /configuration is invalid/);
  });

  test("stays quiet at session start for a valid configuration", async () => {
    const { runtime } = await start({ guardrails: { commands: { blocked: ["wrangler"] } } });
    assert.deepEqual(runtime.notifications, []);
  });
});
