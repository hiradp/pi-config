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

export function isAutoAllowedGhPrViewCommand(command: string): boolean {
  const segments = parseShellSegments(command);
  if (segments.length !== 1) return false;

  const segment = segments[0];
  if (
    segment.redirectTargets.length > 0 ||
    basename(segment.words[0] ?? "") !== "gh" ||
    /&/.test(segment.text) ||
    hasDynamicShellSyntax(segment.text)
  ) {
    return false;
  }

  const invocation = shellSegmentInvocation(segment);
  if (
    !invocation ||
    invocation.command !== "gh" ||
    invocation.args[0] !== "pr" ||
    invocation.args[1] !== "view"
  ) {
    return false;
  }

  return !invocation.args
    .slice(2)
    .some((argument) => argument.startsWith("--web") || /^-[^-]*w/.test(argument));
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
    if (!pattern || isAutoAllowedGhPrViewCommand(action.input.command)) return;
    return review(`Command matched semantic review rule '${pattern}'.`);
  },
} satisfies GuardrailPolicy;
