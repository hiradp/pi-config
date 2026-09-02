import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_GUARDRAILS_CONFIG,
  parseGuardrailsSettings,
  type GuardrailsConfig,
} from "../config.ts";
import { matchesPathPattern, resolvePathForPolicy, shellMutationTargets } from "../path-policy.ts";
import { pathsPolicy } from "../policies/paths.ts";
import { selfProtectionPolicy } from "../policies/self-protection.ts";
import {
  isAutoAllowedGhPrViewCommand,
  isAutoAllowedGhReadCommand,
  matchesReviewCommand,
  semanticReviewPolicy,
} from "../policies/semantic-review.ts";
import { isRootHomeOrSystemPath, systemSafetyPolicy } from "../policies/system-safety.ts";
import type { GuardrailAction, GuardrailPolicy } from "../policy.ts";

const pi = {} as ExtensionAPI;
const cwd = process.cwd();
let tempRoot: string;

function config(overrides: Partial<GuardrailsConfig> = {}): GuardrailsConfig {
  return {
    commands: overrides.commands ?? {
      blockedCommands: [...DEFAULT_GUARDRAILS_CONFIG.commands.blockedCommands],
    },
    defaultBranch: overrides.defaultBranch ?? {
      allowedRepositories: [...DEFAULT_GUARDRAILS_CONFIG.defaultBranch.allowedRepositories],
    },
    kubectl: overrides.kubectl ?? {
      allowedCommands: [...DEFAULT_GUARDRAILS_CONFIG.kubectl.allowedCommands],
      invocations: DEFAULT_GUARDRAILS_CONFIG.kubectl.invocations.map((entry) => ({ ...entry })),
    },
    paths: overrides.paths ?? { blocked: [], confirm: [] },
    semanticReview: overrides.semanticReview ?? {
      ...DEFAULT_GUARDRAILS_CONFIG.semanticReview,
      commands: [],
      paths: [],
    },
  };
}

async function check(
  policy: GuardrailPolicy,
  action: GuardrailAction,
  options: { cwd?: string; config?: GuardrailsConfig; maintenance?: boolean } = {},
) {
  return policy.check(action, {
    pi,
    cwd: options.cwd ?? cwd,
    config: options.config ?? config(),
    maintenance: options.maintenance ?? false,
  });
}

function bash(command: string): GuardrailAction {
  return { source: "agent", toolName: "bash", input: { command } };
}

before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "pi-guardrail-safety-"));
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("guardrails configuration", () => {
  test("loads path rules while preserving existing policy sections", () => {
    const result = parseGuardrailsSettings({
      guardrails: {
        commands: { blocked: ["wrangler"] },
        defaultBranch: { allowed: ["hiradp/*"] },
        paths: { blocked: [".env"], confirm: ["config/**"] },
      },
    });

    assert.equal(result.valid, true);
    assert.deepEqual(result.config.commands.blockedCommands, ["wrangler"]);
    assert.deepEqual(result.config.defaultBranch.allowedRepositories, ["hiradp/*"]);
    assert.deepEqual(result.config.paths, {
      blocked: [".env"],
      confirm: ["config/**"],
    });
  });

  test("marks malformed safety settings invalid", () => {
    const result = parseGuardrailsSettings({
      guardrails: { commands: { blocked: "wrangler" }, paths: { blocked: [42] } },
    });

    assert.equal(result.valid, false);
    assert.equal(
      result.diagnostics.some((line) => line.includes("commands.blocked")),
      true,
    );
    assert.equal(
      result.diagnostics.some((line) => line.includes("paths.blocked[0]")),
      true,
    );
  });

  test("loads and validates semantic review settings", () => {
    const result = parseGuardrailsSettings({
      guardrails: {
        semanticReview: {
          enabled: true,
          mode: "shadow",
          model: "openai-codex/gpt-5.6-sol",
          timeoutMs: 10_000,
          commands: ["gh", "git push"],
          paths: [".github/workflows/**"],
        },
      },
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.config.semanticReview, {
      enabled: true,
      mode: "shadow",
      model: "openai-codex/gpt-5.6-sol",
      timeoutMs: 10_000,
      commands: ["gh", "git push"],
      paths: [".github/workflows/**"],
    });

    const invalid = parseGuardrailsSettings({
      guardrails: { semanticReview: { enabled: "yes", mode: "maybe", timeoutMs: 5 } },
    });
    assert.equal(invalid.valid, false);
    assert.equal(invalid.diagnostics.length, 3);
  });

  test("reports unknown keys without disabling valid policies", () => {
    const result = parseGuardrailsSettings({ guardrails: { futurePolicy: true } });
    assert.equal(result.valid, true);
    assert.match(result.diagnostics[0] ?? "", /Unknown guardrails\.futurePolicy/);
  });
});

describe("path policy helpers", () => {
  test("matches relative glob patterns only inside the working tree", () => {
    assert.equal(matchesPathPattern(join(cwd, ".env.local"), cwd, ".env.*"), true);
    assert.equal(matchesPathPattern(join(cwd, "config/pi/settings.json"), cwd, "config/**"), true);
    assert.equal(matchesPathPattern("/tmp/.env.local", cwd, ".env.*"), false);
  });

  test("resolves writes through symlinked ancestors", async () => {
    const outside = join(tempRoot, "outside");
    const project = join(tempRoot, "project");
    await mkdir(outside, { recursive: true });
    await mkdir(project, { recursive: true });
    await symlink(outside, join(project, "linked"));
    const target = join(project, "linked", "future.txt");
    assert.equal(resolvePathForPolicy(target), join(realpathSync(outside), "future.txt"));
    assert.equal(matchesPathPattern(target, project, `${join(project, "linked")}/**`), true);
  });

  test("extracts redirects and wrapped mutating commands from shell chains", () => {
    const targets = shellMutationTargets("echo ok > .env && sudo -u root rm ./generated.txt", cwd);
    assert.equal(targets.includes(join(cwd, ".env")), true);
    assert.equal(targets.includes(join(cwd, "generated.txt")), true);
  });

  test("returns block and confirm decisions for configured paths", async () => {
    const configured = config({
      paths: { blocked: [".env", ".git", ".git/**"], confirm: ["config/**"] },
    });
    assert.equal(
      (
        await check(
          pathsPolicy,
          { source: "agent", toolName: "write", input: { path: ".env" } },
          { config: configured },
        )
      )?.outcome,
      "block",
    );
    assert.equal(
      (
        await check(
          pathsPolicy,
          { source: "agent", toolName: "edit", input: { path: "config/app.json" } },
          { config: configured },
        )
      )?.outcome,
      "confirm",
    );
    assert.equal(
      (await check(pathsPolicy, bash("rm -rf .git"), { config: configured }))?.outcome,
      "block",
    );
  });
});

describe("semantic review selection", () => {
  const semanticConfig = config({
    semanticReview: {
      enabled: true,
      mode: "shadow",
      timeoutMs: 15_000,
      commands: ["gh", "git push", "terraform apply"],
      paths: [".github/workflows/**"],
    },
  });

  test("matches wrapped command prefixes without matching ordinary arguments", () => {
    assert.equal(matchesReviewCommand("sudo -u root git push origin main", "git push"), true);
    assert.equal(matchesReviewCommand("echo git push", "git push"), false);
    assert.equal(matchesReviewCommand("git status", "git push"), false);
  });

  test("auto-allows only standalone gh pr view commands", async () => {
    for (const command of [
      "gh pr view 42",
      "gh pr view https://github.com/example/repo/pull/42 --json title,body --comments",
      "gh pr view 42 --json files --jq '.files[] | .path'",
      "gh pr view 42 --template '{{.title}}'",
      "gh pr view '$GH_VIEW_ARGS'",
      "gh pr view --help",
    ]) {
      assert.equal(isAutoAllowedGhPrViewCommand(command), true);
      assert.equal(
        await check(semanticReviewPolicy, bash(command), { config: semanticConfig }),
        undefined,
      );
    }

    for (const command of [
      "gh pr view 42 --web",
      "gh pr view 42 -w",
      "gh pr view 42 && gh pr edit 42 --title changed",
      "gh pr view 42 > report.txt",
      'gh pr view "$(gh pr edit 42 --title changed)"',
      'gh pr view 42 "x\'$(gh pr edit 42 --title changed)"',
      'gh pr view 42 "x\'`gh pr edit 42 --title changed`"',
      'gh pr view 42 "$GH_VIEW_ARGS"',
      "gh pr view 42 --${WEB_SUFFIX}",
      "gh pr view 42 --{web,json}",
      "gh pr view 42 --w*",
      "gh pr view ~",
      "gh pr view ~other/repo",
      "env gh pr view 42",
    ]) {
      assert.equal(isAutoAllowedGhPrViewCommand(command), false);
      assert.equal(
        (await check(semanticReviewPolicy, bash(command), { config: semanticConfig }))?.outcome,
        "review",
      );
    }
  });

  test("auto-allows standalone read-only gh commands", async () => {
    for (const command of [
      "gh pr checks 2377",
      "gh pr diff 2377",
      "gh pr list --state open",
      "gh pr status",
      "gh pr view 2377 --comments",
      "gh search code 'fetchTargetStorage repo:planetscale/wal-g' --limit 50 --json path,url,textMatches",
      "gh api repos/example/repo/pulls/2377/comments",
      "gh api --paginate repos/example/repo/pulls/2377/reviews",
      "gh api --method GET repos/example/repo/pulls/2377/comments",
      "gh api -XGET repos/example/repo/pulls/2377/comments",
      "gh api 'repos/{owner}/{repo}/pulls/2377/comments' --jq '.[].body'",
    ]) {
      assert.equal(isAutoAllowedGhReadCommand(command), true);
      assert.equal(
        await check(semanticReviewPolicy, bash(command), { config: semanticConfig }),
        undefined,
      );
    }

    for (const command of [
      "gh pr checkout 2377",
      "gh pr close 2377",
      "gh pr diff 2377 --web",
      "gh pr edit 2377 --title changed",
      "gh pr merge 2377",
      "gh pr review 2377 --approve",
      "gh search code fetchTargetStorage --web",
      "gh search code fetchTargetStorage -w",
      "gh search issues fetchTargetStorage",
      "gh search code fetchTargetStorage > report.json",
      "gh search code fetchTargetStorage | jq .",
      'gh search code "$QUERY"',
      "env gh search code fetchTargetStorage",
      "gh api repos/example/repo/issues/2377/comments -f body=changed",
      "gh api --method GET repos/example/repo/pulls/2377/comments -f page=1",
      "gh api --method DELETE repos/example/repo/pulls/2377/comments/1",
      "gh api repos/example/repo/pulls/2377/comments --input body.json",
      "gh api repos/example/repo/pulls/2377/comments -H 'X-HTTP-Method-Override: DELETE'",
      "gh api graphql -f query=query",
      "gh api repos/example/repo/pulls/2377/comments > report.json",
      "gh api repos/example/repo/pulls/2377/comments | jq .",
    ]) {
      assert.equal(isAutoAllowedGhReadCommand(command), false);
      assert.equal(
        (await check(semanticReviewPolicy, bash(command), { config: semanticConfig }))?.outcome,
        "review",
      );
    }
  });

  test("requests review only for configured agent actions", async () => {
    assert.equal(
      (await check(semanticReviewPolicy, bash("gh pr merge 42"), { config: semanticConfig }))
        ?.outcome,
      "review",
    );
    assert.equal(
      (
        await check(
          semanticReviewPolicy,
          {
            source: "agent",
            toolName: "edit",
            input: { path: ".github/workflows/ci.yml" },
          },
          { config: semanticConfig },
        )
      )?.outcome,
      "review",
    );
    assert.equal(
      await check(
        semanticReviewPolicy,
        { source: "user", toolName: "bash", input: { command: "gh pr merge 42" } },
        { config: semanticConfig },
      ),
      undefined,
    );
  });
});

describe("self protection", () => {
  test("blocks direct and shell-based guardrail source modifications", async () => {
    const source = resolve(cwd, "extensions/guardrails/policies/self-protection.ts");
    assert.equal(
      (
        await check(selfProtectionPolicy, {
          source: "agent",
          toolName: "edit",
          input: { path: source },
        })
      )?.outcome,
      "block",
    );
    assert.equal(
      (await check(selfProtectionPolicy, bash(`echo nope >> ${source}`)))?.outcome,
      "block",
    );
  });

  test("maintenance mode unlocks only the self-protection policy", async () => {
    const source = resolve(cwd, "extensions/guardrails/index.ts");
    assert.equal(
      await check(
        selfProtectionPolicy,
        { source: "agent", toolName: "edit", input: { path: source } },
        { maintenance: true },
      ),
      undefined,
    );
  });
});

describe("system safety", () => {
  test("blocks profile and authorized_keys writes through tools and redirects", async () => {
    assert.equal(
      (
        await check(systemSafetyPolicy, {
          source: "agent",
          toolName: "write",
          input: { path: join(homedir(), ".zshrc") },
        })
      )?.outcome,
      "block",
    );
    assert.equal(
      (await check(systemSafetyPolicy, bash('echo key >> "$HOME/.ssh/authorized_keys"')))?.outcome,
      "block",
    );
  });

  test("blocks security weakening, persistence, and wrapped system deletion", async () => {
    for (const command of [
      "git config --global http.sslVerify false",
      "curl --insecure https://example.com",
      "launchctl bootstrap gui/501 agent.plist",
      "sudo rm -rf /",
      "rm -R ~",
      "rm -Rf ~",
      "rm -fR ~",
    ]) {
      assert.equal((await check(systemSafetyPolicy, bash(command)))?.outcome, "block", command);
    }
  });

  test("applies safety rules to heredoc bodies only when a shell runs them", async () => {
    assert.equal(
      await check(
        systemSafetyPolicy,
        bash("cat <<'EOF'\nrm -rf /\necho key >> ~/.ssh/authorized_keys\nEOF"),
      ),
      undefined,
    );
    assert.equal(
      (await check(systemSafetyPolicy, bash("cat <<'EOF'\nrm -rf /\nEOF\nrm -rf /")))?.outcome,
      "block",
    );
    assert.equal(
      (await check(systemSafetyPolicy, bash("bash <<'EOF'\nrm -rf /\nEOF")))?.outcome,
      "block",
    );
    assert.equal(
      (
        await check(
          systemSafetyPolicy,
          bash("cat <<'EOF' | sh\necho key >> ~/.ssh/authorized_keys\nEOF"),
        )
      )?.outcome,
      "block",
    );
  });

  test("allows recursive deletion inside the home subtree", async () => {
    assert.equal(
      await check(systemSafetyPolicy, bash(`rm -rf ${join(homedir(), "Code/tmp-generated")}`)),
      undefined,
    );
  });

  test("distinguishes a home subtree from home and system roots", () => {
    const syntheticHome = "/var/home/person";
    assert.equal(isRootHomeOrSystemPath(syntheticHome, syntheticHome), true);
    assert.equal(isRootHomeOrSystemPath(`${syntheticHome}/tmp`, syntheticHome), false);
    assert.equal(isRootHomeOrSystemPath("/var/lib", syntheticHome), true);
  });
});
