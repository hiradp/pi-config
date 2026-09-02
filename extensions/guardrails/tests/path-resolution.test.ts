import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_GUARDRAILS_CONFIG, type GuardrailsConfig } from "../config.ts";
import {
  analyzeShellMutations,
  matchesPathPattern,
  resolvePathForPolicy,
  shellMutationTargets,
} from "../path-policy.ts";
import { pathsPolicy } from "../policies/paths.ts";
import { selfProtectionPolicy } from "../policies/self-protection.ts";
import type { GuardrailAction, GuardrailPolicy } from "../policy.ts";

const pi = {} as ExtensionAPI;
const foldsCase = process.platform === "darwin" || process.platform === "win32";
let tempRoot: string;
let project: string;
let caseInsensitiveVolume = false;

function config(paths: GuardrailsConfig["paths"]): GuardrailsConfig {
  return {
    commands: { blockedCommands: [] },
    defaultBranch: { allowedRepositories: [] },
    kubectl: {
      allowedCommands: [...DEFAULT_GUARDRAILS_CONFIG.kubectl.allowedCommands],
      invocations: DEFAULT_GUARDRAILS_CONFIG.kubectl.invocations.map((entry) => ({ ...entry })),
    },
    paths,
    semanticReview: { ...DEFAULT_GUARDRAILS_CONFIG.semanticReview, commands: [], paths: [] },
  };
}

const rules = config({
  blocked: [".git", ".git/**"],
  confirm: [".env", "secrets/**"],
});

function bash(command: string): GuardrailAction {
  return { source: "agent", toolName: "bash", input: { command } };
}

async function outcome(
  policy: GuardrailPolicy,
  action: GuardrailAction,
  cwd = project,
): Promise<string> {
  const decision = await policy.check(action, { pi, cwd, config: rules, maintenance: false });
  return decision?.outcome ?? "allow";
}

before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "pi-guardrail-paths-"));
  project = join(tempRoot, "project");
  await mkdir(join(project, ".git", "hooks"), { recursive: true });
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(join(project, "secrets"), { recursive: true });
  await writeFile(join(project, ".git", "config"), "[core]\n");
  await writeFile(join(tempRoot, "CaseProbe"), "");
  caseInsensitiveVolume = existsSync(join(tempRoot, "caseprobe"));
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("directory changes inside a command", () => {
  test("resolves relative writes after a literal cd against the new directory", async () => {
    for (const command of [
      "cd .git && echo x > config",
      "cd .git; echo x > config",
      "cd .git\necho x > config",
      "(cd .git && echo x > config)",
      "cd ./src && cd ../.git && echo x > config",
      "pushd .git && echo x > config",
      "cd -- .git && echo x > config",
      "command cd .git && echo x > config",
      "builtin cd .git && echo x > config",
    ]) {
      assert.equal(await outcome(pathsPolicy, bash(command)), "block", command);
    }
    assert.equal(await outcome(pathsPolicy, bash("cd secrets && echo x > key.pem")), "confirm");
  });

  test("keeps ordinary directory changes allowed", async () => {
    for (const command of [
      "cd src && ls",
      "cd src && echo x > notes.txt",
      "cd .git && echo x > /tmp/elsewhere.txt",
      "(cd .git && ls) && echo x > notes.txt",
      "pushd .git && popd && echo x > notes.txt",
      "cd src; cd ..; echo x > notes.txt",
    ]) {
      assert.equal(await outcome(pathsPolicy, bash(command)), "allow", command);
    }
  });

  test("asks before relative writes that follow a non-literal cd", async () => {
    for (const command of [
      'cd "$DIR" && echo x > config',
      "cd $(mktemp -d) && echo x > config",
      "cd - && echo x > config",
      "cd ~someone && echo x > config",
      "cd $DIR; echo x > notes.txt",
    ]) {
      assert.equal(await outcome(pathsPolicy, bash(command)), "confirm", command);
      assert.equal(await outcome(selfProtectionPolicy, bash(command)), "confirm", command);
    }
    assert.equal(
      await outcome(pathsPolicy, bash("cd $DIR && echo x > /tmp/absolute.txt")),
      "allow",
    );
    assert.deepEqual(analyzeShellMutations('cd "$DIR" && echo x > config', project).unresolved, [
      "config",
    ]);
  });

  test("keeps the flat target list resolved against the last known directory", () => {
    const targets = shellMutationTargets("cd .git && echo x > config", project);
    assert.deepEqual(targets, [join(project, ".git", "config")]);
  });
});

describe("case-variant paths", () => {
  test("canonicalizes existing case variants through the native realpath", () => {
    assert.equal(
      resolvePathForPolicy(join(project, ".GIT", "config")),
      join(realpathSync.native(project), caseInsensitiveVolume ? ".git" : ".GIT", "config"),
    );
    assert.equal(
      resolvePathForPolicy(join(project, ".Git", "hooks", "pre-commit")),
      join(
        realpathSync.native(project),
        caseInsensitiveVolume ? ".git" : ".Git",
        "hooks",
        "pre-commit",
      ),
    );
  });

  test("matches path rules against case variants", { skip: !foldsCase }, async () => {
    assert.equal(matchesPathPattern(join(project, ".GIT", "config"), project, ".git/**"), true);
    assert.equal(matchesPathPattern(join(project, ".Git"), project, ".git"), true);
    assert.equal(
      matchesPathPattern(join(project, "SECRETS", "new.pem"), project, "secrets/**"),
      true,
    );
    assert.equal(matchesPathPattern(join(project, ".ENV"), project, ".env"), true);
    assert.equal(
      matchesPathPattern(join(project, ".SSH", "authorized_keys"), project, `${project}/.ssh/**`),
      true,
    );

    for (const action of [
      { source: "agent", toolName: "write", input: { path: ".GIT/config" } } as GuardrailAction,
      {
        source: "agent",
        toolName: "edit",
        input: { path: ".Git/hooks/pre-commit" },
      } as GuardrailAction,
      bash("echo x > .GIT/config"),
      bash(`echo x > ${join(project.toUpperCase(), ".git", "config")}`),
    ]) {
      assert.equal(await outcome(pathsPolicy, action), "block", JSON.stringify(action.input));
    }
  });

  test("protects the guardrail sources through case variants", { skip: !foldsCase }, async () => {
    const root = process.cwd();
    const variant = join(root, "extensions", "GUARDRAILS", "index.ts");
    assert.equal(await outcome(selfProtectionPolicy, bash(`echo x > ${variant}`), root), "block");
    assert.equal(
      await outcome(
        selfProtectionPolicy,
        { source: "agent", toolName: "edit", input: { path: "Extensions/Guardrails/index.ts" } },
        root,
      ),
      "block",
    );
  });
});
