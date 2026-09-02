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

/** One simple command, including assignments and wrapper words in source order. */
export interface ShellSegment {
  text: string;
  words: string[];
  redirectTargets: string[];
}

export interface ShellParse {
  /** Every simple command in source order, including commands nested in literal text. */
  segments: ShellSegment[];
  /** Structure the parser could not classify; policies treat it as requiring confirmation. */
  unclassified: string[];
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
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
const MAX_DEPTH = 5;

// Tokenizer

type Operator = ";" | ";;" | ";&" | ";;&" | "\n" | "&" | "&&" | "|" | "||" | "|&" | "(" | ")";

interface WordToken {
  kind: "word";
  /** Quotes removed and escapes resolved; expansions are kept verbatim. */
  value: string;
  raw: string;
  /** No parameter, command, or arithmetic expansion outside single quotes. */
  literal: boolean;
  /** Unquoted pathname or brace expansion characters. */
  expands: boolean;
  quoted: boolean;
  arithmetic: boolean;
  /** Inner text of `$(...)`, backticks, and process substitutions. */
  substitutions: string[];
  start: number;
  end: number;
}

interface OperatorToken {
  kind: "operator";
  value: Operator;
  start: number;
  end: number;
}

interface Heredoc {
  delimiter: string;
  stripTabs: boolean;
  body: string;
}

interface RedirectToken {
  kind: "redirect";
  operator: string;
  target?: WordToken;
  heredoc?: Heredoc;
  start: number;
  end: number;
}

type Token = WordToken | OperatorToken | RedirectToken;

interface WordBuilder {
  value: string;
  literal: boolean;
  expands: boolean;
  quoted: boolean;
  substitutions: string[];
}

const METACHARACTERS = new Set([" ", "\t", "\r", "\n", ";", "&", "|", "(", ")", "<", ">"]);
const REDIRECT_OPERATORS = ["<<<", "<<-", "<<", "<>", "<&", "<", ">>", ">|", ">&", ">"];

function findClosingBacktick(source: string, index: number): number {
  for (let cursor = index + 1; cursor < source.length; cursor++) {
    if (source[cursor] === "\\") cursor++;
    else if (source[cursor] === "`") return cursor;
  }
  return -1;
}

/** Index of the closing quote of a double-quoted string starting after `index`. */
function skipDoubleQuoted(source: string, index: number): number {
  for (let cursor = index; cursor < source.length; cursor++) {
    const char = source[cursor];
    if (char === "\\") cursor++;
    else if (char === '"') return cursor;
    else if (char === "$" && source[cursor + 1] === "(") {
      const close = findClosingParen(source, cursor + 1);
      if (close === -1) return -1;
      cursor = close;
    } else if (char === "`") {
      const close = findClosingBacktick(source, cursor);
      if (close === -1) return -1;
      cursor = close;
    }
  }
  return -1;
}

function findClosingParen(source: string, openIndex: number): number {
  let depth = 0;
  for (let cursor = openIndex; cursor < source.length; cursor++) {
    const char = source[cursor];
    if (char === "\\") {
      cursor++;
      continue;
    }
    if (char === "'") {
      const close = source.indexOf("'", cursor + 1);
      if (close === -1) return -1;
      cursor = close;
      continue;
    }
    if (char === '"') {
      const close = skipDoubleQuoted(source, cursor + 1);
      if (close === -1) return -1;
      cursor = close;
      continue;
    }
    if (char === "`") {
      const close = findClosingBacktick(source, cursor);
      if (close === -1) return -1;
      cursor = close;
      continue;
    }
    if (char === "#" && (cursor === openIndex + 1 || /[\s;&|(]/.test(source[cursor - 1]))) {
      const newline = source.indexOf("\n", cursor);
      if (newline === -1) return -1;
      cursor = newline;
      continue;
    }
    if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return cursor;
  }
  return -1;
}

function findClosingBrace(source: string, openIndex: number): number {
  let depth = 0;
  for (let cursor = openIndex; cursor < source.length; cursor++) {
    const char = source[cursor];
    if (char === "\\") cursor++;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return cursor;
  }
  return -1;
}

/** Index just past the `))` closing an arithmetic expression opened at `openIndex`. */
function findArithmeticEnd(source: string, openIndex: number): number {
  let depth = 0;
  for (let cursor = openIndex; cursor < source.length; cursor++) {
    if (source[cursor] === "(") depth++;
    else if (source[cursor] === ")" && --depth === 0) return cursor + 1;
  }
  return -1;
}

function braceExpansionAt(source: string, index: number): boolean {
  let separator = false;
  for (let cursor = index + 1; cursor < source.length; cursor++) {
    const char = source[cursor];
    if (char === "}") return separator;
    if (METACHARACTERS.has(char) || char === "'" || char === '"') return false;
    if (char === "," || (char === "." && source[cursor + 1] === ".")) separator = true;
  }
  return false;
}

class Tokenizer {
  readonly tokens: Token[] = [];
  readonly errors: string[] = [];
  private readonly source: string;
  private index = 0;
  private readonly pendingHeredocs: Heredoc[] = [];

  constructor(source: string) {
    this.source = source;
  }

  run(): this {
    const { source } = this;
    while (this.index < source.length) {
      const char = source[this.index];
      const next = source[this.index + 1];
      if (char === " " || char === "\t" || char === "\r") {
        this.index++;
      } else if (char === "\\" && next === "\n") {
        this.index += 2;
      } else if (char === "#") {
        const newline = source.indexOf("\n", this.index);
        this.index = newline === -1 ? source.length : newline;
      } else if (char === "\n") {
        this.operator("\n");
        if (this.pendingHeredocs.length > 0) this.readHeredocBodies();
      } else if (char === ";") {
        this.operator(
          source.startsWith(";;&", this.index)
            ? ";;&"
            : next === ";"
              ? ";;"
              : next === "&"
                ? ";&"
                : ";",
        );
      } else if (char === "&") {
        if (next === "&") this.operator("&&");
        else if (next === ">") this.redirect(source[this.index + 2] === ">" ? "&>>" : "&>");
        else this.operator("&");
      } else if (char === "|") {
        this.operator(next === "|" ? "||" : next === "&" ? "|&" : "|");
      } else if (char === "(") {
        if (next === "(") this.arithmeticWord();
        else this.operator("(");
      } else if (char === ")") {
        this.operator(")");
      } else if (!this.tryRedirect()) {
        this.tokens.push(this.readWord());
      }
    }
    if (this.pendingHeredocs.length > 0) this.readHeredocBodies();
    return this;
  }

  private operator(value: Operator): void {
    this.tokens.push({
      kind: "operator",
      value,
      start: this.index,
      end: this.index + value.length,
    });
    this.index += value.length;
  }

  private arithmeticWord(): void {
    const start = this.index;
    const end = findArithmeticEnd(this.source, start);
    if (end === -1) {
      this.errors.push("unbalanced parentheses");
      this.index = this.source.length;
      return;
    }
    const raw = this.source.slice(start, end);
    this.tokens.push({
      kind: "word",
      value: raw,
      raw,
      literal: false,
      expands: false,
      quoted: false,
      arithmetic: true,
      substitutions: [],
      start,
      end,
    });
    this.index = end;
  }

  private tryRedirect(): boolean {
    const { source } = this;
    let cursor = this.index;
    while (source[cursor] >= "0" && source[cursor] <= "9") cursor++;
    const char = source[cursor];
    if ((char !== "<" && char !== ">") || source[cursor + 1] === "(") return false;
    const operator = REDIRECT_OPERATORS.find((candidate) => source.startsWith(candidate, cursor));
    if (!operator) return false;
    this.redirect(operator, cursor);
    return true;
  }

  private redirect(operator: string, operatorIndex = this.index): void {
    const start = this.index;
    this.index = operatorIndex + operator.length;
    while (this.source[this.index] === " " || this.source[this.index] === "\t") this.index++;
    const token: RedirectToken = { kind: "redirect", operator, start, end: this.index };
    const next = this.source[this.index];
    if (
      next !== undefined &&
      (!METACHARACTERS.has(next) ||
        ((next === "<" || next === ">") && this.source[this.index + 1] === "("))
    ) {
      token.target = this.readWord();
      token.end = token.target.end;
    }
    if (operator === "<<" || operator === "<<-") {
      token.heredoc = {
        delimiter: token.target?.value ?? "",
        stripTabs: operator === "<<-",
        body: "",
      };
      this.pendingHeredocs.push(token.heredoc);
      delete token.target;
    }
    this.tokens.push(token);
  }

  private readHeredocBodies(): void {
    const { source } = this;
    for (const heredoc of this.pendingHeredocs) {
      const lines: string[] = [];
      while (this.index < source.length) {
        const newline = source.indexOf("\n", this.index);
        const lineEnd = newline === -1 ? source.length : newline;
        const line = source.slice(this.index, lineEnd).replace(/\r$/, "");
        this.index = newline === -1 ? source.length : newline + 1;
        const comparable = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;
        if (comparable === heredoc.delimiter) break;
        lines.push(comparable);
      }
      heredoc.body = lines.join("\n");
    }
    this.pendingHeredocs.length = 0;
  }

  private readWord(): WordToken {
    const { source } = this;
    const start = this.index;
    const word: WordBuilder = {
      value: "",
      literal: true,
      expands: false,
      quoted: false,
      substitutions: [],
    };
    let cursor = start;
    let bracket = false;
    while (cursor < source.length) {
      const char = source[cursor];
      const next = source[cursor + 1];
      if (char === "\\") {
        if (next === undefined) {
          word.value += char;
          cursor++;
        } else {
          if (next !== "\n") word.value += next;
          cursor += 2;
        }
      } else if (char === "'") {
        word.quoted = true;
        cursor = this.readSingleQuoted(cursor + 1, word);
      } else if (char === '"') {
        word.quoted = true;
        cursor = this.readDoubleQuoted(cursor + 1, word);
      } else if (char === "$" && next === "'") {
        word.quoted = true;
        cursor = this.readAnsiQuoted(cursor + 2, word);
      } else if (char === "$" && next === '"') {
        word.quoted = true;
        cursor = this.readDoubleQuoted(cursor + 2, word);
      } else if (char === "$") {
        cursor = this.readDollar(cursor, word);
      } else if (char === "`") {
        cursor = this.readBacktick(cursor, word);
      } else if ((char === "<" || char === ">") && next === "(") {
        cursor = this.readSubstitution(cursor, cursor + 1, word);
      } else if (METACHARACTERS.has(char)) {
        break;
      } else {
        if (char === "*" || char === "?" || (char === "]" && bracket)) word.expands = true;
        if (char === "[") bracket = true;
        if (char === "{" && braceExpansionAt(source, cursor)) word.expands = true;
        word.value += char;
        cursor++;
      }
    }
    this.index = cursor;
    return {
      kind: "word",
      ...word,
      raw: source.slice(start, cursor),
      arithmetic: false,
      start,
      end: cursor,
    };
  }

  private readSingleQuoted(index: number, word: WordBuilder): number {
    const close = this.source.indexOf("'", index);
    if (close === -1) {
      this.errors.push("unterminated quote");
      word.value += this.source.slice(index);
      return this.source.length;
    }
    word.value += this.source.slice(index, close);
    return close + 1;
  }

  private readAnsiQuoted(index: number, word: WordBuilder): number {
    const { source } = this;
    for (let cursor = index; cursor < source.length; cursor++) {
      const char = source[cursor];
      if (char === "'") return cursor + 1;
      if (char === "\\" && cursor + 1 < source.length) {
        const escaped = source[++cursor];
        word.value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
        continue;
      }
      word.value += char;
    }
    this.errors.push("unterminated quote");
    return source.length;
  }

  private readDoubleQuoted(index: number, word: WordBuilder): number {
    const { source } = this;
    let cursor = index;
    while (cursor < source.length) {
      const char = source[cursor];
      if (char === '"') return cursor + 1;
      if (char === "\\") {
        const next = source[cursor + 1];
        if (next === "\n") cursor += 2;
        else if (next !== undefined && '$`"\\'.includes(next)) {
          word.value += next;
          cursor += 2;
        } else {
          word.value += char;
          cursor++;
        }
      } else if (char === "$") cursor = this.readDollar(cursor, word);
      else if (char === "`") cursor = this.readBacktick(cursor, word);
      else {
        word.value += char;
        cursor++;
      }
    }
    this.errors.push("unterminated quote");
    return source.length;
  }

  private readDollar(index: number, word: WordBuilder): number {
    const { source } = this;
    const next = source[index + 1];
    if (next === "(") {
      if (source[index + 2] !== "(") return this.readSubstitution(index, index + 1, word);
      word.literal = false;
      const end = findArithmeticEnd(source, index + 1);
      if (end === -1) {
        this.errors.push("unbalanced parentheses");
        word.value += source.slice(index);
        return source.length;
      }
      word.value += source.slice(index, end);
      return end;
    }
    if (next === "{") {
      word.literal = false;
      const close = findClosingBrace(source, index + 1);
      const end = close === -1 ? source.length : close + 1;
      word.value += source.slice(index, end);
      return end;
    }
    if (next !== undefined && /[A-Za-z_0-9@*#?$!-]/.test(next)) {
      word.literal = false;
      let end = index + 2;
      if (/[A-Za-z_]/.test(next)) {
        while (end < source.length && /[A-Za-z0-9_]/.test(source[end])) end++;
      }
      word.value += source.slice(index, end);
      return end;
    }
    word.value += "$";
    return index + 1;
  }

  private readSubstitution(start: number, openIndex: number, word: WordBuilder): number {
    const { source } = this;
    word.literal = false;
    const close = findClosingParen(source, openIndex);
    if (close === -1) {
      this.errors.push("unbalanced parentheses");
      word.value += source.slice(start);
      return source.length;
    }
    word.substitutions.push(source.slice(openIndex + 1, close));
    word.value += source.slice(start, close + 1);
    return close + 1;
  }

  private readBacktick(index: number, word: WordBuilder): number {
    const { source } = this;
    word.literal = false;
    const close = findClosingBacktick(source, index);
    if (close === -1) {
      this.errors.push("unterminated quote");
      word.value += source.slice(index);
      return source.length;
    }
    word.substitutions.push(source.slice(index + 1, close).replace(/\\([`$\\])/g, "$1"));
    word.value += source.slice(index, close + 1);
    return close + 1;
  }
}

// Command-position resolver

interface SimpleCommand {
  text: string;
  tokens: WordToken[];
  redirects: RedirectToken[];
  substitutions: string[];
  terminator?: Operator;
  afterPipe: boolean;
  commandIndex?: number;
  name?: string;
  fedByHeredoc: boolean;
  /** Literal command text routed to this command's standard input. */
  bodies: string[];
}

const RESERVED_WORDS = new Set([
  "{",
  "}",
  "!",
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "while",
  "until",
  "do",
  "done",
  "coproc",
]);

function isAssignment(token: WordToken): boolean {
  return ASSIGNMENT.test(token.value) && !/^["']/.test(token.raw);
}

function splitSimpleCommands(
  source: string,
  tokens: Token[],
  stray: string[],
  errors: string[],
): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  const caseModes: Array<"header" | "pattern" | "body"> = [];
  let current: { command: SimpleCommand; start: number; end: number } | undefined;
  let commandPosition = true;
  let pipePending = false;
  let loopHeader = false;
  let functionName = false;
  let depth = 0;

  const open = (token: Token): SimpleCommand => {
    current ??= {
      command: {
        text: "",
        tokens: [],
        redirects: [],
        substitutions: [],
        afterPipe: pipePending,
        fedByHeredoc: false,
        bodies: [],
      },
      start: token.start,
      end: token.end,
    };
    pipePending = false;
    current.end = token.end;
    return current.command;
  };
  const close = (terminator?: Operator): void => {
    if (!current) return;
    current.command.text = source.slice(current.start, current.end);
    current.command.terminator = terminator;
    commands.push(current.command);
    current = undefined;
  };

  for (const token of tokens) {
    if (token.kind === "operator") {
      close(token.value);
      if (token.value === "|" || token.value === "|&") pipePending = true;
      const mode = caseModes.at(-1);
      if (mode === "pattern") {
        if (token.value === ")") {
          caseModes[caseModes.length - 1] = "body";
          commandPosition = true;
        }
        continue;
      }
      if (
        mode === "body" &&
        (token.value === ";;" || token.value === ";&" || token.value === ";;&")
      ) {
        caseModes[caseModes.length - 1] = "pattern";
        continue;
      }
      if (token.value === ";" || token.value === "\n") loopHeader = false;
      if (token.value === "(") depth++;
      else if (token.value === ")") {
        if (depth === 0) errors.push("unbalanced parentheses");
        else depth--;
      }
      commandPosition = true;
      continue;
    }
    if (token.kind === "redirect") {
      const command = open(token);
      command.redirects.push(token);
      if (token.target) command.substitutions.push(...token.target.substitutions);
      continue;
    }

    const mode = caseModes.at(-1);
    if (mode === "header" || mode === "pattern" || loopHeader || functionName) {
      stray.push(...token.substitutions);
      if (mode === "header" && token.value === "in" && !token.quoted) {
        caseModes[caseModes.length - 1] = "pattern";
      } else if (mode === "pattern" && token.value === "esac" && !token.quoted) {
        caseModes.pop();
        commandPosition = true;
      }
      functionName = false;
      continue;
    }
    if (commandPosition) {
      if (token.arithmetic) continue;
      if (isAssignment(token)) {
        const command = open(token);
        command.tokens.push(token);
        command.substitutions.push(...token.substitutions);
        continue;
      }
      if (!token.quoted) {
        const { value } = token;
        if (RESERVED_WORDS.has(value)) continue;
        if (value === "esac" && caseModes.length > 0) {
          caseModes.pop();
          continue;
        }
        if (value === "for" || value === "select") {
          loopHeader = true;
          continue;
        }
        if (value === "case") {
          caseModes.push("header");
          continue;
        }
        if (value === "function") {
          functionName = true;
          continue;
        }
      }
      commandPosition = false;
    }
    const command = open(token);
    command.tokens.push(token);
    command.substitutions.push(...token.substitutions);
  }
  close();
  if (depth > 0) errors.push("unbalanced parentheses");
  if (caseModes.length > 0) errors.push("unterminated case statement");
  return commands;
}

// Wrappers that run their argument as a command; the wrapped command is checked directly.

interface WrapperSpec {
  valueOptions?: ReadonlySet<string>;
  positionals?: number;
  assignments?: boolean;
}

const WRAPPERS: ReadonlyMap<string, WrapperSpec> = new Map<string, WrapperSpec>([
  ["builtin", {}],
  ["caffeinate", { valueOptions: new Set(["-t", "-w"]) }],
  ["chronic", {}],
  ["command", {}],
  ["doas", { valueOptions: new Set(["-C", "-u"]) }],
  ["env", { valueOptions: new Set(["-C", "-u", "--chdir", "--unset"]), assignments: true }],
  ["exec", { valueOptions: new Set(["-a"]) }],
  [
    "ionice",
    {
      valueOptions: new Set([
        "-c",
        "-n",
        "-p",
        "-P",
        "-u",
        "--class",
        "--classdata",
        "--pid",
        "--pgid",
        "--uid",
      ]),
    },
  ],
  ["nice", { valueOptions: new Set(["-n", "--adjustment"]) }],
  ["nohup", {}],
  ["setsid", {}],
  ["stdbuf", { valueOptions: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]) }],
  [
    "sudo",
    {
      valueOptions: new Set([
        "-C",
        "-D",
        "-g",
        "-h",
        "-p",
        "-r",
        "-t",
        "-T",
        "-u",
        "-U",
        "--chdir",
        "--close-from",
        "--command-timeout",
        "--group",
        "--host",
        "--other-user",
        "--prompt",
        "--role",
        "--type",
        "--user",
      ]),
      assignments: true,
    },
  ],
  ["time", { valueOptions: new Set(["-f", "-o", "--format", "--output"]) }],
  ["timeout", { valueOptions: new Set(["-k", "-s", "--kill-after", "--signal"]), positionals: 1 }],
  ["unbuffer", {}],
  [
    "xargs",
    {
      valueOptions: new Set([
        "-a",
        "-d",
        "-E",
        "-I",
        "-L",
        "-n",
        "-P",
        "-s",
        "--arg-file",
        "--delimiter",
        "--eof",
        "--max-args",
        "--max-chars",
        "--max-lines",
        "--max-procs",
        "--process-slot-var",
      ]),
    },
  ],
]);
const WATCH: WrapperSpec = { valueOptions: new Set(["-n", "--interval"]) };

/** Index of the first word after a wrapper's options, or undefined when nothing follows. */
function skipWrapperOptions(words: string[], index: number, spec: WrapperSpec): number | undefined {
  let positionals = spec.positionals ?? 0;
  while (index < words.length) {
    const word = words[index];
    if (spec.assignments && ASSIGNMENT.test(word)) {
      index++;
    } else if (word === "--") {
      index++;
      break;
    } else if (word.startsWith("--") && word.length > 2) {
      const name = word.split("=", 1)[0];
      index += spec.valueOptions?.has(name) && !word.includes("=") ? 2 : 1;
    } else if (word.startsWith("-") && word.length > 1) {
      // A flag cluster may end with an option that takes the next word (`sudo -Eu root`).
      const last = word[word.length - 1];
      const takesValue =
        spec.valueOptions?.has(word) ||
        (word.length > 2 && /[A-Za-z]/.test(last) && spec.valueOptions?.has(`-${last}`));
      index += takesValue ? 2 : 1;
    } else if (positionals > 0) {
      positionals--;
      index++;
    } else {
      break;
    }
  }
  return index < words.length ? index : undefined;
}

function envSplitsString(words: string[], index: number): boolean {
  for (; index < words.length; index++) {
    const word = words[index];
    if (ASSIGNMENT.test(word)) continue;
    if (word === "--" || !word.startsWith("-")) return false;
    if (word.startsWith("--split-string") || (!word.startsWith("--") && word.includes("S"))) {
      return true;
    }
  }
  return false;
}

/** Index of the effective command word once assignments and wrappers are skipped. */
function resolveWrappers(words: string[]): number | undefined {
  let index = 0;
  while (index < words.length) {
    while (index < words.length && ASSIGNMENT.test(words[index])) index++;
    if (index >= words.length) return;
    const name = basename(words[index]);
    const spec = WRAPPERS.get(name);
    if (!spec || (name === "env" && envSplitsString(words, index + 1))) return index;
    const next = skipWrapperOptions(words, index + 1, spec);
    if (next === undefined) return;
    index = next;
  }
}

// Nested command text

const SHELLS = new Set(["ash", "bash", "dash", "fish", "ksh", "mksh", "sh", "zsh"]);
const SHELL_OPTIONS_WITH_VALUE = new Set(["-o", "+o", "-O", "+O", "--init-file", "--rcfile"]);
const EXEC_PRIMARIES = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
/** Commands that forward standard input unchanged, so a heredoc reaches the next pipe stage. */
const PASS_THROUGH_CONSUMERS = new Set(["cat", "tee"]);
/** Commands that treat standard input as data rather than as code. */
const DATA_CONSUMERS = new Set([
  "awk",
  "base64",
  "bat",
  "bzip2",
  "cat",
  "cmp",
  "column",
  "comm",
  "cut",
  "dd",
  "diff",
  "egrep",
  "expand",
  "fgrep",
  "file",
  "fmt",
  "fold",
  "gawk",
  "gh",
  "git",
  "gpg",
  "grep",
  "gunzip",
  "gzip",
  "head",
  "hexdump",
  "iconv",
  "jq",
  "join",
  "less",
  "mapfile",
  "md5",
  "md5sum",
  "more",
  "nl",
  "od",
  "openssl",
  "paste",
  "patch",
  "pbcopy",
  "read",
  "readarray",
  "rev",
  "rg",
  "sed",
  "sha1sum",
  "sha256sum",
  "shasum",
  "sort",
  "sponge",
  "strings",
  "tac",
  "tail",
  "tar",
  "tee",
  "tr",
  "uniq",
  "unexpand",
  "unzip",
  "wc",
  "xclip",
  "xsel",
  "xxd",
  "xz",
  "yq",
  "zip",
  "zstd",
]);

function isPipe(operator: Operator | undefined): boolean {
  return operator === "|" || operator === "|&";
}

function routeStandardInput(
  commands: SimpleCommand[],
  index: number,
  kind: string,
  text: string,
  literal: boolean,
  unclassified: string[],
): void {
  let cursor = index;
  while (
    commands[cursor].name !== undefined &&
    PASS_THROUGH_CONSUMERS.has(commands[cursor].name as string) &&
    isPipe(commands[cursor].terminator) &&
    cursor + 1 < commands.length
  ) {
    cursor++;
  }
  const consumer = commands[cursor];
  const name = consumer.name;
  if (name !== undefined && (SHELLS.has(name) || name === "eval")) {
    consumer.fedByHeredoc = true;
    if (literal) consumer.bodies.push(text);
    else unclassified.push(`${kind} fed to ${name} depends on expansion`);
    return;
  }
  if (name !== undefined && DATA_CONSUMERS.has(name)) return;
  unclassified.push(`${kind} feeds ${name === undefined ? "an unresolved command" : `'${name}'`}`);
}

function routeHeredocs(commands: SimpleCommand[], unclassified: string[]): void {
  for (const [index, command] of commands.entries()) {
    for (const redirect of command.redirects) {
      if (redirect.heredoc) {
        routeStandardInput(commands, index, "heredoc", redirect.heredoc.body, true, unclassified);
      } else if (redirect.operator === "<<<" && redirect.target) {
        const { value, literal } = redirect.target;
        routeStandardInput(commands, index, "here-string", value, literal, unclassified);
      }
    }
  }
}

/** Literal `-c` text of a shell invocation; flags scripts and piped input that cannot be read. */
function shellCommandTexts(
  name: string,
  args: WordToken[],
  command: SimpleCommand,
  unclassified: string[],
): string[] {
  let commandText: WordToken | undefined;
  let script: WordToken | undefined;
  let stdinArguments = false;
  for (let index = 0; index < args.length; index++) {
    const { value } = args[index];
    if (value === "--") {
      if (!stdinArguments) script = args[index + 1];
      break;
    }
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(value) || value === "--command") {
      commandText = args[index + 1];
      break;
    }
    if (SHELL_OPTIONS_WITH_VALUE.has(value)) {
      index++;
      continue;
    }
    if (/^-[A-Za-z]*s[A-Za-z]*$/.test(value)) stdinArguments = true;
    if (value.startsWith("-") || value.startsWith("+")) continue;
    if (stdinArguments) break;
    script = args[index];
    break;
  }

  if (commandText) {
    if (commandText.literal) return [commandText.value];
    unclassified.push(`${name} -c text depends on expansion: ${commandText.raw}`);
    return [];
  }
  if (script) {
    if (!script.literal) unclassified.push(`${name} script depends on expansion: ${script.raw}`);
    return [];
  }
  if (command.afterPipe && !command.fedByHeredoc) {
    unclassified.push(`${name} reads commands from a pipe`);
  }
  return [];
}

/** Arguments joined into command text when every argument is literal. */
function literalText(name: string, args: WordToken[], unclassified: string[]): string[] {
  if (args.length === 0) return [];
  const dynamic = args.find((argument) => !argument.literal);
  if (dynamic) {
    unclassified.push(`${name} text depends on expansion: ${dynamic.raw}`);
    return [];
  }
  return [args.map((argument) => argument.value).join(" ")];
}

function envSplitStringTexts(args: WordToken[], unclassified: string[]): string[] {
  for (const [index, argument] of args.entries()) {
    const { value } = argument;
    if (ASSIGNMENT.test(value)) continue;
    if (value === "--" || !value.startsWith("-")) return [];
    let text: WordToken | undefined;
    let rest = index + 1;
    if (value.startsWith("--split-string=")) {
      text = { ...argument, value: value.slice("--split-string=".length) };
    } else if (value === "--split-string" || /^-[A-Za-z]*S$/.test(value)) {
      text = args[index + 1];
      rest = index + 2;
    } else if (!value.startsWith("--") && value.includes("S")) {
      text = { ...argument, value: value.slice(value.indexOf("S") + 1) };
    }
    if (text) return literalText("env -S", [text, ...args.slice(rest)], unclassified);
  }
  return [];
}

function execGroups(args: WordToken[]): WordToken[][] {
  const groups: WordToken[][] = [];
  for (let index = 0; index < args.length; index++) {
    if (!EXEC_PRIMARIES.has(args[index].value)) continue;
    const group: WordToken[] = [];
    for (index++; index < args.length; index++) {
      const { value } = args[index];
      if (value === ";" || value === "+") break;
      group.push(args[index]);
    }
    if (group.length > 0) groups.push(group);
  }
  return groups;
}

function redirectTargets(redirects: RedirectToken[]): string[] {
  const targets: string[] = [];
  for (const redirect of redirects) {
    if (redirect.heredoc || redirect.operator === "<<<" || !redirect.target) continue;
    const { value } = redirect.target;
    if ((redirect.operator === ">&" || redirect.operator === "<&") && /^\d*-?$/.test(value)) {
      continue;
    }
    targets.push(value);
  }
  return targets;
}

function segmentOf(command: SimpleCommand): ShellSegment {
  return {
    text: command.text,
    words: command.tokens.map((token) => token.value),
    redirectTargets: redirectTargets(command.redirects),
  };
}

function resolveCommand(command: SimpleCommand): void {
  command.commandIndex = resolveWrappers(command.tokens.map((token) => token.value));
  if (command.commandIndex !== undefined) {
    command.name = basename(command.tokens[command.commandIndex].value);
  }
}

function mergeInto(target: ShellParse, parse: ShellParse): void {
  target.segments.push(...parse.segments);
  target.unclassified.push(...parse.unclassified);
}

/** Segments nested inside one simple command: substitutions, literal command text, and input. */
function analyzeCommand(command: SimpleCommand, depth: number): ShellParse {
  const result: ShellParse = { segments: [], unclassified: [] };
  const texts: string[] = [];
  if (command.commandIndex !== undefined && command.name !== undefined) {
    const token = command.tokens[command.commandIndex];
    const name = command.name;
    const args = command.tokens.slice(command.commandIndex + 1);
    if (!token.literal) {
      result.unclassified.push(`command name depends on expansion: ${token.raw}`);
    } else if (token.expands) {
      result.unclassified.push(`command name uses shell expansion: ${token.raw}`);
    }

    if (SHELLS.has(name)) {
      texts.push(...shellCommandTexts(name, args, command, result.unclassified));
    } else if (name === "eval") {
      texts.push(...literalText(name, args, result.unclassified));
    } else if (name === "watch") {
      const start = skipWrapperOptions(
        args.map((argument) => argument.value),
        0,
        WATCH,
      );
      if (start !== undefined)
        texts.push(...literalText(name, args.slice(start), result.unclassified));
    } else if (name === "env") {
      texts.push(...envSplitStringTexts(args, result.unclassified));
    } else if (name === "find") {
      for (const group of execGroups(args)) mergeInto(result, analyzeTokens(group, depth + 1));
    } else if ((name === "source" || name === ".") && args[0] && !args[0].literal) {
      result.unclassified.push(`sourced script depends on expansion: ${args[0].raw}`);
    }
  }
  for (const text of [...command.substitutions, ...texts, ...command.bodies]) {
    mergeInto(result, parseSource(text, depth + 1));
  }
  return result;
}

/** Analyze words that form a command on their own, such as a `find -exec` group. */
function analyzeTokens(tokens: WordToken[], depth: number): ShellParse {
  const command: SimpleCommand = {
    text: tokens.map((token) => token.raw).join(" "),
    tokens,
    redirects: [],
    substitutions: [],
    afterPipe: false,
    fedByHeredoc: false,
    bodies: [],
  };
  resolveCommand(command);
  const result: ShellParse = { segments: [segmentOf(command)], unclassified: [] };
  mergeInto(result, analyzeCommand(command, depth));
  return result;
}

function parseSource(source: string, depth: number): ShellParse {
  if (depth > MAX_DEPTH) return { segments: [], unclassified: ["command nesting is too deep"] };
  const tokenizer = new Tokenizer(source).run();
  const result: ShellParse = { segments: [], unclassified: [...tokenizer.errors] };
  const stray: string[] = [];
  const commands = splitSimpleCommands(source, tokenizer.tokens, stray, result.unclassified);
  for (const command of commands) resolveCommand(command);
  routeHeredocs(commands, result.unclassified);
  for (const command of commands) {
    result.segments.push(segmentOf(command));
    mergeInto(result, analyzeCommand(command, depth));
  }
  for (const text of stray) mergeInto(result, parseSource(text, depth + 1));
  return result;
}

// Public API

/**
 * Parse the shell structure needed by deterministic safety policies.
 * This intentionally is not a complete POSIX shell parser: every command position is
 * reported, benign wrappers are resolved, literal nested text is parsed recursively, and
 * anything else is reported as unclassified.
 */
export function parseShellCommand(command: string): ShellParse {
  return parseSource(command, 0);
}

export function parseShellSegments(command: string): ShellSegment[] {
  return parseShellCommand(command).segments;
}

/** Resolve the executable and arguments after common command wrappers. */
export function shellSegmentInvocation(segment: ShellSegment): CommandInvocation | undefined {
  const index = resolveWrappers(segment.words);
  if (index === undefined) return;
  return { command: basename(segment.words[index]), args: segment.words.slice(index + 1) };
}

/** Flat top-level words with `;` standing in for every control operator. */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  for (const token of new Tokenizer(command).run().tokens) {
    if (token.kind === "operator") words.push(";");
    else if (token.kind === "redirect") {
      words.push(token.operator);
      if (token.target) words.push(token.target.value);
    } else words.push(token.value);
  }
  return words;
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

export function findCommandInvocations(
  command: string,
  commandNames: ReadonlySet<string>,
): CommandInvocation[] {
  const invocations: CommandInvocation[] = [];
  for (const segment of parseShellSegments(command)) {
    const invocation = shellSegmentInvocation(segment);
    if (invocation && commandNames.has(invocation.command)) invocations.push(invocation);
  }
  return invocations;
}

export function findGitInvocations(command: string, baseCwd: string): GitInvocation[] {
  const invocations: GitInvocation[] = [];
  for (const segment of parseShellSegments(command)) {
    const invocation = shellSegmentInvocation(segment);
    if (invocation?.command !== "git") continue;

    const { args } = invocation;
    let cwd = baseCwd;
    let cursor = 0;
    while (cursor < args.length && args[cursor].startsWith("-")) {
      const option = args[cursor];
      if (option === "-C" && args[cursor + 1]) {
        cwd = resolve(cwd, expandHome(args[cursor + 1]));
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

    if (cursor >= args.length) continue;
    invocations.push({ cwd, subcommand: args[cursor], args: args.slice(cursor + 1) });
  }
  return invocations;
}
