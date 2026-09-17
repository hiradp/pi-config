import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

const RECENT_TOOLS = 5;
const PREVIEW_CHARACTERS = 4096;
const PREVIEW_LINES = 6;

export type ProgressPhase =
  | "starting"
  | "waiting"
  | "receiving"
  | "tools"
  | "compacting"
  | "retrying"
  | "finishing";

export interface ToolActivity {
  id: string;
  description: string;
  startedAt: number;
  finishedAt?: number;
  isError?: boolean;
  output: string;
}

export interface ChildProgress {
  phase: ProgressPhase;
  phaseStartedAt: number;
  lastEventAt?: number;
  activeToolCount: number;
  activeTools: ToolActivity[];
  recentTools: ToolActivity[];
  assistantText: string;
}

/** Preview only: final messages and usage remain authoritative elsewhere. */
export function previewTail(text: string): string {
  return text
    .slice(-PREVIEW_CHARACTERS)
    .replace(/^[\uDC00-\uDFFF]/u, "")
    .split("\n")
    .slice(-PREVIEW_LINES)
    .join("\n");
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") {
      text = previewTail(text + (text ? "\n" : "") + part.text);
    }
  }
  return text;
}

export class ChildProgressTracker {
  private phase: ProgressPhase = "starting";
  private phaseStartedAt: number;
  private lastEventAt?: number;
  private active = new Map<string, ToolActivity>();
  private recent: ToolActivity[] = [];
  private assistantText = "";
  private messageText = "";
  private describeTool: (name: string, args: Record<string, unknown>) => string;

  constructor(
    startedAt: number,
    describeTool: (name: string, args: Record<string, unknown>) => string,
  ) {
    this.phaseStartedAt = startedAt;
    this.describeTool = describeTool;
  }

  private setPhase(phase: ProgressPhase, now: number) {
    if (this.phase === phase) return;
    this.phase = phase;
    this.phaseStartedAt = now;
  }

  record(event: JsonAgentSessionEvent, now = Date.now()): void {
    this.lastEventAt = now;
    switch (event.type) {
      case "agent_start":
      case "turn_start":
        this.setPhase("waiting", now);
        break;
      case "message_start":
        if (event.message.role === "assistant") {
          this.messageText = "";
          this.setPhase("waiting", now);
        }
        break;
      case "message_update": {
        this.setPhase("receiving", now);
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta") {
          this.messageText = previewTail(this.messageText + update.delta);
          this.assistantText = this.messageText;
        }
        break;
      }
      case "message_end":
        if (event.message.role === "assistant") {
          const text = contentText(event.message.content);
          if (text) this.assistantText = text;
          this.setPhase(event.message.stopReason === "stop" ? "finishing" : "waiting", now);
        }
        break;
      case "tool_execution_start": {
        if (!this.active.has(event.toolCallId)) {
          this.active.set(event.toolCallId, {
            id: event.toolCallId,
            description: this.describeTool(event.toolName, event.args ?? {}).slice(
              0,
              PREVIEW_CHARACTERS,
            ),
            startedAt: now,
            output: "",
          });
        }
        this.setPhase("tools", now);
        break;
      }
      case "tool_execution_update": {
        const tool = this.active.get(event.toolCallId);
        // Pi partial results are cumulative snapshots, not output deltas.
        if (tool) tool.output = contentText(event.partialResult?.content);
        break;
      }
      case "tool_execution_end": {
        const tool = this.active.get(event.toolCallId);
        if (tool) {
          this.active.delete(event.toolCallId);
          this.recent.push({
            ...tool,
            finishedAt: now,
            isError: event.isError,
            output: contentText(event.result?.content) || tool.output,
          });
          this.recent = this.recent.slice(-RECENT_TOOLS);
        }
        if (this.active.size === 0) this.setPhase("waiting", now);
        break;
      }
      case "compaction_start":
        this.setPhase("compacting", now);
        break;
      case "auto_retry_start":
        this.setPhase("retrying", now);
        break;
      case "compaction_end":
      case "auto_retry_end":
        this.setPhase("waiting", now);
        break;
      case "agent_end":
        if (!event.willRetry) this.setPhase("finishing", now);
        break;
    }
  }

  snapshot(): ChildProgress {
    const active = [...this.active.values()];
    return {
      phase: this.phase,
      phaseStartedAt: this.phaseStartedAt,
      lastEventAt: this.lastEventAt,
      activeToolCount: active.length,
      activeTools: active.slice(0, RECENT_TOOLS).map((tool) => ({ ...tool })),
      recentTools: this.recent.map((tool) => ({ ...tool })),
      assistantText: this.assistantText,
    };
  }
}
