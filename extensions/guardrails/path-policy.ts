import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  parseShellSegments,
  shellSegmentInvocation,
  type CommandInvocation,
  type ShellSegment,
} from "./command-parser.ts";

/** Commands whose non-option arguments are written or replaced in place. */
const MUTATING_COMMANDS = new Set([
  "chmod",
  "chown",
  "cp",
  "install",
  "ln",
  "perl",
  "python",
  "python3",
  "ruby",
  "sed",
  "tee",
  "touch",
  "truncate",
]);

/** Commands whose non-option arguments are removed together with everything beneath them. */
const DELETING_COMMANDS = new Set(["rm", "rmdir", "unlink"]);

/** Interpreter options whose value is inline code that may name files literally. */
const INLINE_CODE_OPTIONS: Record<string, ReadonlySet<string>> = {
  node: new Set(["-e", "--eval", "-p", "--print"]),
  perl: new Set(["-e", "-E"]),
  python: new Set(["-c"]),
  python3: new Set(["-c"]),
  ruby: new Set(["-e"]),
};

const SHELL_COMMANDS = new Set(["bash", "dash", "fish", "ksh", "sh", "zsh"]);

/** Git options that consume the following word before the subcommand. */
const GIT_OPTIONS_WITH_VALUE = new Set([
  "-c",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
]);

/** Git subcommands that can rewrite tracked files in the worktree. */
const GIT_WORKTREE_REWRITES = new Set([
  "am",
  "apply",
  "checkout",
  "cherry-pick",
  "clean",
  "merge",
  "pull",
  "rebase",
  "reset",
  "restore",
  "revert",
  "stash",
  "switch",
]);

/** macOS and Windows volumes are case-insensitive by default, so path rules fold case there. */
const CASE_INSENSITIVE_PATHS = process.platform === "darwin" || process.platform === "win32";

const HEREDOC_REDIRECT = /<<(-?)\s*(?:'([^']*)'|"([^"]*)"|\\?([^\s'"<>|&;()]+))/g;

export interface MutationTarget {
  path: string;
  /** Everything beneath the path is affected, as with deletion, moves, or worktree rewrites. */
  recursive: boolean;
}

export interface MutationAnalysis {
  targets: MutationTarget[];
  /** Relative paths that follow a non-literal directory change and cannot be resolved. */
  unresolved: string[];
}

export function expandPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  if (value === "$HOME" || value === "${HOME}") return homedir();
  if (value.startsWith("$HOME/")) return resolve(homedir(), value.slice(6));
  if (value.startsWith("${HOME}/")) return resolve(homedir(), value.slice(8));
  return value;
}

export function resolveInputPath(cwd: string, value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return;
  const raw = value.trim().replace(/^@/, "");
  const expanded = expandPath(raw);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/** Resolve symlinks and on-disk casing through the nearest existing ancestor of a path. */
export function resolvePathForPolicy(path: string): string | undefined {
  return resolvePathForPolicyInner(resolve(path), new Set());
}

function resolvePathForPolicyInner(path: string, visitedSymlinks: Set<string>): string | undefined {
  let current = path;
  const missingSegments: string[] = [];

  while (true) {
    try {
      return resolve(realpathSync.native(current), ...missingSegments);
    } catch {
      try {
        const stat = lstatSync(current);
        if (!stat.isSymbolicLink() || visitedSymlinks.has(current)) return;
        visitedSymlinks.add(current);
        const target = resolve(dirname(current), readlinkSync(current));
        return resolvePathForPolicyInner(resolve(target, ...missingSegments), visitedSymlinks);
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
        if (code !== "ENOENT" && code !== "ENOTDIR") return;
        const parent = dirname(current);
        if (parent === current) return;
        missingSegments.unshift(basename(current));
        current = parent;
      }
    }
  }
}

function comparable(path: string): string {
  return CASE_INSENSITIVE_PATHS ? path.toLowerCase() : path;
}

export function samePath(left: string, right: string): boolean {
  return comparable(left) === comparable(right);
}

export function isInside(child: string, parent: string): boolean {
  const rel = relative(comparable(parent), comparable(child));
  return rel === "" || (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel));
}

function normalizeForMatch(value: string): string {
  return value.split(sep).join("/");
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      source += ".*";
      i++;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, CASE_INSENSITIVE_PATHS ? "i" : "");
}

function resolveAbsolutePattern(pattern: string): string {
  const wildcard = pattern.search(/[*?]/);
  if (wildcard === -1) return resolvePathForPolicy(pattern) ?? resolve(pattern);
  const separator = pattern.lastIndexOf("/", wildcard);
  if (separator < 1) return pattern;
  const base = pattern.slice(0, separator);
  const suffix = pattern.slice(separator);
  return `${resolvePathForPolicy(base) ?? resolve(base)}${suffix}`;
}

export function matchesPathPattern(path: string, cwd: string, pattern: string): boolean {
  const resolvedPath = resolvePathForPolicy(path) ?? resolve(path);
  const expandedPattern = expandPath(pattern);
  if (isAbsolute(expandedPattern)) {
    return globToRegExp(normalizeForMatch(resolveAbsolutePattern(expandedPattern))).test(
      normalizeForMatch(resolvedPath),
    );
  }

  const resolvedCwd = resolvePathForPolicy(cwd) ?? resolve(cwd);
  if (!isInside(resolvedPath, resolvedCwd)) return false;
  const relativePath = normalizeForMatch(
    relative(comparable(resolvedCwd), comparable(resolvedPath)),
  );
  return globToRegExp(normalizeForMatch(expandedPattern)).test(relativePath);
}

function pathArguments(args: string[]): string[] {
  return args.filter((argument) => !argument.startsWith("-") && argument !== "--");
}

function isLiteralPath(value: string): boolean {
  const expanded = expandPath(value);
  if (/[$`*?[\]{}]/.test(expanded)) return false;
  return !expanded.startsWith("~");
}

/** Tracks the shell's working directory across `cd`, `pushd`, `popd`, and subshells. */
class DirectoryTracker {
  current: string | undefined;
  private stack: Array<string | undefined> = [];
  private subshells: Array<{ current: string | undefined; stack: Array<string | undefined> }> = [];

  constructor(current: string | undefined) {
    this.current = current;
  }

  enter(count: number): void {
    for (let i = 0; i < count; i++) {
      this.subshells.push({ current: this.current, stack: [...this.stack] });
    }
  }

  exit(count: number): void {
    for (let i = 0; i < count; i++) {
      const saved = this.subshells.pop();
      if (!saved) return;
      this.current = saved.current;
      this.stack = saved.stack;
    }
  }

  resolve(value: string): string | undefined {
    if (!isLiteralPath(value)) return;
    const expanded = expandPath(value);
    if (isAbsolute(expanded)) return resolve(expanded);
    return this.current === undefined ? undefined : resolve(this.current, expanded);
  }

  apply(invocation: CommandInvocation): void {
    const { command, args } = invocation;
    if (command !== "cd" && command !== "pushd" && command !== "popd") return;
    if (command === "popd") {
      if (this.stack.length > 0) this.current = this.stack.pop();
      return;
    }
    const operand = args.find((argument) => argument === "-" || !argument.startsWith("-"));
    if (command === "pushd") {
      if (operand === undefined) {
        this.current = undefined;
        return;
      }
      this.stack.push(this.current);
    }
    if (operand === undefined) this.current = homedir();
    else if (operand === "-") this.current = undefined;
    else this.current = this.resolve(operand);
  }
}

class MutationCollector implements MutationAnalysis {
  targets: MutationTarget[] = [];
  unresolved: string[] = [];
  private seen = new Set<string>();

  add(base: string | undefined, value: unknown, recursive: boolean): void {
    if (typeof value !== "string" || value.trim().length === 0) return;
    const raw = value.trim().replace(/^@/, "");
    const expanded = expandPath(raw);
    let path: string;
    if (isAbsolute(expanded)) path = resolve(expanded);
    else if (base !== undefined) path = resolve(base, expanded);
    else {
      if (!this.unresolved.includes(raw)) this.unresolved.push(raw);
      return;
    }
    const key = `${recursive ? "r" : "f"}:${path}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.targets.push({ path, recursive });
  }
}

function optionValue(args: string[], index: number, names: string[]): string | undefined {
  const argument = args[index];
  for (const name of names) {
    if (argument === name) return args[index + 1];
    if (name.startsWith("--") && argument.startsWith(`${name}=`)) {
      return argument.slice(name.length + 1);
    }
    if (!name.startsWith("--") && argument.startsWith(name) && argument.length > name.length) {
      return argument.slice(name.length);
    }
  }
}

function findOption(args: string[], names: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const value = optionValue(args, index, names);
    if (value !== undefined) return value;
  }
}

/** Quoted literals inside inline interpreter code that plausibly name a file. */
function codePathLiterals(code: string): string[] {
  const literals: string[] = [];
  for (const match of code.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)) {
    const literal = (match[1] ?? match[2] ?? match[3]).trim();
    if (!literal || /\s/.test(literal)) continue;
    if (literal.includes("/") || /^[.~]/.test(literal) || /\.[A-Za-z0-9]{1,8}$/.test(literal)) {
      literals.push(literal);
    }
  }
  return literals;
}

function repositoryRoot(directory: string): string | undefined {
  let current = resolve(directory);
  while (true) {
    if (existsSync(resolve(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function hasRecursiveFlag(args: string[]): boolean {
  return args.some(
    (argument) =>
      argument === "--recursive" || argument === "--archive" || /^-[a-zA-Z]*[rRa]/.test(argument),
  );
}

function positionalsAfterOptions(args: string[], optionsWithValue: ReadonlySet<string>): string[] {
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (optionsWithValue.has(argument)) {
      index++;
      continue;
    }
    if (argument.startsWith("-")) continue;
    positionals.push(argument);
  }
  return positionals;
}

/** Paths a worktree-rewriting git subcommand touches, or `undefined` when it does not rewrite. */
function gitRewriteTargets(subcommand: string, args: string[]): string[] | undefined {
  const explicitPaths = args.includes("--") ? args.slice(args.indexOf("--") + 1) : undefined;
  const literalPaths = (paths: string[]) =>
    paths.some((path) => !isLiteralPath(path)) ? ["."] : paths;
  switch (subcommand) {
    case "checkout": {
      const positionals = positionalsAfterOptions(args, new Set(["-b", "-B", "--orphan"]));
      if (positionals.length === 0) return;
      return explicitPaths && explicitPaths.length > 0 ? literalPaths(explicitPaths) : ["."];
    }
    case "switch":
      return positionalsAfterOptions(args, new Set(["-c", "-C", "--orphan"])).length > 0
        ? ["."]
        : undefined;
    case "restore": {
      if (args.includes("--staged") && !args.includes("--worktree") && !args.includes("-W")) return;
      const positionals = positionalsAfterOptions(args, new Set(["-s", "--source"]));
      return positionals.length > 0 ? literalPaths(positionals) : ["."];
    }
    case "reset":
      return args.some((argument) => ["--hard", "--merge", "--keep"].includes(argument))
        ? ["."]
        : undefined;
    case "stash":
      return ["list", "show"].includes(args.find((argument) => !argument.startsWith("-")) ?? "")
        ? undefined
        : ["."];
    case "clean": {
      if (args.some((argument) => argument === "--dry-run" || /^-[a-zA-Z]*n/.test(argument)))
        return;
      const positionals = positionalsAfterOptions(args, new Set(["-e", "--exclude"]));
      return positionals.length > 0 ? literalPaths(positionals) : ["."];
    }
    case "apply":
      return args.some((argument) =>
        ["--check", "--stat", "--numstat", "--summary", "--cached"].includes(argument),
      )
        ? undefined
        : ["."];
    default:
      return ["."];
  }
}

function collectGitTargets(
  collector: MutationCollector,
  tracker: DirectoryTracker,
  args: string[],
): void {
  let cwd = tracker.current;
  let workTree: string | undefined;
  let index = 0;
  while (index < args.length && args[index].startsWith("-")) {
    const option = args[index];
    const directory = optionValue(args, index, ["-C"]);
    if (directory !== undefined) {
      cwd = cwd === undefined ? undefined : new DirectoryTracker(cwd).resolve(directory);
      index += option === "-C" ? 2 : 1;
      continue;
    }
    const tree = optionValue(args, index, ["--work-tree"]);
    if (tree !== undefined) {
      workTree = tree;
      index += option === "--work-tree" ? 2 : 1;
      continue;
    }
    index += GIT_OPTIONS_WITH_VALUE.has(option) ? 2 : 1;
  }

  const subcommand = args[index];
  if (!subcommand || !GIT_WORKTREE_REWRITES.has(subcommand)) return;
  const paths = gitRewriteTargets(subcommand, args.slice(index + 1));
  if (!paths) return;

  let root: string | undefined;
  if (workTree !== undefined) {
    root = cwd === undefined ? undefined : new DirectoryTracker(cwd).resolve(workTree);
    if (root === undefined) {
      collector.add(undefined, workTree, true);
      return;
    }
  } else if (cwd !== undefined) {
    root = repositoryRoot(cwd) ?? cwd;
  }
  for (const path of paths) {
    collector.add(path === "." ? root : cwd, path === "." ? "." : path, true);
  }
}

function collectInvocationTargets(
  collector: MutationCollector,
  tracker: DirectoryTracker,
  invocation: CommandInvocation,
): void {
  const { command, args } = invocation;
  const base = tracker.current;

  if (command === "git") {
    collectGitTargets(collector, tracker, args);
    return;
  }
  if (command === "dd") {
    for (const argument of args) {
      if (argument.startsWith("of=")) collector.add(base, argument.slice(3), false);
    }
    return;
  }
  if (DELETING_COMMANDS.has(command)) {
    for (const path of pathArguments(args)) collector.add(base, path, true);
    return;
  }
  if (command === "mv") {
    const paths = pathArguments(args);
    paths.forEach((path, index) => collector.add(base, path, index < paths.length - 1));
    return;
  }
  if (command === "cp") {
    const paths = pathArguments(args);
    const recursive = hasRecursiveFlag(args);
    paths.forEach((path, index) =>
      collector.add(base, path, recursive && index === paths.length - 1),
    );
    return;
  }
  if (command === "rsync") {
    const paths = pathArguments(args);
    if (paths.length > 1) collector.add(base, paths[paths.length - 1], true);
    return;
  }
  if (command === "find" && args.includes("-delete")) {
    for (const argument of args) {
      if (argument.startsWith("-")) break;
      collector.add(base, argument, true);
    }
    return;
  }
  if (command === "patch") {
    collector.add(base, findOption(args, ["-d", "--directory"]) ?? ".", true);
    const output = findOption(args, ["-o", "--output"]);
    if (output !== undefined) collector.add(base, output, false);
    return;
  }
  if (command === "tar") {
    const extracting = args.some(
      (argument, index) =>
        argument === "--extract" ||
        argument === "--get" ||
        (/^-?[a-zA-Z]+$/.test(argument) &&
          (index === 0 || argument.startsWith("-")) &&
          argument.includes("x")),
    );
    if (extracting) collector.add(base, findOption(args, ["-C", "--directory"]) ?? ".", true);
    return;
  }

  const codeOptions = INLINE_CODE_OPTIONS[command];
  const remaining: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (codeOptions?.has(args[index]) && args[index + 1] !== undefined) {
      for (const literal of codePathLiterals(args[index + 1])) collector.add(base, literal, false);
      index++;
      continue;
    }
    remaining.push(args[index]);
  }
  if (MUTATING_COMMANDS.has(command)) {
    for (const path of pathArguments(remaining)) collector.add(base, path, false);
  }
}

/** Literal `-c` text of a shell invocation; it is re-parsed with its own directory scoping. */
function shellCommandText(invocation: CommandInvocation): string | undefined {
  if (!SHELL_COMMANDS.has(invocation.command)) return;
  const index = invocation.args.findIndex((argument) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(argument));
  const text = index === -1 ? undefined : invocation.args[index + 1];
  return text !== undefined && !/[$`]/.test(text) ? text : undefined;
}

function collectSegment(
  collector: MutationCollector,
  tracker: DirectoryTracker,
  segment: ShellSegment,
  directoryPersists: boolean,
): CommandInvocation | undefined {
  for (const redirect of segment.redirectTargets) collector.add(tracker.current, redirect, false);
  const invocation = shellSegmentInvocation(segment);
  if (!invocation) return;
  collectInvocationTargets(collector, tracker, invocation);
  if (directoryPersists) tracker.apply(invocation);
  return invocation;
}

/** Skip the heredoc bodies that follow a segment so they are not mistaken for shell structure. */
function skipHeredocBodies(command: string, segment: ShellSegment, end: number): number {
  let cursor = end;
  for (const match of segment.text.matchAll(HEREDOC_REDIRECT)) {
    const delimiter = match[2] ?? match[3] ?? match[4];
    const stripTabs = match[1] === "-";
    let lineStart = command.indexOf("\n", cursor);
    if (lineStart === -1) return cursor;
    lineStart++;
    while (lineStart <= command.length) {
      const newline = command.indexOf("\n", lineStart);
      const lineEnd = newline === -1 ? command.length : newline;
      let line = command.slice(lineStart, lineEnd);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) {
        cursor = lineEnd;
        break;
      }
      if (newline === -1) return cursor;
      lineStart = newline + 1;
    }
  }
  return cursor;
}

function withoutComments(gap: string): string {
  return gap.replace(/#[^\n]*/g, "");
}

/** A single `|` or `&` after a segment runs it in a subshell, so its `cd` does not persist. */
function runsInSubshell(gapAfter: string): boolean {
  const gap = withoutComments(gapAfter);
  return /(^|[^|])\|(?!\|)/.test(gap) || /(^|[^&;|])&(?!&)/.test(gap);
}

interface LocatedSegment {
  segment: ShellSegment;
  /** Offsets in the command for top-level segments; nested command text has none. */
  start?: number;
  after?: number;
}

/**
 * Locate top-level segments in the command text. Segments the parser lifted out of nested text
 * (substitutions, `-c` strings, heredoc bodies) are not found after the previous top-level
 * segment, and heredoc bodies are skipped so their lines are not mistaken for top-level commands.
 */
function locateSegments(command: string, segments: ShellSegment[]): LocatedSegment[] {
  const located: LocatedSegment[] = [];
  let cursor = 0;
  for (const segment of segments) {
    const start = segment.text.length > 0 ? command.indexOf(segment.text, cursor) : -1;
    if (start === -1) {
      located.push({ segment });
      continue;
    }
    const after = skipHeredocBodies(command, segment, start + segment.text.length);
    located.push({ segment, start, after });
    cursor = after;
  }
  return located;
}

/**
 * Walk the parsed segments, following `cd`/`pushd`/`popd`. Parentheses only appear in the text
 * between top-level segments, so subshell entry and exit are read from those gaps. Commands
 * nested in substitutions, heredocs, or literal `-c` text run in their own scope.
 */
function collectShellMutations(
  collector: MutationCollector,
  tracker: DirectoryTracker,
  command: string,
): void {
  const located = locateSegments(command, parseShellSegments(command));
  let gapFrom = 0;
  let nested: DirectoryTracker | undefined;
  let skipNested = false;

  for (let index = 0; index < located.length; index++) {
    const { segment, start, after } = located[index];
    if (start === undefined || after === undefined) {
      if (skipNested) continue;
      nested ??= new DirectoryTracker(tracker.current);
      collectSegment(collector, nested, segment, true);
      continue;
    }

    nested = undefined;
    for (const char of withoutComments(command.slice(gapFrom, start))) {
      if (char === "(") tracker.enter(1);
      else if (char === ")") tracker.exit(1);
    }
    const next = located.slice(index + 1).find((entry) => entry.start !== undefined);
    const gapAfter = command.slice(after, next?.start ?? command.length);
    const invocation = collectSegment(collector, tracker, segment, !runsInSubshell(gapAfter));
    const text = invocation && shellCommandText(invocation);
    skipNested = text !== undefined;
    if (text !== undefined) {
      collectShellMutations(collector, new DirectoryTracker(tracker.current), text);
    }
    gapFrom = after;
  }
}

/**
 * Extract likely write targets from shell redirects and common mutating commands, following
 * literal `cd`/`pushd` changes. This is intentionally conservative and is not a complete shell
 * interpreter.
 */
export function analyzeShellMutations(command: string, cwd: string): MutationAnalysis {
  const collector = new MutationCollector();
  collectShellMutations(collector, new DirectoryTracker(cwd), command);
  return { targets: collector.targets, unresolved: collector.unresolved };
}

export function analyzeActionMutations(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): MutationAnalysis {
  if (toolName === "write" || toolName === "edit") {
    const path = resolveInputPath(cwd, input.path);
    return { targets: path ? [{ path, recursive: false }] : [], unresolved: [] };
  }
  if (toolName === "bash" && typeof input.command === "string") {
    return analyzeShellMutations(input.command, cwd);
  }
  return { targets: [], unresolved: [] };
}

function flattenTargets(analysis: MutationAnalysis, cwd: string): string[] {
  return [
    ...analysis.targets.map((target) => target.path),
    ...analysis.unresolved.map((path) => resolve(cwd, expandPath(path))),
  ];
}

/** Flat target paths; unresolved relative paths fall back to the action's working directory. */
export function shellMutationTargets(command: string, cwd: string): string[] {
  return flattenTargets(analyzeShellMutations(command, cwd), cwd);
}

export function actionMutationTargets(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): string[] {
  return flattenTargets(analyzeActionMutations(toolName, input, cwd), cwd);
}
