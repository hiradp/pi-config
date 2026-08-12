import { fileURLToPath } from "node:url";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { Type, type Static } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { formatSize, truncateHead } from "@earendil-works/pi-coding-agent";

export const PORTER_MODEL = "openai-codex/gpt-5.6-luna:high";
const GUARDRAILS_PATH = fileURLToPath(new URL("../guardrails", import.meta.url));

export const PorterParams = Type.Object(
  {
    task: Type.String({
      minLength: 1,
      maxLength: 4_000,
      description:
        "The user's explicit shipping request. Preserve whether they authorized a local commit, a push, and PR creation.",
    }),
  },
  { additionalProperties: false },
);

export type PorterInput = Static<typeof PorterParams>;

export type PorterMessage = AssistantMessage | ToolResultMessage;

export interface PorterDetails {
  model: string;
  messages: PorterMessage[];
  stderr: string;
  exitCode: number;
  usage: Usage;
  stopReason?: AssistantMessage["stopReason"];
  errorMessage?: string;
}

export interface PorterRunnerOptions {
  cwd: string;
  task: string;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<PorterDetails>;
}

export type PorterRunner = (options: PorterRunnerOptions) => Promise<PorterDetails>;

const PORTER_PROMPT = `You are Porter. You package and deliver completed Git work without changing the cargo.

The delegated task below quotes the user's explicit authorization. Do not infer broader authority than it states.

Rules:
- Work only in the current repository.
- Load and follow the commit skill for commit work and the create-pr skill for PR work.
- Inventory every repository change before acting. Do not absorb unrelated or unexplained changes.
- Do not intentionally edit or write source files. If checks, hooks, formatting, or generated steps modify files, stop, report the resulting changes, and do not include them in a commit unless they were already part of the authorized cargo.
- A commit-only request is local-only: do not push or mutate GitHub.
- Push only when the user explicitly requested a push or asked to open/create a PR. A PR request authorizes the one normal push permitted by the create-pr skill.
- Create a PR only when the delegated task explicitly says the user requested one.
- Never force-push, merge, close or reopen a PR, add comments, labels, reviewers, or assignees, deploy, publish a release, switch branches, rewrite history, stash, or discard work.
- Run repository-required and proportionate checks. Never bypass hooks or checks.
- If ownership, scope, grouping, branch, base, or authorization is ambiguous, stop without mutation and explain what must be clarified.
- If a PR already exists, report it instead of creating a duplicate.
- Keep commits focused and obey repository commit-message conventions.
- Finish with a concise report of commits, PR URL and branches when applicable, checks, remaining changes, and whether a push occurred.

Delegated task:
`;

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(target: Usage, usage: Usage): void {
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.cacheWrite1h = (target.cacheWrite1h ?? 0) + (usage.cacheWrite1h ?? 0);
  target.reasoning = (target.reasoning ?? 0) + (usage.reasoning ?? 0);
  target.totalTokens += usage.totalTokens;
  target.cost.input += usage.cost.input;
  target.cost.output += usage.cost.output;
  target.cost.cacheRead += usage.cost.cacheRead;
  target.cost.cacheWrite += usage.cost.cacheWrite;
  target.cost.total += usage.cost.total;
}

export function getFinalPorterOutput(messages: readonly PorterMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;

    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

export function parsePorterEvent(line: string, details: PorterDetails): boolean {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return false;
  }

  if (typeof event !== "object" || event === null || !("type" in event)) return false;
  if ((event as { type?: unknown }).type !== "message_end" || !("message" in event)) return false;

  const message = (event as { message?: unknown }).message;
  if (typeof message !== "object" || message === null || !("role" in message)) return false;
  if (message.role !== "assistant" && message.role !== "toolResult") return false;

  const porterMessage = message as PorterMessage;
  if (porterMessage.role === "assistant" && !porterMessage.usage) return false;

  details.messages.push(porterMessage);
  if (porterMessage.role === "assistant") {
    addUsage(details.usage, porterMessage.usage);
    details.stopReason = porterMessage.stopReason;
    details.errorMessage = porterMessage.errorMessage;
  } else if (porterMessage.usage) {
    addUsage(details.usage, porterMessage.usage);
  }
  return true;
}

function porterFailure(details: PorterDetails): string | null {
  if (details.stopReason === "aborted") return "Porter was aborted.";
  if (details.stopReason === "error") {
    return (
      details.errorMessage || details.stderr.trim() || "Porter failed without an error message."
    );
  }
  if (details.exitCode !== 0) {
    return details.stderr.trim() || `Porter exited with code ${details.exitCode}.`;
  }
  return null;
}

function resultContent(details: PorterDetails): string {
  const failure = porterFailure(details);
  if (failure) return failure;
  return getFinalPorterOutput(details.messages) || "Porter finished without a final report.";
}

export function createPorterRunner(pi: Pick<ExtensionAPI, "exec">): PorterRunner {
  return async ({ cwd, task, signal, onUpdate }) => {
    const details: PorterDetails = {
      model: PORTER_MODEL,
      messages: [],
      stderr: "",
      exitCode: 0,
      usage: emptyUsage(),
    };

    const result = await pi.exec(
      "pi",
      [
        "--mode",
        "json",
        "--print",
        "--no-session",
        "--no-extensions",
        "--extension",
        GUARDRAILS_PATH,
        "--no-prompt-templates",
        "--model",
        PORTER_MODEL,
        "--tools",
        "read,bash",
        "--append-system-prompt",
        `${PORTER_PROMPT}${task}`,
        `Carry out the delegated shipping task exactly as authorized: ${task}`,
      ],
      { cwd, signal },
    );

    details.exitCode = result.code;
    details.stderr = result.stderr;
    for (const line of result.stdout.split("\n")) {
      if (!line.trim()) continue;
      if (parsePorterEvent(line, details)) {
        onUpdate?.({ content: [{ type: "text", text: resultContent(details) }], details });
      }
    }
    return details;
  };
}

function truncateResult(text: string): string {
  const truncated = truncateHead(text);
  if (!truncated.truncated) return truncated.content;
  return `${truncated.content}\n\n[Porter output truncated: ${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)} shown.]`;
}

export function createPorterTool(
  runner: PorterRunner,
): ToolDefinition<typeof PorterParams, PorterDetails> {
  return {
    name: "porter",
    label: "Porter",
    description:
      "Delegate an explicitly authorized Git shipping task to Porter in an isolated Luna/high session. Porter can inspect, check, commit, and, only when the task says the user requested it, push and open one pull request. Porter has no edit or write tools and is instructed not to alter source files. Do not call Porter merely because work appears complete.",
    promptSnippet:
      "Commit completed Git work and, only when explicitly authorized, push and open a PR",
    promptGuidelines: [
      "Use porter only after the user explicitly asks to commit, push, or open a pull request; preserve that exact authorization in porter's task.",
      "Do not use porter to implement or fix code, and do not treat task completion as authorization to publish it.",
    ],
    parameters: PorterParams,
    async execute(
      _toolCallId,
      params,
      signal,
      onUpdate,
      ctx,
    ): Promise<AgentToolResult<PorterDetails>> {
      let details: PorterDetails;
      try {
        details = await runner({ cwd: ctx.cwd, task: params.task, signal, onUpdate });
      } catch (error) {
        if (signal?.aborted) throw new Error("Porter was aborted.");
        throw error;
      }
      const failure = porterFailure(details);
      if (failure) throw new Error(failure);

      return {
        content: [{ type: "text", text: truncateResult(resultContent(details)) }],
        details,
        usage: details.usage,
      };
    },
  };
}

export function registerPorter(
  pi: ExtensionAPI,
  runner: PorterRunner = createPorterRunner(pi),
): void {
  pi.registerTool(createPorterTool(runner));
}

export default function porterExtension(pi: ExtensionAPI): void {
  registerPorter(pi);
}
