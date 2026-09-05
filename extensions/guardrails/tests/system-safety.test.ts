import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_GUARDRAILS_CONFIG } from "../config.ts";
import { isRootHomeOrSystemPath, systemSafetyPolicy } from "../policies/system-safety.ts";
import type { GuardrailAction } from "../policy.ts";

const pi = {} as ExtensionAPI;
const home = homedir();
const user = basename(home);
let tempProject: string;

before(async () => {
  tempProject = await mkdtemp(join(tmpdir(), "pi-guardrail-temp-"));
});

after(async () => {
  await rm(tempProject, { recursive: true, force: true });
});

async function outcome(action: GuardrailAction, cwd = process.cwd()): Promise<string | undefined> {
  const decision = await systemSafetyPolicy.check(action, {
    pi,
    cwd,
    config: DEFAULT_GUARDRAILS_CONFIG,
    maintenance: false,
  });
  return decision?.outcome;
}

function bash(command: string): GuardrailAction {
  return { source: "agent", toolName: "bash", input: { command } };
}

describe("system safety deletion", () => {
  test("blocks globbed, tilde-user, and container deletions", async () => {
    for (const command of [
      "rm -rf /*",
      "rm -rf ~/*",
      "rm -rf ~/.*",
      `rm -rf ~${user}`,
      `rm -rf ~${user}/`,
      "rm -rf /Users",
      "rm -rf /Users/*",
      "rm -rf /home",
      "rm -rf /Library",
      "rm -rf /Applications",
      "rm -rf /opt",
      "rm -rf /System",
      "rm -rf /private",
      "rm -rf /etc",
      "rm -rf /var/*",
      "rm -rf /usr",
      "rm -rf /{usr,etc}",
      "rm -rf /us*",
      "rm -rf -- /",
    ]) {
      assert.equal(await outcome(bash(command)), "block", command);
    }
    assert.equal(await outcome(bash("rm -rf *"), home), "block");
    assert.equal(await outcome(bash("rm -rf .* *"), home), "block");
  });

  test("blocks find deletions rooted at home or system paths", async () => {
    for (const command of [
      "find / -exec rm -rf {} +",
      "find / -type f -exec rm {} \\;",
      "find ~ -execdir rm -rf {} +",
      "find -L /usr -name x -ok rm {} \\;",
      "find / -delete",
    ]) {
      assert.equal(await outcome(bash(command)), "block", command);
    }
  });

  test("allows deletion inside working, temp, and home subtrees", async () => {
    for (const command of [
      "rm -rf ./build/*",
      "rm -rf ./build",
      "rm -rf node_modules dist",
      "rm -rf /tmp/build-*",
      "rm -rf /private/tmp/build",
      "rm -rf /var/tmp/build",
      "rm -rf /private/var/tmp/build",
      "rm -rf /var/folders/ab/cd/T/build",
      `rm -rf ${join(tempProject, "build")}`,
      `rm -rf ${join(home, "Code/tmp-generated")}/*`,
      "rm -rf ~/{build,dist}",
      "rm -rf ~/Code/project-*",
      "find . -name '*.log' -exec rm {} +",
      `find ${join(home, "Code")} -name '*.log' -exec rm -rf {} +`,
    ]) {
      assert.equal(await outcome(bash(command), tempProject), undefined, command);
    }
  });

  test("protects temp roots but not their contents", async () => {
    for (const command of [
      "rm -rf /tmp",
      "rm -rf /private/tmp",
      "rm -rf /var/tmp",
      "rm -rf /private/var/tmp",
      "rm -rf /var/folders",
      "rm -rf /private/var/folders",
      "rm -rf /private/var",
      "rm -rf /private",
      "rm -rf /var",
      "rm -rf /tmp/*",
      `rm -rf ${tmpdir()}`,
    ]) {
      assert.equal(await outcome(bash(command), tempProject), "block", command);
    }
  });

  test("treats home containers and new roots as system paths", () => {
    const syntheticHome = "/Users/person";
    assert.equal(isRootHomeOrSystemPath("/Users", syntheticHome), true);
    assert.equal(isRootHomeOrSystemPath("/Users/other", syntheticHome), true);
    assert.equal(isRootHomeOrSystemPath("/home/other", syntheticHome), true);
    assert.equal(isRootHomeOrSystemPath("/Library/Caches", syntheticHome), true);
    assert.equal(isRootHomeOrSystemPath("/opt/homebrew", syntheticHome), true);
    assert.equal(isRootHomeOrSystemPath("/var/lib", syntheticHome), true);
    assert.equal(isRootHomeOrSystemPath(`${syntheticHome}/Library/Caches`, syntheticHome), false);
  });

  test("protects temp roots exactly and exempts their subtrees", () => {
    const syntheticHome = "/Users/person";
    for (const root of ["/tmp", "/private/tmp", "/var/tmp", "/var/folders", "/private/var"]) {
      assert.equal(isRootHomeOrSystemPath(root, syntheticHome), true, root);
    }
    for (const path of [
      "/tmp/build",
      "/private/tmp/proj/node_modules",
      "/var/tmp/x",
      "/private/var/tmp/x",
      "/var/folders/ab/cd/T/build",
      "/private/var/folders/ab/cd/T/build",
    ]) {
      assert.equal(isRootHomeOrSystemPath(path, syntheticHome), false, path);
    }
  });
});

describe("system safety tls", () => {
  test("blocks insecure flags inside curl option clusters", async () => {
    for (const command of [
      "curl -sk https://example.com",
      "curl -sSLk https://example.com",
      "curl -fsSLk https://example.com -o out.txt",
      "curl -k https://example.com",
      "curl --insecure https://example.com",
      "wget --no-check-certificate https://example.com",
    ]) {
      assert.equal(await outcome(bash(command)), "block", command);
    }
    for (const command of [
      "curl -sS -H 'Accept: k' https://example.com",
      "curl -sok https://example.com",
      "curl -K curlrc https://example.com",
      "curl -sSL https://example.com -o out.txt",
    ]) {
      assert.equal(await outcome(bash(command)), undefined, command);
    }
  });

  test("blocks every git spelling of a false sslVerify", async () => {
    for (const command of [
      "git config --global http.sslVerify no",
      "git config --global http.sslVerify 0",
      "git config --global http.sslVerify off",
      "git config --global http.sslVerify False",
      "git config http.sslverify false",
      "git -c http.sslVerify=no fetch",
      "GIT_SSL_NO_VERIFY=yes git fetch",
      "GIT_SSL_NO_VERIFY=on git fetch",
    ]) {
      assert.equal(await outcome(bash(command)), "block", command);
    }
    for (const command of [
      "git config --global http.sslVerify true",
      "git config --global user.name no",
      "git config --get http.sslVerify",
    ]) {
      assert.equal(await outcome(bash(command)), undefined, command);
    }
  });
});

describe("system safety persistence", () => {
  test("finds service verbs after global options", async () => {
    for (const command of [
      "systemctl --user enable evil",
      "systemctl --now --user enable evil",
      "systemctl --user start evil",
      "systemctl --user link ~/evil.service",
      "launchctl load -w ~/evil.plist",
    ]) {
      assert.equal(await outcome(bash(command)), "block", command);
    }
    for (const command of ["systemctl --user status evil", "systemctl --user disable evil"]) {
      assert.equal(await outcome(bash(command)), undefined, command);
    }
  });

  test("blocks fish configuration and launch agent writes", async () => {
    for (const command of [
      "echo x >> ~/.config/fish/config.fish",
      "echo x > ~/.config/fish/conf.d/evil.fish",
      "echo x > ~/Library/LaunchAgents/com.evil.plist",
      "cp evil.plist ~/Library/LaunchAgents/com.evil.plist",
      "cp evil.plist /Library/LaunchDaemons/com.evil.plist",
    ]) {
      assert.equal(await outcome(bash(command)), "block", command);
    }
    assert.equal(
      await outcome({
        source: "agent",
        toolName: "write",
        input: { path: "~/Library/LaunchAgents/com.evil.plist" },
      }),
      "block",
    );
    assert.equal(await outcome(bash("echo x >> ~/.config/fish/fish_variables")), undefined);
  });

  test("sees identity writes through >& and >| redirects", async () => {
    for (const command of [
      "echo key >& ~/.ssh/authorized_keys",
      "echo alias >| ~/.zshrc",
      "echo alias 1>| ~/.bashrc",
    ]) {
      assert.equal(await outcome(bash(command)), "block", command);
    }
    assert.equal(await outcome(bash("echo status >&2")), undefined);
  });
});
