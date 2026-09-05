import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_GUARDRAILS_CONFIG } from "../config.ts";
import { selfProtectionPolicy } from "../policies/self-protection.ts";
import type { GuardrailAction } from "../policy.ts";

const pi = {} as ExtensionAPI;
const root = process.cwd();
let tempRoot: string;
let agentDir: string;
let otherRepo: string;
let previousAgentDir: string | undefined;

function bash(command: string): GuardrailAction {
  return { source: "agent", toolName: "bash", input: { command } };
}

async function outcome(command: string, cwd = root): Promise<string> {
  const decision = await selfProtectionPolicy.check(bash(command), {
    pi,
    cwd,
    config: DEFAULT_GUARDRAILS_CONFIG,
    maintenance: false,
  });
  return decision?.outcome ?? "allow";
}

before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "pi-guardrail-self-"));
  agentDir = join(tempRoot, "pi", "agent");
  otherRepo = join(tempRoot, "other-repo");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(otherRepo, ".git"), { recursive: true });
  await writeFile(join(agentDir, "settings.json"), "{}\n");
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(tempRoot, { recursive: true, force: true });
});

describe("self protection coverage", () => {
  test("blocks writes routed through dd and interpreter code strings", async () => {
    const settings = () => join(agentDir, "settings.json");
    for (const command of [
      `dd if=/tmp/x of=${settings()}`,
      `dd if=/tmp/x of=${agentDir}/settings.json bs=1`,
      `node -e "require('fs').writeFileSync('${settings()}', '{}')"`,
      `node --eval "require('fs').writeFileSync('${settings()}', '{}')"`,
      `node -p "require('fs').writeFileSync('${settings()}', '{}')"`,
      `python3 -c "open('${settings()}','w').write('{}')"`,
      "python -c \"open('extensions/guardrails/index.ts','w').write('')\"",
      `perl -e 'open(my $f, ">", "${settings()}")'`,
      `ruby -e 'File.write("${settings()}", "{}")'`,
      `bash -c "echo x > ${settings()}"`,
      "sh -c 'cd extensions/guardrails && echo x > index.ts'",
      `zsh -c 'rm -rf ${agentDir}'`,
    ]) {
      assert.equal(await outcome(command), "block", command);
    }
  });

  test("blocks git commands that rewrite a worktree holding guardrail sources", async () => {
    for (const command of [
      "git apply /tmp/evil.patch",
      "git checkout HEAD~3 -- extensions/guardrails/index.ts",
      "git checkout main",
      "git checkout -- .",
      "git switch main",
      "git restore extensions/guardrails/index.ts",
      "git stash",
      "git stash pop",
      "git reset --hard",
      "git reset --hard HEAD~1",
      "git pull",
      "git pull --rebase origin main",
      "git merge feature",
      "git rebase main",
      "git cherry-pick abc123",
      "git revert HEAD",
      "git clean -fd",
      "git am /tmp/evil.mbox",
      "cd extensions && git stash",
    ]) {
      assert.equal(await outcome(command), "block", command);
    }
    assert.equal(await outcome(`git -C ${root} stash`, tempRoot), "block");
    assert.equal(await outcome(`git --work-tree=${root} checkout -- .`, tempRoot), "block");
  });

  test("blocks patching, extraction, and syncing into protected trees", async () => {
    for (const command of [
      "patch -p1 < /tmp/evil.patch",
      "patch -p1 -i /tmp/evil.patch",
      "patch -d extensions/guardrails -p1 -i /tmp/evil.patch",
      "tar xf /tmp/evil.tar",
      `tar -xzf /tmp/evil.tgz -C ${agentDir}`,
      `tar --extract --file=/tmp/evil.tar --directory=${root}`,
      `rsync -a /tmp/src/ ${agentDir}/`,
      "rsync -av --delete /tmp/src/ extensions/guardrails/",
      `rsync -a /tmp/settings.json ${agentDir}/settings.json`,
    ]) {
      assert.equal(await outcome(command), "block", command);
    }
  });

  test("blocks deleting or moving ancestors of protected locations", async () => {
    for (const command of [
      `rm -rf ${agentDir}`,
      `rm -rf ${dirname(agentDir)}`,
      `rm -rf ${root}`,
      `rm -r ${root}/extensions`,
      "rm -rf extensions",
      "rm -rf extensions/guardrails",
      `mv ${root} /tmp/x`,
      `mv ${agentDir} ${tempRoot}/moved`,
      "mv extensions /tmp/x",
      `sudo rm -rf ${dirname(agentDir)}`,
    ]) {
      assert.equal(await outcome(command), "block", command);
    }
  });

  test("leaves unrelated commands alone", async () => {
    for (const command of [
      "git status",
      "git log --oneline -3",
      "git diff",
      "git commit -m x",
      "git checkout -b feature",
      "git switch -c feature",
      "git stash list",
      "git stash show",
      "git reset --soft HEAD~1",
      "git push origin feature",
      "node -e \"console.log('hello')\"",
      "python3 -c \"print('hello')\"",
      "dd if=/dev/zero of=/tmp/out bs=1 count=1",
      "tar xf /tmp/x.tar -C /tmp/elsewhere",
      "tar czf /tmp/out.tgz extensions/guardrails",
      "patch -d /tmp/other -p1 -i /tmp/x.patch",
      "rsync -a /tmp/a/ /tmp/b/",
      "rm -rf /tmp/unrelated",
      "rm -rf extensions/other",
      "rm -rf skills",
      "mv /tmp/a /tmp/b",
      "mv /tmp/x extensions/other/",
      "echo x > notes.txt",
    ]) {
      assert.equal(await outcome(command), "allow", command);
    }
    for (const command of [
      "git stash",
      "git pull",
      "git reset --hard",
      "git apply /tmp/x.patch",
      "patch -p1 -i /tmp/x.patch",
      "tar xf /tmp/x.tar",
      "rm -rf build",
    ]) {
      assert.equal(await outcome(command, otherRepo), "allow", command);
    }
  });
});
