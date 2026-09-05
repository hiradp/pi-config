import { realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expandHome, shellWords } from "../command-parser.ts";
import { block, confirm, type GuardrailDecision, type GuardrailPolicy } from "../policy.ts";

interface RepoState {
  branch: string | undefined;
  defaultBranches: Set<string>;
}

interface GitCommand {
  cwd: string;
  subcommand: string;
  args: string[];
  /** Aliases defined inline with `-c alias.<name>=<command>`. */
  aliases: Map<string, string>;
  /** An option or variable pointing git at a repository this policy cannot inspect. */
  redirect?: string;
}

/** A branch switch that an earlier part of the same command performs. */
interface BranchSwitch {
  /** The branch after the switch; `undefined` when HEAD becomes detached. */
  branch: string | undefined;
  literal: boolean;
}

type GitAction = { kind: "commit" | "push"; verb: string };

const FALLBACK_DEFAULT_BRANCHES = ["main", "master", "trunk"];
/** Subcommands that create commits on the current branch. */
const COMMIT_SUBCOMMANDS = new Set(["cherry-pick", "commit", "merge", "pull", "rebase", "revert"]);
const COMMAND_WRAPPERS = new Set(["command", "env", "exec", "nohup", "sudo"]);
const GIT_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
]);
const GIT_REDIRECT_OPTIONS = new Set(["--git-dir", "--work-tree"]);
const GIT_REDIRECT_VARIABLES = new Set(["GIT_DIR", "GIT_WORK_TREE"]);
const CHECKOUT_BRANCH_OPTIONS = new Set(["-b", "-B", "--orphan"]);
const SWITCH_BRANCH_OPTIONS = new Set(["-c", "-C", "--orphan"]);
const PUSH_OPTIONS_WITH_VALUE = new Set([
  "--exec",
  "--push-option",
  "--receive-pack",
  "--repo",
  "-o",
]);

export const defaultBranchGuidance =
  "Git guardrail: never commit, merge, pull, rebase, cherry-pick, revert, or push while on a repository's default branch. Create or switch to a feature branch first; pushes targeting a default branch are also prohibited.";

class GitUnavailableError extends Error {}

async function git(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  const result = await pi.exec("git", args, { cwd, signal, timeout: 3000 });
  if (result.killed) throw new GitUnavailableError(`git ${args[0]} did not finish in time`);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

function isLiteral(word: string): boolean {
  return word !== "-" && !/[$`*?[\]{}]/.test(word);
}

function isCommandPosition(words: string[], index: number): boolean {
  let start = index - 1;
  while (start >= 0 && words[start] !== ";") start--;
  const prefix = words.slice(start + 1, index);
  if (prefix.every((word) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word))) return true;
  return COMMAND_WRAPPERS.has(prefix[0]);
}

function environmentRedirect(words: string[], index: number): string | undefined {
  for (let cursor = index - 1; cursor >= 0 && words[cursor] !== ";"; cursor--) {
    const variable = words[cursor].split("=", 1)[0];
    if (words[cursor].includes("=") && GIT_REDIRECT_VARIABLES.has(variable)) return variable;
  }
}

/** Git invocations with the leading options this policy needs, in command order. */
export function parseGitCommands(command: string, baseCwd: string): GitCommand[] {
  const words = shellWords(command);
  const commands: GitCommand[] = [];

  for (let i = 0; i < words.length; i++) {
    if (basename(words[i]) !== "git" || !isCommandPosition(words, i)) continue;

    let cwd = baseCwd;
    let redirect = environmentRedirect(words, i);
    const aliases = new Map<string, string>();
    let cursor = i + 1;
    while (cursor < words.length && words[cursor] !== ";" && words[cursor].startsWith("-")) {
      const option = words[cursor];
      const next = words[cursor + 1] === ";" ? undefined : words[cursor + 1];

      if (option === "-C" && next !== undefined) {
        cwd = resolve(cwd, expandHome(next));
        cursor += 2;
        continue;
      }
      if (option === "-c" && next !== undefined) {
        const alias = next.match(/^alias\.([^=]+)=(.*)$/);
        if (alias) aliases.set(alias[1], alias[2]);
        cursor += 2;
        continue;
      }
      const name = option.split("=", 1)[0];
      if (GIT_REDIRECT_OPTIONS.has(name)) {
        redirect ??= name;
        cursor += option.includes("=") ? 1 : 2;
        continue;
      }
      cursor += GIT_OPTIONS_WITH_VALUE.has(option) ? 2 : 1;
    }

    if (cursor >= words.length || words[cursor] === ";") continue;
    const args: string[] = [];
    for (let end = cursor + 1; end < words.length && words[end] !== ";"; end++) {
      args.push(words[end]);
    }
    commands.push({ cwd, subcommand: words[cursor], args, aliases, redirect });
  }

  return commands;
}

function githubSlug(url: string): string | undefined {
  const value = url.trim();
  let host: string;
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      host = parsed.hostname;
      path = parsed.pathname;
    } catch {
      return;
    }
  } else {
    const scp = value.match(/^(?:[^@\s]+@)?([^:\s/]+):(.+)$/);
    if (!scp) return;
    [, host, path] = scp;
  }

  if (host.toLowerCase() !== "github.com") return;
  const slug = path
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
  return slug.includes("/") ? slug : undefined;
}

function configuredSlug(entry: string): string | undefined {
  const candidate = entry.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) || /^[^@\s]+@[^:\s/]+:/.test(candidate)) {
    return githubSlug(candidate);
  }
  const slug = candidate
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
  return slug.includes("/") ? slug : undefined;
}

function repositorySlugIsAllowed(configured: string, repositories: Set<string>): boolean {
  if (!configured.endsWith("/*")) return repositories.has(configured);

  const owner = configured.slice(0, -2);
  if (!owner || owner.includes("/")) return false;
  return [...repositories].some((repository) => {
    const [repositoryOwner, repositoryName, ...rest] = repository.split("/");
    return repositoryOwner === owner && Boolean(repositoryName) && rest.length === 0;
  });
}

function looksLikeRemoteUrl(remote: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(remote) ||
    /^[^@\s/]+@[^:\s/]+:/.test(remote) ||
    remote.includes("/") ||
    remote.startsWith(".")
  );
}

async function remoteSlugs(
  pi: ExtensionAPI,
  cwd: string,
  remote: string,
  push: boolean,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const urls = looksLikeRemoteUrl(remote)
    ? [remote]
    : ((
        await git(
          pi,
          cwd,
          ["remote", "get-url", "--all", ...(push ? ["--push"] : []), remote],
          signal,
        )
      )
        ?.split("\n")
        .filter(Boolean) ?? []);
  const slugs = new Set<string>();
  for (const url of urls) {
    const slug = githubSlug(url);
    if (slug) slugs.add(slug);
  }
  return slugs;
}

/**
 * Whether the repository at `cwd` is allowlisted for `remote`: either the worktree matches a
 * configured path, or the remote's github.com owner/repository matches a configured slug.
 */
export async function repositoryIsAllowed(
  pi: ExtensionAPI,
  cwd: string,
  allowedRepositories: string[],
  remote: string,
  options: { push?: boolean; signal?: AbortSignal } = {},
): Promise<boolean> {
  if (allowedRepositories.length === 0) return false;

  const root = await git(pi, cwd, ["rev-parse", "--show-toplevel"], options.signal);
  if (!root) return false;
  const normalizedRoot = await realpath(root);
  let slugs: Set<string> | undefined;

  for (const entry of allowedRepositories) {
    const expanded = expandHome(entry);
    if (isAbsolute(expanded)) {
      try {
        if ((await realpath(expanded)) === normalizedRoot) return true;
      } catch {
        // Ignore missing configured paths.
      }
      continue;
    }
    const slug = configuredSlug(entry);
    if (slug === undefined) continue;
    slugs ??= await remoteSlugs(pi, cwd, remote, options.push ?? false, options.signal);
    if (repositorySlugIsAllowed(slug, slugs)) return true;
  }
  return false;
}

async function currentBranch(
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return git(pi, cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal);
}

/** The remote a branch tracks, which is where its commits are expected to land. */
async function upstreamRemote(
  pi: ExtensionAPI,
  cwd: string,
  branch: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  if (!branch) return "origin";
  return (await git(pi, cwd, ["config", "--get", `branch.${branch}.remote`], signal)) || "origin";
}

/** The remote `git push` uses when no remote is given, following git's own precedence. */
async function configuredPushRemote(
  pi: ExtensionAPI,
  cwd: string,
  branch: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  if (branch) {
    const pushRemote = await git(
      pi,
      cwd,
      ["config", "--get", `branch.${branch}.pushRemote`],
      signal,
    );
    if (pushRemote) return pushRemote;
  }
  const pushDefault = await git(pi, cwd, ["config", "--get", "remote.pushDefault"], signal);
  if (pushDefault) return pushDefault;
  return upstreamRemote(pi, cwd, branch, signal);
}

function pushPositionals(args: string[]): string[] {
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (PUSH_OPTIONS_WITH_VALUE.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    positionals.push(arg);
  }
  return positionals;
}

async function resolveAction(
  pi: ExtensionAPI,
  command: GitCommand,
  signal?: AbortSignal,
): Promise<GitAction | undefined> {
  let action = command.subcommand;
  const seen = new Set<string>();

  for (let depth = 0; depth < 5; depth++) {
    if (COMMIT_SUBCOMMANDS.has(action)) return { kind: "commit", verb: action };
    if (action === "push") return { kind: "push", verb: "push" };
    if (seen.has(action)) return;
    seen.add(action);

    const alias =
      command.aliases.get(action) ??
      (await git(pi, command.cwd, ["config", "--get", `alias.${action}`], signal));
    if (!alias) return;
    if (alias.startsWith("!")) {
      for (const nested of parseGitCommands(alias.slice(1), command.cwd)) {
        const resolved = await resolveAction(pi, { ...nested, aliases: command.aliases }, signal);
        if (resolved) return resolved;
      }
      return;
    }
    action = shellWords(alias)[0] ?? "";
  }
}

/** The branch a `checkout` or `switch` leaves the repository on, if it switches at all. */
function branchSwitch(command: GitCommand): BranchSwitch | undefined {
  const { subcommand, args } = command;
  if (subcommand !== "checkout" && subcommand !== "switch") return;
  const creating = subcommand === "checkout" ? CHECKOUT_BRANCH_OPTIONS : SWITCH_BRANCH_OPTIONS;
  const positionals: string[] = [];
  let created: string | undefined;
  let detach = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      // `checkout [<tree-ish>] -- <paths>` restores files without switching.
      if (subcommand === "checkout") return;
      break;
    }
    if (arg === "-") {
      positionals.push(arg);
      continue;
    }
    if (creating.has(arg)) {
      created = args[++i];
      continue;
    }
    const inline = [...creating].find(
      (name) => name.startsWith("--") && arg.startsWith(`${name}=`),
    );
    if (inline) {
      created = arg.slice(inline.length + 1);
      continue;
    }
    if (arg === "--detach" || (subcommand === "switch" && arg === "-d")) {
      detach = true;
      continue;
    }
    if (arg.startsWith("-")) continue;
    positionals.push(arg);
  }

  if (created !== undefined) return { branch: created, literal: isLiteral(created) };
  // Extra positionals make `checkout` a file restore rather than a branch switch.
  if (subcommand === "checkout" && positionals.length !== 1) return;
  if (positionals.length === 0) return detach ? { branch: undefined, literal: true } : undefined;
  const target = positionals[0];
  if (!isLiteral(target)) return { branch: undefined, literal: false };
  return { branch: detach ? undefined : target, literal: true };
}

async function repoState(
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
): Promise<RepoState | undefined> {
  const branch = await currentBranch(pi, cwd, signal);
  if (!branch && !(await git(pi, cwd, ["rev-parse", "--git-dir"], signal))) return;

  const defaultBranches = new Set<string>();
  const remotes = (await git(pi, cwd, ["remote"], signal))?.split(/\s+/).filter(Boolean) ?? [];
  for (const remote of remotes) {
    const remoteHead = await git(
      pi,
      cwd,
      ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`],
      signal,
    );
    if (remoteHead?.startsWith(`${remote}/`))
      defaultBranches.add(remoteHead.slice(remote.length + 1));
  }

  const configuredDefault = await git(pi, cwd, ["config", "--get", "init.defaultBranch"], signal);
  if (configuredDefault) defaultBranches.add(configuredDefault);
  for (const fallback of FALLBACK_DEFAULT_BRANCHES) defaultBranches.add(fallback);

  return { branch, defaultBranches };
}

function targetsDefaultBranch(args: string[], defaults: Set<string>): boolean {
  if (args.some((arg) => arg === "--all" || arg === "--mirror")) return true;

  // The first positional is the remote/repository; remaining values are refspecs.
  for (const refspec of pushPositionals(args).slice(1)) {
    for (const branch of defaults) {
      if (
        refspec === branch ||
        refspec === `refs/heads/${branch}` ||
        refspec.endsWith(`:${branch}`) ||
        refspec.endsWith(`:refs/heads/${branch}`)
      ) {
        return true;
      }
    }
  }
  return false;
}

async function defaultBranchDecision(
  pi: ExtensionAPI,
  command: string,
  cwd: string,
  allowedRepositories: string[],
  signal?: AbortSignal,
): Promise<GuardrailDecision | undefined> {
  const switches = new Map<string, BranchSwitch>();

  for (const invocation of parseGitCommands(command, cwd)) {
    if (invocation.redirect) {
      return confirm(
        `Cannot classify 'git ${invocation.subcommand}' because ${invocation.redirect} points git at a repository the default-branch guard cannot inspect.`,
      );
    }
    const switched = branchSwitch(invocation);
    if (switched) {
      switches.set(invocation.cwd, switched);
      continue;
    }

    const action = await resolveAction(pi, invocation, signal);
    if (!action) continue;
    const state = await repoState(pi, invocation.cwd, signal);
    if (!state) continue;
    const earlierSwitch = switches.get(invocation.cwd);
    if (earlierSwitch && !earlierSwitch.literal) {
      return confirm(
        `Cannot classify 'git ${action.verb}' because an earlier branch switch in the same command is not literal.`,
      );
    }
    const branch = earlierSwitch ? earlierSwitch.branch : state.branch;
    const onDefaultBranch = branch !== undefined && state.defaultBranches.has(branch);

    if (action.kind === "commit") {
      if (!onDefaultBranch) continue;
      const remote = await upstreamRemote(pi, invocation.cwd, branch, signal);
      if (await repositoryIsAllowed(pi, invocation.cwd, allowedRepositories, remote, { signal })) {
        continue;
      }
      return block(
        `Blocked git ${action.verb} on default branch '${branch}'. Switch to a feature branch first.`,
      );
    }

    const pushRef =
      earlierSwitch && branch === undefined
        ? undefined
        : await git(
            pi,
            invocation.cwd,
            ["rev-parse", "--symbolic-full-name", earlierSwitch ? `${branch}@{push}` : "@{push}"],
            signal,
          );
    const pushesDefault =
      targetsDefaultBranch(invocation.args, state.defaultBranches) ||
      (pushRef !== undefined &&
        [...state.defaultBranches].some((candidate) => pushRef.endsWith(`/${candidate}`)));
    if (!onDefaultBranch && !pushesDefault) continue;

    const explicitRemote = pushPositionals(invocation.args)[0];
    if (explicitRemote !== undefined && !isLiteral(explicitRemote)) {
      return confirm("Cannot classify the git push because its remote is not literal.");
    }
    const remote =
      explicitRemote ?? (await configuredPushRemote(pi, invocation.cwd, branch, signal));
    if (
      await repositoryIsAllowed(pi, invocation.cwd, allowedRepositories, remote, {
        push: true,
        signal,
      })
    ) {
      continue;
    }
    const location = branch ? `while on '${branch}'` : "while HEAD is detached";
    return block(
      `Blocked git push involving a default branch ${location}. Push a feature branch instead.`,
    );
  }
}

export const defaultBranchPolicy = {
  name: "default-branch",
  async guidance({ pi, cwd, config, signal }) {
    try {
      const remote = await upstreamRemote(pi, cwd, await currentBranch(pi, cwd, signal), signal);
      if (
        await repositoryIsAllowed(pi, cwd, config.defaultBranch.allowedRepositories, remote, {
          signal,
        })
      ) {
        return;
      }
    } catch (error) {
      if (!(error instanceof GitUnavailableError)) throw error;
    }
    return defaultBranchGuidance;
  },
  async check(action, { pi, cwd, config, signal }) {
    if (action.toolName !== "bash" || typeof action.input.command !== "string") return;
    try {
      return await defaultBranchDecision(
        pi,
        action.input.command,
        cwd,
        config.defaultBranch.allowedRepositories,
        signal,
      );
    } catch (error) {
      if (error instanceof GitUnavailableError) {
        return confirm(`Cannot classify the git command because ${error.message}.`);
      }
      throw error;
    }
  },
} satisfies GuardrailPolicy;
