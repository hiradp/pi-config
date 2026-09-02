import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { parseShellCommand, shellSegmentInvocation, type ShellSegment } from "../command-parser.ts";
import {
  actionMutationTargets,
  isInside,
  resolveInputPath,
  resolvePathForPolicy,
} from "../path-policy.ts";
import { block, confirm, type GuardrailDecision, type GuardrailPolicy } from "../policy.ts";

const home = homedir();

function canonical(path: string): string {
  return resolvePathForPolicy(path) ?? resolve(path);
}

const canonicalAuthorizedKeysPath = canonical(resolve(home, ".ssh/authorized_keys"));
const profilePaths = new Set(
  [
    ".bashrc",
    ".bash_profile",
    ".bash_login",
    ".bash_logout",
    ".profile",
    ".zshrc",
    ".zprofile",
    ".zshenv",
    ".zlogin",
    ".zlogout",
    ".config/fish/config.fish",
  ].map((path) => canonical(resolve(home, path))),
);
for (const path of ["/etc/profile", "/etc/environment", "/etc/bash.bashrc"]) {
  profilePaths.add(canonical(path));
}
const profileDirectories = [canonical(resolve(home, ".config/fish/conf.d"))];
const launchAgentDirectories = [
  resolve(home, "Library/LaunchAgents"),
  "/Library/LaunchAgents",
  "/Library/LaunchDaemons",
].map(canonical);

function protectedIdentityPath(path: string): string | undefined {
  const resolved = canonical(path);
  if (resolved === canonicalAuthorizedKeysPath) {
    return "SSH authorized_keys modification is hard-denied";
  }
  if (
    profilePaths.has(resolved) ||
    profileDirectories.some((directory) => isInside(resolved, directory))
  ) {
    return "shell profile modification is hard-denied";
  }
  if (launchAgentDirectories.some((directory) => isInside(resolved, directory))) {
    return "persistence mutation is hard-denied";
  }
}

const SYSTEM_ROOTS = [
  "/Applications",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/home",
  "/lib",
  "/lib64",
  "/Library",
  "/opt",
  "/private",
  "/sbin",
  "/sys",
  "/System",
  "/Users",
  "/usr",
  "/var",
];

export function isRootHomeOrSystemPath(path: string, userHome = home): boolean {
  if (path.startsWith(`${userHome}/`)) return false;
  return (
    path === "/" ||
    path === userHome ||
    SYSTEM_ROOTS.some((root) => path === root || path.startsWith(`${root}/`))
  );
}

function recursiveRmArgument(argument: string): boolean {
  return argument === "--recursive" || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(argument);
}

const GLOB_SEGMENT = /[*?[]|\{[^}]*(?:,|\.\.)[^}]*\}/;

/** Resolve a deletion argument, expanding `~user` and cutting at the first glob segment. */
function deletionTarget(cwd: string, argument: string): string | undefined {
  let value = argument;
  const tildeUser = value.match(/^~([^/]+)(\/.*)?$/);
  if (tildeUser) {
    const [, user, rest = ""] = tildeUser;
    value = (user === basename(home) ? home : resolve(dirname(home), user)) + rest;
  }
  const path = resolveInputPath(cwd, value);
  if (!path) return;
  const segments = path.split("/");
  const glob = segments.findIndex((segment) => GLOB_SEGMENT.test(segment));
  if (glob === -1) return path;
  return segments.slice(0, glob).join("/") || "/";
}

const FIND_LEADING_FLAGS = /^-[HLPEXdsx]+$/;
const FIND_EXEC_PRIMARIES = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const DELETING_COMMANDS = new Set(["rm", "rmdir", "shred", "unlink"]);

function findStartingPoints(args: string[]): string[] {
  const points: string[] = [];
  let index = 0;
  for (; index < args.length; index++) {
    const argument = args[index];
    if (argument === "-f" && args[index + 1]) points.push(args[++index]);
    else if (!FIND_LEADING_FLAGS.test(argument)) break;
  }
  for (; index < args.length; index++) {
    const argument = args[index];
    if (argument.startsWith("-") || argument === "(" || argument === "!") break;
    points.push(argument);
  }
  return points;
}

function findDeletes(args: string[]): boolean {
  return args.some(
    (argument, index) =>
      argument === "-delete" ||
      (FIND_EXEC_PRIMARIES.has(argument) && DELETING_COMMANDS.has(basename(args[index + 1] ?? ""))),
  );
}

const CURL_VALUE_FLAGS = new Set("AbcCdDeEFHKmoPQrtTuUwxXyYz");

/** `-k` anywhere in a curl flag cluster, unless an earlier flag consumed the rest as its value. */
function curlInsecure(argument: string): boolean {
  if (argument === "--insecure") return true;
  if (!argument.startsWith("-") || argument.startsWith("--")) return false;
  for (const flag of argument.slice(1)) {
    if (flag === "k") return true;
    if (CURL_VALUE_FLAGS.has(flag)) return false;
  }
  return false;
}

const GIT_FALSE_VALUES = new Set(["false", "no", "off", "0"]);
const SERVICE_OPTIONS_WITH_VALUE = new Set([
  "-H",
  "-M",
  "-n",
  "-o",
  "-p",
  "-s",
  "-t",
  "--host",
  "--job-mode",
  "--lines",
  "--machine",
  "--output",
  "--property",
  "--root",
  "--signal",
  "--state",
  "--type",
]);

/** First positional argument of a service manager, skipping global options. */
function serviceVerb(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (!argument.startsWith("-")) return argument.toLowerCase();
    if (SERVICE_OPTIONS_WITH_VALUE.has(argument)) index++;
  }
}

function systemOrSshPath(path: string): boolean {
  const resolved = canonical(path);
  return ["/etc", "/usr", "/bin", "/sbin", "/System", resolve(home, ".ssh")].some(
    (root) => resolved === root || resolved.startsWith(`${root}/`),
  );
}

function segmentSafetyReason(segment: ShellSegment, cwd: string): string | undefined {
  for (const word of segment.words) {
    if (/^(NODE_TLS_REJECT_UNAUTHORIZED=0|GIT_SSL_NO_VERIFY=(1|true|yes|on))$/i.test(word)) {
      return "TLS verification weakening is hard-denied";
    }
    if (/sslverify=(false|no|off|0)$/i.test(word)) {
      return "TLS verification weakening is hard-denied";
    }
  }

  const invocation = shellSegmentInvocation(segment);
  if (!invocation) return;
  const { command: name, args } = invocation;
  const lowerArgs = args.map((argument) => argument.toLowerCase());

  if (
    (name === "curl" && args.some(curlInsecure)) ||
    (name === "wget" &&
      lowerArgs.some((argument) =>
        ["--insecure", "-k", "--no-check-certificate"].includes(argument),
      ))
  ) {
    return "certificate verification weakening is hard-denied";
  }
  if (
    ["npm", "pnpm", "yarn"].includes(name) &&
    lowerArgs[0] === "config" &&
    lowerArgs[1] === "set" &&
    ["strict-ssl", "cafile"].includes(lowerArgs[2] ?? "") &&
    ["false", "null"].includes(lowerArgs[3] ?? "")
  ) {
    return "package-manager TLS weakening is hard-denied";
  }
  if (name === "git" && lowerArgs[0] === "config") {
    const key = lowerArgs.findIndex(
      (argument, index) =>
        index > 0 && (argument === "sslverify" || argument.endsWith(".sslverify")),
    );
    const value = key === -1 ? undefined : lowerArgs.slice(key + 1).find((a) => !a.startsWith("-"));
    if (value !== undefined && GIT_FALSE_VALUES.has(value)) {
      return "git TLS verification weakening is hard-denied";
    }
  }
  if (name === "crontab" && !lowerArgs.includes("-l")) {
    return "persistence mutation is hard-denied";
  }
  if (name === "launchctl" && ["load", "bootstrap", "enable"].includes(serviceVerb(args) ?? "")) {
    return "persistence mutation is hard-denied";
  }
  if (
    name === "systemctl" &&
    ["enable", "reenable", "link", "start"].includes(serviceVerb(args) ?? "")
  ) {
    return "persistence mutation is hard-denied";
  }
  if (name === "security" && lowerArgs[0] === "add-trusted-cert") {
    return "platform security weakening is hard-denied";
  }
  if (name === "spctl" && lowerArgs.includes("--master-disable")) {
    return "platform security weakening is hard-denied";
  }
  if (name === "csrutil" && lowerArgs[0] === "disable") {
    return "platform security weakening is hard-denied";
  }

  if (name === "rm" && args.some(recursiveRmArgument)) {
    for (const argument of args.filter((value) => !value.startsWith("-"))) {
      const path = deletionTarget(cwd, argument);
      if (path && isRootHomeOrSystemPath(path)) {
        return "irreversible deletion of home, root, or system paths is hard-denied";
      }
    }
  }
  if (name === "find" && findDeletes(args)) {
    for (const start of findStartingPoints(args)) {
      const path = deletionTarget(cwd, start);
      if (path && isRootHomeOrSystemPath(path)) return "system-wide delete is hard-denied";
    }
  }
  if (["chmod", "chown"].includes(name)) {
    for (const argument of args.filter((value) => !value.startsWith("-"))) {
      const path = resolveInputPath(cwd, argument);
      if (path && systemOrSshPath(path)) {
        return "system or SSH permission mutation is hard-denied";
      }
    }
  }
}

function shellSafetyDecision(command: string, cwd: string): GuardrailDecision | undefined {
  const parsed = parseShellCommand(command);
  for (const segment of parsed.segments) {
    const reason = segmentSafetyReason(segment, cwd);
    if (reason) return block(reason);
  }
  if (parsed.unclassified.length > 0) {
    return confirm(`Shell structure could not be classified: ${parsed.unclassified[0]}.`);
  }
}

export const systemSafetyPolicy = {
  name: "system-safety",
  async guidance() {
    return "System safety guardrail: do not weaken security controls, add persistence, modify shell/SSH identity files, or destructively delete home, root, or system paths.";
  },
  async check(action, { cwd }) {
    for (const path of actionMutationTargets(action.toolName, action.input, cwd)) {
      const reason = protectedIdentityPath(path);
      if (reason) return block(reason);
    }
    if (action.toolName !== "bash" || typeof action.input.command !== "string") return;
    return shellSafetyDecision(action.input.command, cwd);
  },
} satisfies GuardrailPolicy;
