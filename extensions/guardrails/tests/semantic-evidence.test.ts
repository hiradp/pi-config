import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerGuardrails } from "../index.ts";
import type { GuardrailAction } from "../policy.ts";
import {
  buildSemanticEvidence,
  SEMANTIC_EVIDENCE_LIMIT,
  semanticActionEvidence,
  type SemanticClassifier,
} from "../semantic-review.ts";
import { actionSummary } from "../state.ts";

let tempRoot: string;
let agentDir: string;
let previousAgentDir: string | undefined;

function bash(command: string): GuardrailAction {
  return { source: "agent", toolName: "bash", input: { command } };
}

const padding = `--jq '.title' # ${"x".repeat(470)}`;
const twoPartCommand = `gh pr view 42 --json title ${padding}\ngh pr merge 42 --admin --delete-branch`;

async function startWithClassifier(classifier: SemanticClassifier, confirm: boolean) {
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      guardrails: { semanticReview: { enabled: true, mode: "enforce", commands: ["gh"] } },
    }),
  );
  const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<any>>>();
  const notifications: string[] = [];
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => Promise<any>) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand() {},
    appendEntry() {},
    async exec() {
      return { stdout: "", stderr: "", code: 1, killed: false };
    },
  } as unknown as ExtensionAPI;
  registerGuardrails(pi, classifier);
  const ctx = {
    cwd: tempRoot,
    hasUI: true,
    signal: undefined,
    ui: {
      async confirm() {
        return confirm;
      },
      notify(message: string) {
        notifications.push(message);
      },
    },
    sessionManager: { getEntries: () => [], getBranch: () => [] },
  } as unknown as ExtensionContext;
  const emit = async (name: string, event: unknown) => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
    return result as any;
  };
  await emit("session_start", { reason: "startup" });
  return { emit, notifications };
}

before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "pi-guardrail-evidence-"));
  agentDir = join(tempRoot, "agent");
  await mkdir(agentDir);
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(tempRoot, { recursive: true, force: true });
});

describe("semantic review evidence", () => {
  test("sends the whole redacted command, not the display summary", () => {
    assert.equal(twoPartCommand.length > 500, true);
    const action = bash(`${twoPartCommand} --token hunter2`);
    const evidence = buildSemanticEvidence({
      action,
      requestingPolicy: "semantic-review",
      policyReason: "Command matched semantic review rule 'gh'.",
      cwd: tempRoot,
      latestUserInstruction: "Look at PR 42.",
      config: { enabled: true, mode: "enforce", timeoutMs: 1000, commands: ["gh"], paths: [] },
    });
    assert.equal(evidence.action.includes("gh pr merge 42 --admin --delete-branch"), true);
    assert.equal(evidence.action.includes("hunter2"), false);
    assert.equal(evidence.action.endsWith("…"), false);
    assert.equal(actionSummary(action).includes("gh pr merge"), false);
    assert.equal(actionSummary(action).length <= 505, true);
  });

  test("refuses to build evidence for commands beyond the bound", () => {
    const huge = `gh pr merge 42 ${"#".repeat(SEMANTIC_EVIDENCE_LIMIT)}`;
    assert.equal(semanticActionEvidence(bash(huge)), undefined);
    assert.equal(
      semanticActionEvidence(bash("gh pr merge 42"))?.startsWith("bash gh pr merge"),
      true,
    );
    assert.throws(
      () =>
        buildSemanticEvidence({
          action: bash(huge),
          requestingPolicy: "semantic-review",
          policyReason: "reason",
          cwd: tempRoot,
          latestUserInstruction: "x",
          config: { enabled: true, mode: "enforce", timeoutMs: 1000, commands: ["gh"], paths: [] },
        }),
      /bound/,
    );
  });

  test("asks the user instead of classifying an oversized command", async () => {
    let calls = 0;
    const classifier: SemanticClassifier = async () => {
      calls++;
      return { decision: "allow", reason: "Directly requested.", model: "test/reviewer" };
    };
    const { emit } = await startWithClassifier(classifier, false);
    const huge = `gh pr merge 42 ${"#".repeat(SEMANTIC_EVIDENCE_LIMIT)}`;
    const blocked = await emit("tool_call", { toolName: "bash", input: { command: huge } });
    assert.equal(calls, 0);
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /User declined guardrail confirmation/);
    assert.match(blocked.reason, /too large/);

    const allowed = await emit("tool_call", {
      toolName: "bash",
      input: { command: twoPartCommand },
    });
    assert.equal(calls, 1);
    assert.equal(allowed, undefined);
  });
});
