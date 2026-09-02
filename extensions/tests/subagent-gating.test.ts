import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../subagent/agents.ts";
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

type Schema = { properties: Record<string, unknown> };

function captureTool(): { execute: Execute; parameters: Schema } {
  let execute: Execute | undefined;
  let parameters: Schema | undefined;
  registerSubagent({
    on() {},
    registerTool(definition: { execute: Execute; parameters: Schema }) {
      execute = definition.execute;
      parameters = definition.parameters;
    },
  } as unknown as ExtensionAPI);
  assert.ok(execute);
  assert.ok(parameters);
  return { execute, parameters };
}

function captureExecute(): Execute {
  return captureTool().execute;
}

function agentFile(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} agent\n---\nPrompt for ${name}.\n`,
  );
}

/** A user agent dir (via PI_CODING_AGENT_DIR) and a project with .pi/agents, both temporary. */
function agentFixture(userAgents: string[], projectAgents: string[]) {
  const root = mkdtempSync(join(tmpdir(), "pi-subagent-test-"));
  const userDir = join(root, "user");
  const projectDir = join(root, "project");
  mkdirSync(projectDir, { recursive: true });
  for (const name of userAgents) agentFile(join(userDir, "agents"), name);
  for (const name of projectAgents) agentFile(join(projectDir, CONFIG_DIR_NAME, "agents"), name);
  return {
    userDir,
    projectDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
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

test("a project agent never shadows a user agent of the same name", async () => {
  const fixture = agentFixture(["worker"], ["worker", "extra"]);
  try {
    await withEnv({ PI_CODING_AGENT_DIR: fixture.userDir }, async () => {
      const both = discoverAgents(fixture.projectDir, "both").agents;
      assert.deepEqual(both.map((agent) => [agent.name, agent.source]).sort(), [
        ["extra", "project"],
        ["worker", "user"],
      ]);
      assert.equal(discoverAgents(fixture.projectDir, "project").agents[0]?.source, "project");
    });
  } finally {
    fixture.cleanup();
  }
});

test("project agents always require trust and an interactive confirmation", async () => {
  const { execute, parameters } = captureTool();
  assert.equal("confirmProjectAgents" in parameters.properties, false);

  const fixture = agentFixture([], ["repo-agent"]);
  const confirmations: string[] = [];
  const context = (overrides: Partial<ExtensionContext>) =>
    fakeContext({
      cwd: fixture.projectDir,
      ui: {
        confirm: async (title: string) => {
          confirmations.push(title);
          return false;
        },
      } as unknown as ExtensionContext["ui"],
      ...overrides,
    });
  const dispatch = (ctx: ExtensionContext) =>
    execute(
      "call",
      { agent: "repo-agent", task: "Run", agentScope: "project", confirmProjectAgents: false },
      undefined,
      undefined,
      ctx,
    );

  try {
    await withEnv({ PI_CODING_AGENT_DIR: fixture.userDir }, async () => {
      const untrusted = await dispatch(context({ hasUI: true, isProjectTrusted: () => false }));
      assert.match(untrusted.content[0].text ?? "", /trusted/);
      assert.equal(hasFailedSubagentResult(untrusted.details), true);

      const headless = await dispatch(context({ hasUI: false, isProjectTrusted: () => true }));
      assert.match(headless.content[0].text ?? "", /confirmation/);
      assert.equal(hasFailedSubagentResult(headless.details), true);
      assert.deepEqual(confirmations, []);

      const declined = await dispatch(context({ hasUI: true, isProjectTrusted: () => true }));
      assert.match(declined.content[0].text ?? "", /not approved/);
      assert.equal(hasFailedSubagentResult(declined.details), true);
      assert.equal(confirmations.length, 1);
    });
  } finally {
    fixture.cleanup();
  }
});

test("refuses to dispatch from inside a subagent", async () => {
  const execute = captureExecute();
  const result = await withEnv({ PI_SUBAGENT_DEPTH: "1" }, () =>
    execute("call", { agent: "worker", task: "Nested work" }, undefined, undefined, fakeContext()),
  );

  assert.match(result.content[0].text ?? "", /already running as a subagent/);
  assert.equal(hasFailedSubagentResult(result.details), true);
});
