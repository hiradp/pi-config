import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseGuardrailsSettings } from "../config.ts";
import { semanticReviewPolicy } from "../policies/semantic-review.ts";

describe("repository semantic review commands", () => {
  test("reviews pi, claude, and helm invocations with the checked-in settings", async () => {
    const settings = JSON.parse(readFileSync(join(process.cwd(), "settings.json"), "utf8"));
    const result = parseGuardrailsSettings(settings, "settings.json");
    assert.equal(result.valid, true, result.diagnostics.join("\n"));
    for (const command of ["pi", "claude", "helm", "kubectl", "k", "pskube"]) {
      assert.equal(result.config.semanticReview.commands.includes(command), true, command);
    }

    const pi = {} as ExtensionAPI;
    for (const command of [
      "pi -p --no-extensions 'summarize the repo'",
      "claude -p --dangerously-skip-permissions 'delete everything'",
      "helm uninstall api --namespace production",
      "kubectl get pods",
    ]) {
      const decision = await semanticReviewPolicy.check(
        { source: "agent", toolName: "bash", input: { command } },
        { pi, cwd: process.cwd(), config: result.config, maintenance: false },
      );
      assert.equal(decision?.outcome, "review", command);
    }
    assert.equal(
      await semanticReviewPolicy.check(
        { source: "agent", toolName: "bash", input: { command: "echo pi -p" } },
        { pi, cwd: process.cwd(), config: result.config, maintenance: false },
      ),
      undefined,
    );
  });
});
