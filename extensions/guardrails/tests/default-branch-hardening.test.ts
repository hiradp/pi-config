import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_GUARDRAILS_CONFIG, type GuardrailsConfig } from "../config.ts";
import { defaultBranchGuidance, defaultBranchPolicy } from "../policies/default-branch.ts";
import type { GuardrailDecision } from "../policy.ts";

const pi = {
  async exec(command: string, args: string[], options?: { cwd?: string }) {
    const result = spawnSync(command, args, { cwd: options?.cwd, encoding: "utf8", timeout: 3000 });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      code: result.status ?? 1,
      killed: result.signal !== null,
    };
  },
} as unknown as ExtensionAPI;

const killedPi = {
  async exec() {
    return { stdout: "", stderr: "", code: 0, killed: true };
  },
} as unknown as ExtensionAPI;

const previousEnv = {
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
};
let tempRoot: string;

function config(allowed: string[]): GuardrailsConfig {
  return {
    ...DEFAULT_GUARDRAILS_CONFIG,
    defaultBranch: { allowedRepositories: allowed },
  };
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function createRepository(
  remotes: Record<string, string> = { origin: "git@github.com:someone-else/fixture.git" },
  branch = "main",
): Promise<string> {
  const cwd = await mkdtemp(join(tempRoot, "repo-"));
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "Guardrails Test");
  git(cwd, "config", "user.email", "guardrails@example.com");
  await writeFile(join(cwd, "README.md"), "fixture\n");
  git(cwd, "add", "README.md");
  git(cwd, "commit", "-m", "fixture");
  for (const [name, url] of Object.entries(remotes)) git(cwd, "remote", "add", name, url);
  if (branch !== "main") git(cwd, "switch", "-c", branch);
  return cwd;
}

async function check(
  command: string,
  cwd: string,
  options: { allowed?: string[]; pi?: ExtensionAPI } = {},
): Promise<GuardrailDecision | undefined> {
  return defaultBranchPolicy.check(
    { source: "agent", toolName: "bash", input: { command } },
    { pi: options.pi ?? pi, cwd, config: config(options.allowed ?? []), maintenance: false },
  );
}

async function outcome(
  command: string,
  cwd: string,
  options: { allowed?: string[]; pi?: ExtensionAPI } = {},
): Promise<string> {
  return (await check(command, cwd, options))?.outcome ?? "allow";
}

before(async () => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  tempRoot = await mkdtemp(join(tmpdir(), "pi-guardrails-branch-"));
});

after(async () => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(tempRoot, { recursive: true, force: true });
});

describe("default branch guard hardening", { concurrency: false }, () => {
  test("evaluates later commands as if a literal branch switch already happened", async () => {
    const cwd = await createRepository(undefined, "feature");
    for (const command of [
      "git checkout main && git push",
      "git switch main && git commit --allow-empty -m x",
      "git checkout main; git merge feature",
      "git checkout main\ngit push origin HEAD",
      "(git switch main && git push origin HEAD)",
      "git checkout -b main-2 main && git switch main && git commit -m x",
    ]) {
      assert.match((await check(command, cwd))?.reason ?? "", /Blocked git/, command);
    }

    const onMain = await createRepository();
    for (const command of [
      "git checkout feature && git commit -m x",
      "git checkout -b topic && git commit -m x",
      "git switch -c topic && git push -u origin topic",
      "git checkout -b topic main && git commit -m x",
    ]) {
      assert.equal(await outcome(command, onMain), "allow", command);
    }
    for (const command of [
      "git checkout -- README.md && git commit -m x",
      "git checkout HEAD README.md && git commit -m x",
    ]) {
      assert.match((await check(command, onMain))?.reason ?? "", /Blocked git commit/, command);
    }
  });

  test("asks when the switched-to branch is not literal", async () => {
    const cwd = await createRepository(undefined, "feature");
    for (const command of [
      "git checkout $BRANCH && git commit -m x",
      'git switch "$(cat target)" && git push origin HEAD',
      "git switch - && git commit -m x",
      "git checkout - && git push",
    ]) {
      assert.equal(await outcome(command, cwd), "confirm", command);
    }
    assert.equal(await outcome("git checkout $BRANCH && git status", cwd), "allow");
  });

  test("matches the allowlist against the remote actually pushed to", async () => {
    const cwd = await createRepository({
      origin: "git@github.com:hiradp/fixture.git",
      upstream: "https://github.com/big-org/fixture.git",
    });
    const allowed = ["hiradp/*"];
    assert.equal(await outcome("git push origin main", cwd, { allowed }), "allow");
    assert.equal(await outcome("git commit -m x", cwd, { allowed }), "allow");
    for (const command of [
      "git push upstream main",
      "git push upstream HEAD:main",
      "git push https://github.com/big-org/fixture.git HEAD:main",
    ]) {
      assert.match(
        (await check(command, cwd, { allowed }))?.reason ?? "",
        /Blocked git push/,
        command,
      );
    }
    assert.equal(await outcome("git push $REMOTE main", cwd, { allowed }), "confirm");

    git(cwd, "update-ref", "refs/remotes/upstream/main", "HEAD");
    git(cwd, "branch", "--set-upstream-to=upstream/main", "main");
    assert.match(
      (await check("git commit -m x", cwd, { allowed }))?.reason ?? "",
      /Blocked git commit/,
    );
    assert.match((await check("git push", cwd, { allowed }))?.reason ?? "", /Blocked git push/);
    assert.equal(await outcome("git push origin main", cwd, { allowed }), "allow");
  });

  test("only treats github.com owners as allowlisted owners", async () => {
    for (const mirror of [
      "https://gitlab.example.com/hiradp/anything.git",
      "file:///hiradp/anything",
    ]) {
      const cwd = await createRepository({
        origin: "git@github.com:someone-else/fixture.git",
        mirror,
      });
      const allowed = ["hiradp/*"];
      for (const command of ["git push origin main", "git push mirror main", "git commit -m x"]) {
        assert.match(
          (await check(command, cwd, { allowed }))?.reason ?? "",
          /Blocked git/,
          command,
        );
      }
    }
    const fromElsewhere = await createRepository(undefined, "feature");
    assert.equal(
      await outcome("git push git@github.com:hiradp/fixture.git HEAD:main", fromElsewhere, {
        allowed: ["hiradp/*"],
      }),
      "allow",
    );
  });

  test("honours inline -c aliases", async () => {
    const cwd = await createRepository();
    for (const command of [
      "git -c alias.p=push p origin main",
      "git -c alias.c=commit c -m x",
      "git -c 'alias.c=commit -m x' c",
      "git -c alias.p=push -c core.pager=cat p origin main",
    ]) {
      assert.match((await check(command, cwd))?.reason ?? "", /Blocked git/, command);
    }
  });

  test("asks when the repository is redirected through git-dir or work-tree", async () => {
    const cwd = await createRepository({ origin: "git@github.com:hiradp/fixture.git" });
    const other = await createRepository();
    const allowed = ["hiradp/*"];
    for (const command of [
      `git --git-dir=${other}/.git --work-tree=${other} push origin main`,
      `git --git-dir ${other}/.git push origin main`,
      `GIT_DIR=${other}/.git git push origin main`,
      `GIT_WORK_TREE=${other} git commit -m x`,
      `env GIT_DIR=${other}/.git git commit -m x`,
    ]) {
      assert.equal(await outcome(command, cwd, { allowed }), "confirm", command);
    }
  });

  test("treats merge, pull, cherry-pick, rebase, and revert like commits", async () => {
    const cwd = await createRepository();
    for (const command of [
      "git merge feature",
      "git pull",
      "git pull --rebase origin main",
      "git cherry-pick abc123",
      "git rebase feature",
      "git revert HEAD",
    ]) {
      assert.match((await check(command, cwd))?.reason ?? "", /Blocked git/, command);
    }
    const feature = await createRepository(undefined, "feature");
    for (const command of ["git merge main", "git pull", "git rebase main", "git revert HEAD"]) {
      assert.equal(await outcome(command, feature), "allow", command);
    }
  });

  test("asks instead of failing open when git is killed by the timeout", async () => {
    const cwd = await createRepository();
    assert.equal(await outcome("git commit -m x", cwd, { pi: killedPi }), "confirm");
    assert.equal(await outcome("git push origin main", cwd, { pi: killedPi }), "confirm");
    // Even `status` needs git to rule out an alias, so a killed git cannot be classified.
    assert.equal(await outcome("git status", cwd, { pi: killedPi }), "confirm");
    assert.equal(await outcome("echo done", cwd, { pi: killedPi }), "allow");
    assert.equal(
      await defaultBranchPolicy.guidance?.({
        pi: killedPi,
        cwd,
        config: config(["hiradp/*"]),
        maintenance: false,
      }),
      defaultBranchGuidance,
    );
  });

  test("keeps ordinary git usage allowed", async () => {
    const cwd = await createRepository();
    for (const command of [
      "git status",
      "git log --oneline",
      "git checkout -b topic",
      "git fetch",
    ]) {
      assert.equal(await outcome(command, cwd), "allow", command);
    }
    const feature = await createRepository(undefined, "feature");
    for (const command of [
      "git commit -m x",
      "git push origin feature",
      "git push -u origin HEAD",
    ]) {
      assert.equal(await outcome(command, feature), "allow", command);
    }
  });
});
