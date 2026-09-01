import { basename } from "node:path";
import { parseShellSegments, shellSegmentInvocation, shellWords } from "../command-parser.ts";
import { actionMutationTargets, matchesPathPattern } from "../path-policy.ts";
import { review, type GuardrailPolicy } from "../policy.ts";

export function matchesReviewCommand(command: string, pattern: string): boolean {
  const expected = shellWords(pattern).filter((word) => word !== ";");
  if (expected.length === 0) return false;
  const expectedCommand = basename(expected[0]);
  const expectedArguments = expected.slice(1);

  return parseShellSegments(command).some((segment) => {
    const invocation = shellSegmentInvocation(segment);
    if (!invocation || invocation.command !== expectedCommand) return false;
    return expectedArguments.every((argument, index) => invocation.args[index] === argument);
  });
}

function hasDynamicShellSyntax(command: string): boolean {
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (const character of command) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = undefined;
      continue;
    }
    if (character === "'" && quote === undefined) {
      quote = "'";
      continue;
    }
    if (character === '"') {
      quote = quote === '"' ? undefined : '"';
      continue;
    }
    if (character === "$" || character === "`") return true;
    if (!quote && "{}*?[]()~".includes(character)) return true;
  }

  return false;
}

function standaloneLiteralGhInvocation(
  command: string,
): { command: string; args: string[] } | undefined {
  const segments = parseShellSegments(command);
  if (segments.length !== 1) return;

  const segment = segments[0];
  if (
    segment.redirectTargets.length > 0 ||
    basename(segment.words[0] ?? "") !== "gh" ||
    /&/.test(segment.text) ||
    hasDynamicShellSyntax(segment.text)
  ) {
    return;
  }

  const invocation = shellSegmentInvocation(segment);
  return invocation?.command === "gh" ? invocation : undefined;
}

function opensBrowser(args: string[]): boolean {
  return args.some((argument) => argument.startsWith("--web") || /^-[^-]*w/.test(argument));
}

const READ_ONLY_PR_COMMANDS = new Set(["checks", "diff", "list", "status", "view"]);
const API_VALUE_OPTIONS = new Set([
  "--hostname",
  "--jq",
  "--method",
  "--preview",
  "--template",
  "-p",
  "-q",
  "-t",
  "-X",
]);
const API_BOOLEAN_OPTIONS = new Set([
  "--allow-escape-sequences",
  "--help",
  "--include",
  "--paginate",
  "--silent",
  "--slurp",
  "--verbose",
  "-i",
]);

function isReadOnlyGhApiInvocation(args: string[]): boolean {
  let endpoint: string | undefined;
  let method = "GET";

  for (let index = 1; index < args.length; index++) {
    const argument = args[index];
    const equals = argument.indexOf("=");
    const option = equals < 0 ? argument : argument.slice(0, equals);

    if (API_BOOLEAN_OPTIONS.has(option)) continue;
    if (API_VALUE_OPTIONS.has(option)) {
      const value = equals < 0 ? args[++index] : argument.slice(equals + 1);
      if (!value) return false;
      if (option === "--method" || option === "-X") method = value.toUpperCase();
      continue;
    }
    if (argument.startsWith("-X") && argument.length > 2) {
      method = argument.slice(2).toUpperCase();
      continue;
    }
    if (argument.startsWith("-")) return false;
    if (endpoint) return false;
    endpoint = argument;
  }

  return (
    endpoint !== undefined && endpoint !== "graphql" && (method === "GET" || method === "HEAD")
  );
}

export function isAutoAllowedGhPrViewCommand(command: string): boolean {
  const invocation = standaloneLiteralGhInvocation(command);
  return (
    invocation?.args[0] === "pr" &&
    invocation.args[1] === "view" &&
    !opensBrowser(invocation.args.slice(2))
  );
}

export function isAutoAllowedGhReadCommand(command: string): boolean {
  const invocation = standaloneLiteralGhInvocation(command);
  if (!invocation) return false;

  if (invocation.args[0] === "pr") {
    return (
      READ_ONLY_PR_COMMANDS.has(invocation.args[1] ?? "") && !opensBrowser(invocation.args.slice(2))
    );
  }
  return invocation.args[0] === "api" && isReadOnlyGhApiInvocation(invocation.args);
}

export const semanticReviewPolicy = {
  name: "semantic-review",
  async guidance({ config }) {
    if (!config.semanticReview.enabled) return;
    return "Semantic guardrail: selected external-effect commands and sensitive paths require an independent review; deterministic guardrails always take precedence.";
  },
  async check(action, { config, cwd }) {
    if (!config.semanticReview.enabled || action.source !== "agent") return;

    for (const target of actionMutationTargets(action.toolName, action.input, cwd)) {
      const pattern = config.semanticReview.paths.find((candidate) =>
        matchesPathPattern(target, cwd, candidate),
      );
      if (pattern) {
        return review(`Modification of '${target}' matched semantic review rule '${pattern}'.`);
      }
    }

    if (action.toolName !== "bash" || typeof action.input.command !== "string") return;
    const pattern = config.semanticReview.commands.find((candidate) =>
      matchesReviewCommand(action.input.command as string, candidate),
    );
    if (!pattern || isAutoAllowedGhReadCommand(action.input.command)) return;
    return review(`Command matched semantic review rule '${pattern}'.`);
  },
} satisfies GuardrailPolicy;
