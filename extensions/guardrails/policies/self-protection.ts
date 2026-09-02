import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeActionMutations,
  isInside,
  resolvePathForPolicy,
  samePath,
  type MutationTarget,
} from "../path-policy.ts";
import { block, confirm, type GuardrailPolicy } from "../policy.ts";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function protectedLocations(): Array<{ path: string; directory: boolean }> {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return [
    { path: join(agentDir, "settings.json"), directory: false },
    { path: extensionRoot, directory: true },
  ].map((entry) => ({
    ...entry,
    path: resolvePathForPolicy(entry.path) ?? resolve(entry.path),
  }));
}

function protectedTarget(target: MutationTarget): string | undefined {
  const path = resolvePathForPolicy(target.path) ?? resolve(target.path);
  for (const location of protectedLocations()) {
    if (samePath(path, location.path) || (location.directory && isInside(path, location.path))) {
      return location.path;
    }
    // Deleting, moving, or rewriting an ancestor takes the protected location with it.
    if (target.recursive && isInside(location.path, path)) return location.path;
  }
}

export const selfProtectionPolicy = {
  name: "self-protection",
  async guidance({ maintenance }) {
    if (maintenance) return "Guardrail maintenance mode is active for this session.";
    return "Guardrail safety controls are protected from modification. Do not edit Pi guardrail settings or extension sources.";
  },
  async check(action, { cwd, maintenance }) {
    if (maintenance) return;
    const analysis = analyzeActionMutations(action.toolName, action.input, cwd);
    for (const target of analysis.targets) {
      const protectedPath = protectedTarget(target);
      if (protectedPath) {
        return block(`Blocked modification of guardrail safety controls at '${protectedPath}'.`);
      }
    }
    if (analysis.unresolved.length > 0) {
      return confirm(
        `Cannot confirm that '${analysis.unresolved[0]}' leaves guardrail safety controls untouched because the command changes directory to a non-literal path.`,
      );
    }
  },
} satisfies GuardrailPolicy;
