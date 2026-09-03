import { uuidv7, type AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  buildClassificationEvidence,
  CATEGORY_MARKERS,
  CLASSIFIER_SYSTEM_PROMPT,
  fallbackClassification,
  formatSessionName,
  parseCategory,
  parseClassification,
  sessionUserRequests,
  titleFromSessionName,
  type SessionCategory,
  type SessionClassification,
} from "./classifier.ts";

const AUTO_NAME_ENTRY = "session-naming:auto";
const CATEGORY_ENTRY = "session-naming:category";
const CLASSIFIER_PROVIDER = "openai-codex";
const CLASSIFIER_MODEL = "gpt-5.6-luna";
const AUTO_NAME_AFTER_USER_MESSAGES = 2;
const CLASSIFIER_TIMEOUT_MS = 10_000;

interface GeneratedClassification {
  classification: SessionClassification;
  model?: string;
  cost?: number;
  fallback: boolean;
}

function responseText(response: AssistantMessage): string {
  return response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

async function generateClassification(
  ctx: ExtensionContext,
  requests: readonly string[],
  sessionSignal: AbortSignal,
): Promise<GeneratedClassification | undefined> {
  const fallback = (): GeneratedClassification => ({
    classification: fallbackClassification(requests),
    fallback: true,
  });
  const model = ctx.modelRegistry.find(CLASSIFIER_PROVIDER, CLASSIFIER_MODEL);
  if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return fallback();

  const timeoutSignal = AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS);
  const signal = AbortSignal.any([sessionSignal, timeoutSignal]);
  let response: AssistantMessage;
  try {
    response = await ctx.modelRegistry.complete(
      model,
      {
        systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: buildClassificationEvidence(requests) }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        signal,
        maxTokens: 200,
        reasoningEffort: "low",
        cacheRetention: "none",
        sessionId: uuidv7(),
      },
    );
  } catch {
    return sessionSignal.aborted ? undefined : fallback();
  }

  if (sessionSignal.aborted) return undefined;
  if (response.stopReason === "aborted" || response.stopReason === "error") return fallback();

  try {
    return {
      classification: parseClassification(responseText(response)),
      model: `${model.provider}/${model.id}`,
      cost: response.usage.cost.total,
      fallback: false,
    };
  } catch {
    return fallback();
  }
}

function categoryOptions(): Array<{ category: SessionCategory; label: string }> {
  return [
    { category: "project", label: `${CATEGORY_MARKERS.project} Project` },
    { category: "production", label: `${CATEGORY_MARKERS.production} Production` },
    { category: "exploration", label: `${CATEGORY_MARKERS.exploration} Exploration` },
  ];
}

export default function (pi: ExtensionAPI) {
  let attempted = false;
  let running = false;
  let sessionAbort = new AbortController();

  pi.on("session_start", (_event, ctx) => {
    sessionAbort = new AbortController();
    running = false;
    attempted =
      Boolean(pi.getSessionName()) ||
      ctx.sessionManager
        .getEntries()
        .some((entry) => entry.type === "custom" && entry.customType === AUTO_NAME_ENTRY);
  });

  pi.on("session_shutdown", () => sessionAbort.abort());

  const applyGeneratedName = async (
    ctx: ExtensionContext,
    options: { force: boolean; notify: boolean },
  ): Promise<boolean> => {
    if (running) {
      if (options.notify && ctx.hasUI) ctx.ui.notify("Session naming is already running.", "info");
      return false;
    }

    const requests = sessionUserRequests(ctx.sessionManager.getBranch());
    if (requests.length === 0) {
      if (options.notify && ctx.hasUI) ctx.ui.notify("No user requests to name yet.", "warning");
      return false;
    }
    if (!options.force && requests.length < AUTO_NAME_AFTER_USER_MESSAGES) return false;
    if (!options.force && (attempted || pi.getSessionName())) return false;

    attempted = true;
    running = true;
    try {
      const generated = await generateClassification(ctx, requests, sessionAbort.signal);
      if (!generated || sessionAbort.signal.aborted) return false;
      if (!options.force && pi.getSessionName()) return false;

      const name = formatSessionName(generated.classification);
      pi.setSessionName(name);
      pi.appendEntry(AUTO_NAME_ENTRY, {
        version: 1,
        ...generated.classification,
        name,
        generatedAtUserMessage: requests.length,
        generatedAt: new Date().toISOString(),
        model: generated.model,
        cost: generated.cost,
        fallback: generated.fallback,
      });
      if (ctx.hasUI) ctx.ui.notify(`Session named ${name}`, "info");
      return true;
    } finally {
      running = false;
    }
  };

  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.mode !== "tui" || !ctx.sessionManager.getSessionFile()) return;
    await applyGeneratedName(ctx, { force: false, notify: false });
  });

  pi.registerCommand("rename-auto", {
    description: "Regenerate the current session name and category",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      await applyGeneratedName(ctx, { force: true, notify: true });
    },
  });

  pi.registerCommand("category", {
    description: "Set the current session category",
    getArgumentCompletions: (prefix) => {
      const values = ["project", "production", "exploration"].filter((value) =>
        value.startsWith(prefix.trim().toLowerCase()),
      );
      return values.length > 0 ? values.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();

      let category = parseCategory(args);
      if (!category && !args.trim() && ctx.hasUI) {
        const options = categoryOptions();
        const selected = await ctx.ui.select(
          "Session category",
          options.map((option) => option.label),
        );
        category = options.find((option) => option.label === selected)?.category;
        if (!category) return;
      }
      if (!category) {
        if (ctx.hasUI) {
          ctx.ui.notify("Choose project, production, or exploration.", "warning");
        }
        return;
      }

      const currentName = pi.getSessionName();
      const title = currentName ? titleFromSessionName(currentName) : "";
      if (!title) {
        if (ctx.hasUI) ctx.ui.notify("Name the session before assigning a category.", "warning");
        return;
      }

      attempted = true;
      const name = formatSessionName({ title, category });
      pi.setSessionName(name);
      pi.appendEntry(CATEGORY_ENTRY, {
        version: 1,
        category,
        name,
        changedAt: new Date().toISOString(),
      });
      if (ctx.hasUI) ctx.ui.notify(`Session renamed ${name}`, "info");
    },
  });
}
