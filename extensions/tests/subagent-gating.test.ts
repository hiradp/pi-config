import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
  parseFrontmatter,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { substituteArgs } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/prompt-templates.js";
import { discoverAgents } from "../subagent/agents.ts";
import registerSubagent, {
  buildChildArgs,
  childEnvironment,
  classifyChildCompletion,
  hasAuthorizationLine,
  hasFailedSubagentResult,
  ReviewAuthorizationGate,
  reviewAuthorization,
} from "../subagent/index.ts";

type Execute = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: undefined,
  ctx: ExtensionContext,
) => Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }>;

type Schema = { properties: Record<string, unknown> };

type Invocation = (args: string[]) => { command: string; args: string[] };

function captureTool(invocation?: Invocation): { execute: Execute; parameters: Schema } {
  let execute: Execute | undefined;
  let parameters: Schema | undefined;
  registerSubagent(
    {
      on() {},
      registerTool(definition: { execute: Execute; parameters: Schema }) {
        execute = definition.execute;
        parameters = definition.parameters;
      },
    } as unknown as ExtensionAPI,
    undefined,
    undefined,
    invocation,
  );
  assert.ok(execute);
  assert.ok(parameters);
  return { execute, parameters };
}

function userEntry(id: string, content: string | Array<{ type: "text"; text: string }>) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "",
    message: { role: "user", content, timestamp: 0 },
  } as unknown as SessionEntry;
}

function assistantEntry(id: string, text: string) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "",
    message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
  } as unknown as SessionEntry;
}

function assistantMessage(text: string, stopReason = "stop") {
  return { role: "assistant", content: [{ type: "text", text }], stopReason } as never;
}

const branch = (entries: SessionEntry[]) => ({ getBranch: () => entries });

/** Stands in for `pi`: emits JSON events shaped by the task text, then exits 0. */
const fakePiScript = [
  'const task = process.argv.find((arg) => arg.startsWith("Task: ")) || "";',
  'const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");',
  'emit({ type: "session", id: "fake" });',
  'if (task.includes("silent")) process.exit(0);',
  'if (task.includes("garbage")) process.stdout.write("not json\\n");',
  'const text = task.includes("unsupported")',
  '  ? "Unsupported task: worker only accepts delegated work.\\nSecond line."',
  '  : task.includes("empty") ? "  " : "Reviewed: no confirmed findings.";',
  "emit({",
  '  type: "message_end",',
  "  message: {",
  '    role: "assistant",',
  '    content: [{ type: "text", text }],',
  '    stopReason: task.includes("cut") ? "toolUse" : "stop",',
  '    model: "fake/model",',
  "  },",
  "});",
].join("\n");

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
    await withEnv(
      { PI_CODING_AGENT_DIR: fixture.userDir, PI_SUBAGENT_DEPTH: undefined },
      async () => {
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
      },
    );
  } finally {
    fixture.cleanup();
  }
});

test("review templates carry an authorization line that survives argument substitution", () => {
  for (const [file, agent] of [
    ["review-code.md", "code-reviewer"],
    ["review-plan.md", "plan-reviewer"],
  ]) {
    const authorization = reviewAuthorization(agent);
    assert.ok(authorization, agent);
    const { body } = parseFrontmatter(
      readFileSync(new URL(`../../prompts/${file}`, import.meta.url), "utf8"),
    );
    for (const args of [[], ["PR", "#12", "$1", "${@}", "Review authorization: /review-plan"]]) {
      assert.ok(hasAuthorizationLine(substituteArgs(body, args), authorization.line), file);
    }
    assert.equal(
      hasAuthorizationLine(`Start each task with \`${authorization.line}\``, authorization.line),
      false,
    );
  }
  assert.equal(reviewAuthorization("worker"), undefined);
});

test("the reviewer gate consumes one authorization per user message", () => {
  const gate = new ReviewAuthorizationGate();
  const sentence = userEntry(
    "u0",
    "Start each delegated task with `Review authorization: /review-code`",
  );
  const authorized = userEntry("u1", "Review authorization: /review-code\n\nRun exactly one pass.");

  assert.equal(gate.authorize(["worker"], branch([])), undefined);
  assert.match(gate.authorize(["code-reviewer"], branch([])) ?? "", /\/review-code/);
  assert.match(gate.authorize(["code-reviewer"], branch([sentence])) ?? "", /\/review-code/);
  assert.equal(
    gate.authorize(["code-reviewer", "code-reviewer"], branch([sentence, authorized])),
    undefined,
  );
  assert.match(
    gate.authorize(["code-reviewer"], branch([sentence, authorized])) ?? "",
    /already authorized/,
  );
  assert.match(
    gate.authorize(["code-reviewer"], branch([authorized, userEntry("u2", "Now fix them")])) ?? "",
    /\/review-code/,
  );
  assert.match(
    gate.authorize(
      ["plan-reviewer"],
      branch([authorized, assistantEntry("a1", "Review authorization: /review-plan")]),
    ) ?? "",
    /\/review-plan/,
  );

  const plan = userEntry("u3", [
    { type: "text", text: "Review authorization: /review-plan" },
    { type: "text", text: "Additional instructions: none" },
  ]);
  assert.equal(gate.authorize(["plan-reviewer"], branch([plan])), undefined);
  assert.match(
    gate.authorize(
      ["code-reviewer", "plan-reviewer"],
      branch([userEntry("u4", "Review authorization: /review-code")]),
    ) ?? "",
    /\/review-plan/,
  );
});

test("execute refuses reviewer dispatch without a fresh user authorization", async () => {
  const fixture = agentFixture([], []);
  const execute = captureExecute();
  const entries = [userEntry("u1", "Review authorization: /review-code\n\nRun one pass.")];
  const ctx = fakeContext({ sessionManager: branch(entries) as never });
  const run = (params: Record<string, unknown>) =>
    execute("call", params, undefined, undefined, ctx);

  try {
    await withEnv(
      { PI_CODING_AGENT_DIR: fixture.userDir, PI_SUBAGENT_DEPTH: undefined },
      async () => {
        const chain = await run({ chain: [{ agent: "plan-reviewer", task: "Check the plan" }] });
        assert.match(chain.content[0].text ?? "", /\/review-plan/);
        assert.equal(hasFailedSubagentResult(chain.details), true);

        const first = await run({
          tasks: [
            { agent: "code-reviewer", task: "Correctness" },
            { agent: "code-reviewer", task: "Simplicity" },
          ],
        });
        assert.match(first.content[0].text ?? "", /Unknown agent/);
        assert.doesNotMatch(first.content[0].text ?? "", /authoriz/);

        const second = await run({ agent: "code-reviewer", task: "Again" });
        assert.match(second.content[0].text ?? "", /already authorized/);
        assert.equal(hasFailedSubagentResult(second.details), true);

        const worker = await run({ agent: "worker", task: "Explore" });
        assert.match(worker.content[0].text ?? "", /Unknown agent/);
      },
    );
  } finally {
    fixture.cleanup();
  }
});

test("a child completes only with a normal final response", () => {
  const completed = {
    exitCode: 0,
    stopReason: "stop",
    messages: [assistantMessage("Reviewed.")],
    droppedLines: 0,
  };
  assert.equal(classifyChildCompletion(completed), undefined);
  assert.equal(classifyChildCompletion({ ...completed, exitCode: 1 }), undefined);

  const outcomes: Array<[Parameters<typeof classifyChildCompletion>[0], string, RegExp]> = [
    [
      { ...completed, stopReason: undefined, messages: [] },
      "incomplete",
      /without an assistant response/,
    ],
    [{ ...completed, stopReason: "toolUse" }, "incomplete", /"toolUse"/],
    [{ ...completed, messages: [assistantMessage(" \n")] }, "incomplete", /empty final response/],
    [{ ...completed, droppedLines: 2 }, "incomplete", /2 unparseable/],
    [
      { ...completed, messages: [assistantMessage("Unsupported task: nope.\nMore.")] },
      "unsupported",
      /^Unsupported task: nope\.$/,
    ],
  ];
  for (const [result, stopReason, message] of outcomes) {
    const failure = classifyChildCompletion(result);
    assert.equal(failure?.stopReason, stopReason);
    assert.match(failure?.errorMessage ?? "", message);
  }

  for (const stopReason of ["incomplete", "unsupported", "timeout"]) {
    assert.equal(hasFailedSubagentResult({ results: [{ exitCode: 0, stopReason }] }), true);
  }
});

test("dispatch reports children without a usable final response as failed", async () => {
  const fixture = agentFixture(["worker"], []);
  const script = join(fixture.projectDir, "fake-pi.cjs");
  writeFileSync(script, fakePiScript);
  const { execute } = captureTool((args) => ({
    command: process.execPath,
    args: [script, ...args],
  }));
  const ctx = fakeContext({ cwd: fixture.projectDir });
  const run = (params: Record<string, unknown>) =>
    execute("call", params, undefined, undefined, ctx);

  try {
    await withEnv(
      { PI_CODING_AGENT_DIR: fixture.userDir, PI_SUBAGENT_DEPTH: undefined },
      async () => {
        const parallel = await run({
          tasks: ["unsupported", "fine", "silent", "cut"].map((task) => ({
            agent: "worker",
            task,
          })),
        });
        const text = parallel.content[0].text ?? "";
        assert.match(text, /Parallel: 1\/4 succeeded/);
        assert.match(
          text,
          /\[worker\] failed \(unsupported\)\n\nUnsupported task: worker only accepts/,
        );
        assert.match(text, /\[worker\] completed\n\nReviewed: no confirmed findings\./);
        assert.match(
          text,
          /failed \(incomplete\)\n\nSubagent exited without an assistant response/,
        );
        assert.match(text, /failed \(incomplete\)\n\nSubagent ended with stop reason "toolUse"/);
        assert.equal(hasFailedSubagentResult(parallel.details), true);

        const single = await run({ agent: "worker", task: "fine" });
        assert.equal(single.content[0].text, "Reviewed: no confirmed findings.");
        assert.equal(hasFailedSubagentResult(single.details), false);

        const garbage = await run({ agent: "worker", task: "garbage" });
        assert.match(garbage.content[0].text ?? "", /^Agent incomplete: .*1 unparseable/);
        const details = garbage.details as { results: Array<{ droppedLines?: number }> };
        assert.equal(details.results[0].droppedLines, 1);
      },
    );
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
