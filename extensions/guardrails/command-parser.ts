import { homedir } from "node:os";
import { basename, resolve } from "node:path";

export interface CommandInvocation {
  command: string;
  args: string[];
}

export interface GitInvocation {
  cwd: string;
  subcommand: string;
  args: string[];
}

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
const COMMAND_WRAPPERS = new Set(["command", "env", "exec", "nohup", "sudo"]);

interface HeredocDelimiter {
  value: string;
  stripTabs: boolean;
}

function heredocDelimiterAt(
  command: string,
  index: number,
): { delimiter: HeredocDelimiter; end: number } | undefined {
  if (command[index] !== "<" || command[index + 1] !== "<" || command[index + 2] === "<") {
    return;
  }

  let cursor = index + 2;
  let stripTabs = false;
  if (command[cursor] === "-") {
    stripTabs = true;
    cursor++;
  }
  while (command[cursor] === " " || command[cursor] === "\t") cursor++;

  let value = "";
  let quote: "'" | '"' | undefined;
  let sawToken = false;
  for (; cursor < command.length; cursor++) {
    const char = command[cursor];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (char === "\\" && quote === '"') {
        const next = command[cursor + 1];
        if (next === "\n") cursor++;
        else if (next && /[$`"\\]/.test(next)) value += command[++cursor];
        else value += char;
      } else {
        value += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      sawToken = true;
      continue;
    }
    if (char === "\\") {
      const next = command[cursor + 1];
      if (next === "\n") cursor++;
      else if (next !== undefined) value += command[++cursor];
      else value += char;
      sawToken ||= next !== "\n";
      continue;
    }
    if (/\s/.test(char) || /[;&|()<>]/.test(char)) break;
    value += char;
    sawToken = true;
  }

  return sawToken ? { delimiter: { value, stripTabs }, end: cursor } : undefined;
}

function maskHeredocBodies(
  command: string,
  characters: string[],
  start: number,
  delimiters: HeredocDelimiter[],
): number | undefined {
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = start;
  for (const delimiter of delimiters) {
    let found = false;
    const bodyStart = cursor;
    while (cursor <= command.length) {
      const newline = command.indexOf("\n", cursor);
      const lineEnd = newline === -1 ? command.length : newline;
      let line = command.slice(cursor, lineEnd);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const comparable = delimiter.stripTabs ? line.replace(/^\t+/, "") : line;

      cursor = newline === -1 ? command.length : newline + 1;
      if (comparable === delimiter.value) {
        ranges.push({ start: bodyStart, end: lineEnd });
        found = true;
        break;
      }
      if (newline === -1) break;
    }
    if (!found) return;
  }

  for (const range of ranges) {
    for (let index = range.start; index < range.end; index++) characters[index] = " ";
  }
  return cursor;
}

function withoutHeredocBodies(command: string): string {
  if (!command.includes("<<")) return command;

  const characters = command.split("");
  const delimiters: HeredocDelimiter[] = [];
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  let arithmeticDepth = 0;

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote !== "'") escaped = true;
      continue;
    }
    if (arithmeticDepth > 0) {
      if (char === "(") arithmeticDepth++;
      else if (char === ")") arithmeticDepth--;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || /[\s;&|()<>]/.test(command[index - 1] ?? ""))) {
      const newline = command.indexOf("\n", index);
      if (newline === -1) break;
      index = newline - 1;
      continue;
    }
    if (char === "(" && command[index + 1] === "(") {
      arithmeticDepth = 2;
      index++;
      continue;
    }
    const heredoc = heredocDelimiterAt(command, index);
    if (heredoc) {
      delimiters.push(heredoc.delimiter);
      index = heredoc.end - 1;
      continue;
    }
    if (char === "\n" && delimiters.length > 0) {
      const next = maskHeredocBodies(command, characters, index + 1, delimiters);
      delimiters.length = 0;
      if (next !== undefined) index = next - 1;
    }
  }

  return characters.join("");
}

export function shellWords(command: string): string[] {
  const source = withoutHeredocBodies(command);
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const flush = () => {
    if (word) words.push(word);
    word = "";
  };

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (escaped) {
      word += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char) || /[;&|()]/.test(char)) {
      flush();
      if (char === "\n" || /[;&|()]/.test(char)) words.push(";");
      continue;
    }
    word += char;
  }
  flush();
  return words;
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

function isCommandPosition(words: string[], index: number): boolean {
  let start = index - 1;
  while (start >= 0 && words[start] !== ";") start--;
  const prefix = words.slice(start + 1, index);
  if (prefix.every((word) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word))) return true;
  return COMMAND_WRAPPERS.has(prefix[0]);
}

export function findCommandInvocations(
  command: string,
  commandNames: ReadonlySet<string>,
): CommandInvocation[] {
  const words = shellWords(command);
  const invocations: CommandInvocation[] = [];

  for (let i = 0; i < words.length; i++) {
    const commandName = basename(words[i]);
    if (!commandNames.has(commandName) || !isCommandPosition(words, i)) continue;

    const args: string[] = [];
    for (let cursor = i + 1; cursor < words.length && words[cursor] !== ";"; cursor++) {
      args.push(words[cursor]);
    }
    invocations.push({ command: commandName, args });
  }

  return invocations;
}

export function findGitInvocations(command: string, baseCwd: string): GitInvocation[] {
  const words = shellWords(command);
  const invocations: GitInvocation[] = [];

  for (let i = 0; i < words.length; i++) {
    if (basename(words[i]) !== "git" || !isCommandPosition(words, i)) continue;

    let cwd = baseCwd;
    let cursor = i + 1;
    while (cursor < words.length && words[cursor] !== ";" && words[cursor].startsWith("-")) {
      const option = words[cursor];
      if (option === "-C" && words[cursor + 1] && words[cursor + 1] !== ";") {
        cwd = resolve(cwd, expandHome(words[cursor + 1]));
        cursor += 2;
        continue;
      }
      if (option.startsWith("-C") && option.length > 2) {
        cwd = resolve(cwd, expandHome(option.slice(2)));
        cursor++;
        continue;
      }
      if (GIT_OPTIONS_WITH_VALUE.has(option)) cursor += 2;
      else cursor++;
    }

    if (cursor >= words.length || words[cursor] === ";") continue;
    const subcommand = words[cursor];
    const args: string[] = [];
    for (cursor++; cursor < words.length && words[cursor] !== ";"; cursor++) {
      args.push(words[cursor]);
    }
    invocations.push({ cwd, subcommand, args });
  }

  return invocations;
}

export interface ShellSegment {
  text: string;
  words: string[];
  redirectTargets: string[];
}

function splitShellSegments(command: string): string[] {
  const source = withoutHeredocBodies(command);
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";" || char === "\n" || char === "|" || (char === "&" && next === "&")) {
      if (current.trim()) segments.push(current.trim());
      current = "";
      if ((char === "|" && next === "|") || (char === "&" && next === "&")) i++;
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function tokenizeShellSegment(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;

  const flush = () => {
    if (current) tokens.push(current);
    current = "";
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    if (char === ">" || char === "<") {
      let operator = char;
      if (/^\d+$/.test(current)) operator = `${current}${char}`;
      else flush();
      if (text[i + 1] === ">" || text[i + 1] === "&") {
        operator += text[i + 1];
        i++;
      }
      tokens.push(operator);
      current = "";
      continue;
    }
    current += char;
  }
  flush();
  return tokens;
}

/**
 * Parse the shell structure needed by deterministic safety policies.
 * This intentionally is not a complete POSIX shell parser.
 */
export function parseShellSegments(command: string): ShellSegment[] {
  return splitShellSegments(command).map((text) => {
    const tokens = tokenizeShellSegment(text);
    const words: string[] = [];
    const redirectTargets: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (/^(?:\d?>|\d?>>|>|>>|&>|<)$/.test(token)) {
        const target = tokens[i + 1];
        if (target) redirectTargets.push(target);
        i++;
        continue;
      }
      words.push(token);
    }
    return { text, words, redirectTargets };
  });
}

const WRAPPERS = new Set(["command", "env", "exec", "nohup", "sudo"]);
const WRAPPER_OPTIONS_WITH_VALUE = new Set(["-C", "--chdir", "-g", "--group", "-u", "--user"]);

/** Resolve the executable and arguments after common command wrappers. */
export function shellSegmentInvocation(
  segment: ShellSegment,
): { command: string; args: string[] } | undefined {
  let index = 0;
  while (index < segment.words.length) {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(segment.words[index] ?? "")) index++;
    const command = basename(segment.words[index] ?? "");
    if (!command) return;
    if (!WRAPPERS.has(command)) {
      return { command, args: segment.words.slice(index + 1) };
    }

    index++;
    while (index < segment.words.length) {
      const argument = segment.words[index];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argument)) {
        index++;
        continue;
      }
      if (WRAPPER_OPTIONS_WITH_VALUE.has(argument)) {
        index += 2;
        continue;
      }
      if (argument.startsWith("-")) {
        index++;
        continue;
      }
      break;
    }
  }
}
