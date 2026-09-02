import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerSubagent, {
  buildChildArgs,
  childEnvironment,
  hasFailedSubagentResult,
} from "../subagent/index.ts";

type Execute = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: undefined,
  ctx: ExtensionContext,
) => Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }>;

function captureExecute(): Execute {
  let execute: Execute | undefined;
  registerSubagent({
    on() {},
    registerTool(definition: { execute: Execute }) {
      execute = definition.execute;
    },
  } as unknown as ExtensionAPI);
  assert.ok(execute);
  return execute;
}

function fakeContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    cwd: process.cwd(),
    hasUI: false,
    model: undefined,
    thinkingLevel: undefined,
    sessionManager: { getBranch: () => [] },
    isProjectTrusted: () => false,
    ui: {},
    ...overrides,
  } as unknown as ExtensionContext;
}

async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>) {
  const saved = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("children run without the subagent and claude tools and carry a depth marker", () => {
  const args = buildChildArgs({ tools: ["read", "grep"] }, { model: "provider/model" });
  const excludeIndex = args.indexOf("--exclude-tools");
  assert.ok(excludeIndex >= 0);
  assert.deepEqual(args[excludeIndex + 1].split(",").sort(), ["claude", "subagent"]);
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), [
    "--tools",
    "read,grep",
  ]);
  assert.ok(buildChildArgs({}, {}).includes("--exclude-tools"));

  assert.equal(childEnvironment({ PATH: "/bin" }).PI_SUBAGENT_DEPTH, "1");
  assert.equal(childEnvironment({ PI_SUBAGENT_DEPTH: "1" }).PI_SUBAGENT_DEPTH, "2");
  assert.equal(childEnvironment({ PATH: "/bin" }).PATH, "/bin");
});

test("refuses to dispatch from inside a subagent", async () => {
  const execute = captureExecute();
  const result = await withEnv({ PI_SUBAGENT_DEPTH: "1" }, () =>
    execute("call", { agent: "worker", task: "Nested work" }, undefined, undefined, fakeContext()),
  );

  assert.match(result.content[0].text ?? "", /already running as a subagent/);
  assert.equal(hasFailedSubagentResult(result.details), true);
});
