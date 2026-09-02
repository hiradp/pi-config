import { analyzeActionMutations, matchesPathPattern } from "../path-policy.ts";
import { block, confirm, type GuardrailPolicy } from "../policy.ts";

export const pathsPolicy = {
  name: "paths",
  async guidance({ config }) {
    const parts: string[] = [];
    if (config.paths.blocked.length > 0) {
      parts.push(`never modify paths matching: ${config.paths.blocked.join(", ")}`);
    }
    if (config.paths.confirm.length > 0) {
      parts.push(`ask before modifying paths matching: ${config.paths.confirm.join(", ")}`);
    }
    return parts.length > 0 ? `Path guardrail: ${parts.join("; ")}.` : undefined;
  },
  async check(action, { config, cwd }) {
    const analysis = analyzeActionMutations(action.toolName, action.input, cwd);
    for (const { path: target } of analysis.targets) {
      const blockedPattern = config.paths.blocked.find((pattern) =>
        matchesPathPattern(target, cwd, pattern),
      );
      if (blockedPattern) {
        return block(`Blocked modification of '${target}' by path rule '${blockedPattern}'.`);
      }
      const confirmPattern = config.paths.confirm.find((pattern) =>
        matchesPathPattern(target, cwd, pattern),
      );
      if (confirmPattern) {
        return confirm(
          `Modification of '${target}' matched confirmation rule '${confirmPattern}'.`,
        );
      }
    }
    if (analysis.unresolved.length > 0) {
      return confirm(
        `Cannot resolve '${analysis.unresolved[0]}' because the command changes directory to a non-literal path.`,
      );
    }
  },
} satisfies GuardrailPolicy;
