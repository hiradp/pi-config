/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "...", label?: "...", model?: "provider/model" }
 *   - Parallel: { tasks: [{ agent: "name", task: "...", label?: "...", model?: "provider/model" }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ...", label?: "...", model?: "provider/model" }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message, Usage } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  getAgentDir,
  getMarkdownTheme,
  keyText,
  type Theme,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Markdown,
  Spacer,
  stripTerminalSequences,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { SHIMMER_INTERVAL_MS, shimmerText } from "../ui/shimmer.ts";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const MODEL_VISIBLE_OUTPUT_CAP = 50 * 1024;
const MODEL_VISIBLE_OUTPUT_LINES = 2000;
const KILL_GRACE_MS = 5000;

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage: StoredUsageStats, model?: string): string {
  const parts: string[] = [];
  const normalized = normalizeUsageStats(usage);
  const total = normalized.total;
  if (normalized.turns) parts.push(`${normalized.turns} turn${normalized.turns > 1 ? "s" : ""}`);
  if (total.input) parts.push(`↑${formatTokens(total.input)}`);
  if (total.output) parts.push(`↓${formatTokens(total.output)}`);
  if (total.cacheRead) parts.push(`R${formatTokens(total.cacheRead)}`);
  if (total.cacheWrite) parts.push(`W${formatTokens(total.cacheWrite)}`);
  if (total.cost.total) parts.push(`$${total.cost.total.toFixed(4)}`);
  if (normalized.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(normalized.contextTokens)}`);
  }
  if (model) parts.push(model);
  return parts.join(" ");
}

function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: any, text: string) => string,
): string {
  const shortenPath = (value: string) => {
    const p = singleLine(value);
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  switch (toolName) {
    case "bash": {
      const command = singleLine((args.command as string) || "...");
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
    }
    case "read": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let text = themeFg("accent", filePath);
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
      }
      return themeFg("muted", "read ") + text;
    }
    case "write": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const content = (args.content || "") as string;
      const lines = content.split("\n").length;
      let text = themeFg("muted", "write ") + themeFg("accent", filePath);
      if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
      return text;
    }
    case "edit": {
      const rawPath = (args.file_path || args.path || "...") as string;
      return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
    }
    case "ls": {
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
    }
    case "find": {
      const pattern = singleLine((args.pattern || "*") as string);
      const rawPath = (args.path || ".") as string;
      return (
        themeFg("muted", "find ") +
        themeFg("accent", pattern) +
        themeFg("dim", ` in ${shortenPath(rawPath)}`)
      );
    }
    case "grep": {
      const pattern = singleLine((args.pattern || "") as string);
      const rawPath = (args.path || ".") as string;
      return (
        themeFg("muted", "grep ") +
        themeFg("accent", `/${pattern}/`) +
        themeFg("dim", ` in ${shortenPath(rawPath)}`)
      );
    }
    default: {
      const argsStr = singleLine(JSON.stringify(args));
      const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return themeFg("accent", singleLine(toolName)) + themeFg("dim", ` ${preview}`);
    }
  }
}

interface UsageStats {
  total: Usage;
  contextTokens: number;
  turns: number;
}

interface LegacyUsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

type StoredUsageStats = UsageStats | LegacyUsageStats;

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

function addUsage(total: Usage, usage: Usage): void {
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
  total.totalTokens += usage.totalTokens;
  total.cost.input += usage.cost.input;
  total.cost.output += usage.cost.output;
  total.cost.cacheRead += usage.cost.cacheRead;
  total.cost.cacheWrite += usage.cost.cacheWrite;
  total.cost.total += usage.cost.total;
  if (usage.cacheWrite1h !== undefined) {
    total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
  }
  if (usage.reasoning !== undefined) {
    total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
  }
}

export function combineUsage(usages: Iterable<Usage>): Usage {
  const total = emptyUsage();
  for (const usage of usages) addUsage(total, usage);
  return total;
}

function createUsageStats(): UsageStats {
  return { total: emptyUsage(), contextTokens: 0, turns: 0 };
}

function normalizeUsageStats(usage: StoredUsageStats): UsageStats {
  if ("total" in usage) return usage;
  return {
    total: {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
    },
    contextTokens: usage.contextTokens,
    turns: usage.turns,
  };
}

function combineUsageStats(results: SingleResult[]): UsageStats {
  const usages = results.map((result) => normalizeUsageStats(result.usage));
  return {
    total: combineUsage(usages.map((usage) => usage.total)),
    contextTokens: 0,
    turns: usages.reduce((total, usage) => total + usage.turns, 0),
  };
}

type SubagentStatus = "queued" | "running" | "completed" | "failed";

interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  label?: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
  startedAt?: number;
  completedAt?: number;
}

interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
}

function isFailureState(exitCode: unknown, stopReason: unknown): boolean {
  return (
    (typeof exitCode === "number" && exitCode !== -1 && exitCode !== 0) ||
    stopReason === "error" ||
    stopReason === "aborted" ||
    stopReason === "length"
  );
}

export function hasFailedSubagentResult(details: unknown): boolean {
  if (!details || typeof details !== "object") return false;
  const results = (details as { results?: unknown }).results;
  if (!Array.isArray(results)) return false;

  return results.some((value) => {
    if (!value || typeof value !== "object") return false;
    const result = value as { exitCode?: unknown; stopReason?: unknown };
    return isFailureState(result.exitCode, result.stopReason);
  });
}

export function classifyChildExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  wasAborted: boolean,
): { exitCode: number; stopReason?: "aborted"; errorMessage?: string } {
  if (wasAborted) {
    return {
      exitCode: code ?? 1,
      stopReason: "aborted",
      errorMessage: `Subagent was aborted${signal ? ` (${signal})` : ""}`,
    };
  }
  if (code === null) {
    return {
      exitCode: 1,
      errorMessage: signal
        ? `Subagent terminated by signal ${signal}`
        : "Subagent exited without an exit code",
    };
  }
  return { exitCode: code };
}

export function signalProcessTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    const args = ["/pid", String(pid), "/t"];
    if (signal === "SIGKILL") args.push("/f");
    const killer = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
    killer.unref();
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    try {
      process.kill(pid, signal);
    } catch (fallbackError) {
      if ((fallbackError as NodeJS.ErrnoException).code !== "ESRCH") throw fallbackError;
    }
  }
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

export function resultStatus(result: SingleResult): SubagentStatus {
  if (result.exitCode === -1) {
    return result.startedAt !== undefined || result.messages.length > 0 ? "running" : "queued";
  }
  return isFailureState(result.exitCode, result.stopReason) ? "failed" : "completed";
}

function isFailedResult(result: SingleResult): boolean {
  return resultStatus(result) === "failed";
}

export function formatParallelProgress(results: SingleResult[]): string {
  const statuses = results.map(resultStatus);
  const done = statuses.filter((status) => status === "completed" || status === "failed").length;
  const running = statuses.filter((status) => status === "running").length;
  const queued = statuses.filter((status) => status === "queued").length;
  const parts = [`Parallel: ${done}/${results.length} done`];
  if (running > 0) parts.push(`${running} running`);
  if (queued > 0) parts.push(`${queued} queued`);
  return `${parts.join(", ")}...`;
}

function getResultOutput(result: SingleResult): string {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
  }
  return getFinalOutput(result.messages) || "(no output)";
}

export function truncateOutput(
  output: string,
  maxBytes = MODEL_VISIBLE_OUTPUT_CAP,
  maxLines = MODEL_VISIBLE_OUTPUT_LINES,
): string {
  const byteLength = Buffer.byteLength(output, "utf8");
  const lines = output.split("\n");
  const omittedLines = Math.max(0, lines.length - maxLines);
  let truncated = omittedLines > 0 ? lines.slice(0, maxLines).join("\n") : output;

  if (omittedLines === 0 && byteLength <= maxBytes) return output;

  const contentBudget = Math.max(0, maxBytes - 200);
  while (Buffer.byteLength(truncated, "utf8") > contentBudget) {
    truncated = truncated.slice(0, -1);
  }

  let result = "";
  do {
    const omittedBytes = byteLength - Buffer.byteLength(truncated, "utf8");
    const omitted = [
      omittedBytes > 0 ? `${omittedBytes} bytes` : "",
      omittedLines > 0 ? `${omittedLines} lines` : "",
    ]
      .filter(Boolean)
      .join(" and ");
    result = `${truncated}\n\n[Output truncated: ${omitted} omitted. Full output preserved in tool details.]`;
    if (Buffer.byteLength(result, "utf8") > maxBytes) truncated = truncated.slice(0, -1);
  } while (Buffer.byteLength(result, "utf8") > maxBytes);

  return result;
}

type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") items.push({ type: "text", text: part.text });
        else if (part.type === "toolCall")
          items.push({ type: "toolCall", name: part.name, args: part.arguments });
      }
    }
  }
  return items;
}

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${(minutes % 60).toString().padStart(2, "0")}m`;
}

export function sanitizeDashboardText(text: string): string {
  let result = "";

  const consumeControlString = (start: number): number => {
    for (let index = start; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code === 0x07 || code === 0x9c) return index;
      if (code === 0x1b && text.charCodeAt(index + 1) === 0x5c) return index + 1;
    }
    return text.length - 1;
  };

  const consumeCsi = (start: number): number => {
    for (let index = start; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return index;
    }
    return text.length - 1;
  };

  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 0x1b) {
      const next = text.charCodeAt(index + 1);
      if (next === 0x5b) index = consumeCsi(index + 2);
      else if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f)
        index = consumeControlString(index + 2);
      else if (next >= 0x20 && next <= 0x2f) {
        index++;
        while (index + 1 < text.length) {
          const following = text.charCodeAt(index + 1);
          index++;
          if (following >= 0x30 && following <= 0x7e) break;
        }
      } else if (index + 1 < text.length) index++;
      continue;
    }
    if (code === 0x9b) {
      index = consumeCsi(index + 1);
      continue;
    }
    if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
      index = consumeControlString(index + 1);
      continue;
    }
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      if (code >= 0x09 && code <= 0x0d) result += " ";
      continue;
    }
    result += text[index];
  }

  return stripTerminalSequences(result);
}

function singleLine(text: string): string {
  return sanitizeDashboardText(text).replace(/\s+/g, " ").trim();
}

function modelName(model: string | undefined): string | undefined {
  const name = model?.split("/").filter(Boolean).at(-1);
  return name ? singleLine(name) : undefined;
}

function resultStats(result: SingleResult, status: SubagentStatus, now: number): string {
  const model = modelName(result.model);
  if (status === "queued") return ["queued", model].filter(Boolean).join(" · ");

  const parts: string[] = [];
  if (status === "completed") parts.push("done");
  if (status === "failed") parts.push("failed");
  if (result.startedAt !== undefined) {
    parts.push(formatElapsed((result.completedAt ?? now) - result.startedAt));
  }

  const usage = normalizeUsageStats(result.usage);
  if (usage.turns > 0) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  if (usage.total.output > 0) parts.push(`↓${formatTokens(usage.total.output)}`);
  parts.push(`$${usage.total.cost.total.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" · ");
}

function fitColumns(left: string, right: string, width: number): string {
  if (!right) return truncateToWidth(left, width, "…");
  const rightWidth = visibleWidth(right);
  if (rightWidth >= width - 12) return truncateToWidth(left, width, "…");

  const leftWidth = width - rightWidth - 1;
  const fittedLeft = truncateToWidth(left, leftWidth, "…");
  const padding = Math.max(1, width - visibleWidth(fittedLeft) - rightWidth);
  return fittedLeft + " ".repeat(padding) + right;
}

function latestDisplayItem(messages: Message[]): DisplayItem | undefined {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex];
    if (message.role !== "assistant") continue;
    for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex--) {
      const part = message.content[partIndex];
      if (part.type === "text") return { type: "text", text: part.text };
      if (part.type === "toolCall") {
        return { type: "toolCall", name: part.name, args: part.arguments };
      }
    }
  }
  return undefined;
}

function latestActivity(result: SingleResult, status: SubagentStatus, theme: Theme): string {
  if (status === "queued") return theme.fg("dim", "waiting");
  if (status === "completed") return theme.fg("success", "complete");
  if (status === "failed") {
    const error = singleLine(result.errorMessage || result.stderr || result.stopReason || "failed");
    return theme.fg("error", error);
  }

  const latest = latestDisplayItem(result.messages);
  if (!latest) return theme.fg("dim", "starting…");
  if (latest.type === "toolCall") {
    return formatToolCall(latest.name, latest.args, theme.fg.bind(theme));
  }
  return theme.fg("muted", "writing response…");
}

function responsibilityLabel(result: SingleResult): string {
  const task = result.task.replace(/\{previous\}/g, "[previous output]");
  return singleLine(result.label || task) || singleLine(result.agent);
}

function addFailureDiagnostic(container: Container, result: SingleResult, theme: Theme): void {
  if (!isFailedResult(result)) return;
  const diagnostic = result.errorMessage || result.stderr || result.stopReason;
  if (diagnostic) {
    container.addChild(new Text(theme.fg("error", `Error: ${singleLine(diagnostic)}`), 0, 0));
  }
}

class SubagentDashboard implements Component {
  private details: SubagentDetails;
  private active: boolean;
  private theme: Theme;

  constructor(details: SubagentDetails, active: boolean, theme: Theme) {
    this.details = details;
    this.active = active;
    this.theme = theme;
  }

  update(details: SubagentDetails, active: boolean, theme: Theme): void {
    this.details = details;
    this.active = active;
    this.theme = theme;
  }

  render(width: number): string[] {
    const now = Date.now();
    const statuses = this.details.results.map(resultStatus);
    const completed = statuses.filter((status) => status === "completed").length;
    const failed = statuses.filter((status) => status === "failed").length;
    const running = statuses.filter((status) => status === "running").length;
    const queued = statuses.filter((status) => status === "queued").length;
    const finished = completed + failed;
    const total = statuses.length;
    const icon = failed > 0 ? this.theme.fg("error", "×") : this.theme.fg("success", "✓");

    const summary: string[] = [];
    if (this.active) {
      summary.push(`${finished}/${total} finished`);
      if (running > 0) summary.push(`${running} running`);
      if (queued > 0) summary.push(`${queued} queued`);
    } else {
      summary.push(`${completed}/${total} complete`);
      if (failed > 0) summary.push(`${failed} failed`);
      if (queued > 0) summary.push(`${queued} not run`);
    }

    const title = this.details.mode === "single" ? "Subagent" : "Subagents";
    const heading = this.theme.fg("toolTitle", this.theme.bold(title));
    const lines = [
      truncateToWidth(
        `${this.active ? heading : `${icon} ${heading}`} ${this.theme.fg("accent", summary.join(" · "))}`,
        width,
        "…",
      ),
    ];
    const shimmerTick = Math.floor(now / SHIMMER_INTERVAL_MS);

    for (let index = 0; index < this.details.results.length; index++) {
      const result = this.details.results[index];
      const status = statuses[index];
      const statusIcon =
        status === "completed"
          ? this.theme.fg("success", "✓")
          : status === "failed"
            ? this.theme.fg("error", "×")
            : status === "queued"
              ? this.theme.fg("dim", "–")
              : " ";
      const rawLabel = `${responsibilityLabel(result)}${status === "running" ? "…" : ""}`;
      const fittedLabel = truncateToWidth(rawLabel, 60, "…");
      const label =
        status === "running"
          ? shimmerText(fittedLabel, this.theme, shimmerTick)
          : this.theme.fg(status === "queued" ? "dim" : "toolTitle", fittedLabel);
      const left = `  ${statusIcon} ${label}`;
      const statsText = [singleLine(result.agent), resultStats(result, status, now)]
        .filter(Boolean)
        .join(" · ");
      lines.push(fitColumns(left, this.theme.fg("dim", statsText), width));

      if (status === "running") {
        lines.push(
          truncateToWidth(`    ${latestActivity(result, status, this.theme)}`, width, "…"),
        );
      }
    }

    if (!this.active) {
      lines.push(
        truncateToWidth(this.theme.fg("dim", `${keyText("app.tools.expand")} details`), width, "…"),
      );
    }
    return lines;
  }

  invalidate(): void {}
}

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = [];
  let nextIndex = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

async function writePromptToTempFile(
  agentName: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  try {
    await withFileMutationQueue(filePath, async () => {
      await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
    });
    return { dir: tmpDir, filePath };
  } catch (error) {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
    throw error;
  }
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface DispatchDefaults {
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

interface ResolvedDispatchConfig {
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

export function resolveDispatchConfig(
  agentModel: string | undefined,
  invocationModel: string | undefined,
  defaults: DispatchDefaults,
): ResolvedDispatchConfig {
  const requestedModel = invocationModel?.trim() || undefined;
  const configuredModel = agentModel?.trim() || undefined;

  return {
    model: requestedModel ?? configuredModel ?? defaults.model,
    thinkingLevel: requestedModel || !configuredModel ? defaults.thinkingLevel : undefined,
  };
}

export interface ChildProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  killGraceMs?: number;
  /** Receives every JSON event line the child writes to stdout. */
  onEvent?: (event: any) => void;
}

export interface ChildProcessOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  aborted: boolean;
  stderr: string;
  spawnError?: string;
}

/**
 * Spawn a JSON-mode child in its own process group, feed each stdout line to
 * `onEvent`, and resolve once the process closes.
 */
export function runChildProcess(
  command: string,
  args: string[],
  options: ChildProcessOptions,
): Promise<ChildProcessOutcome> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let buffer = "";
    let stderr = "";
    let aborted = false;
    let spawnError: string | undefined;
    let processClosed = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;

    const finish = (code: number | null, closeSignal: NodeJS.Signals | null) => {
      if (processClosed) return;
      processClosed = true;
      if (forceKillTimer && !aborted) clearTimeout(forceKillTimer);
      if (options.signal && abortHandler) options.signal.removeEventListener("abort", abortHandler);
      resolve({ code, signal: closeSignal, aborted, stderr, spawnError });
    };

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event && typeof event === "object") options.onEvent?.(event);
    };

    proc.stdout.on("data", (data: Buffer) => {
      buffer += stdoutDecoder.write(data);
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += stderrDecoder.write(data);
    });

    proc.on("close", (code, closeSignal) => {
      buffer += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      if (buffer.trim()) processLine(buffer);
      finish(code, closeSignal);
    });

    proc.on("error", (error) => {
      spawnError = error.message;
      finish(1, null);
    });

    if (options.signal) {
      abortHandler = () => {
        if (aborted) return;
        aborted = true;
        if (proc.pid === undefined) return;
        signalProcessTree(proc.pid, "SIGTERM");
        forceKillTimer = setTimeout(() => signalProcessTree(proc.pid!, "SIGKILL"), killGraceMs);
        forceKillTimer.unref?.();
      };
      if (options.signal.aborted) abortHandler();
      else options.signal.addEventListener("abort", abortHandler, { once: true });
    }
  });
}

async function runSingleAgent(
  defaultCwd: string,
  dispatchDefaults: DispatchDefaults,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  label: string | undefined,
  invocationModel: string | undefined,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
  const agent = agents.find((a) => a.name === agentName);
  const dispatchConfig = resolveDispatchConfig(agent?.model, invocationModel, dispatchDefaults);

  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      label,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: createUsageStats(),
      model: dispatchConfig.model,
      step,
      completedAt: Date.now(),
    };
  }

  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (dispatchConfig.model) args.push("--model", dispatchConfig.model);
  if (dispatchConfig.thinkingLevel) {
    args.push("--thinking", dispatchConfig.thinkingLevel);
  }
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  const currentResult: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    label,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: createUsageStats(),
    model: dispatchConfig.model,
    step,
    startedAt: Date.now(),
  };

  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
        details: makeDetails([currentResult]),
      });
    }
  };

  if (signal?.aborted) {
    currentResult.exitCode = 1;
    currentResult.stopReason = "aborted";
    currentResult.errorMessage = "Subagent was aborted before starting";
    currentResult.completedAt = Date.now();
    return currentResult;
  }

  emitUpdate();

  try {
    if (agent.systemPrompt.trim()) {
      try {
        const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
        tmpPromptDir = tmp.dir;
        tmpPromptPath = tmp.filePath;
        args.push("--append-system-prompt", tmpPromptPath);
      } catch (error) {
        currentResult.exitCode = 1;
        currentResult.errorMessage = `Failed to prepare subagent prompt: ${error instanceof Error ? error.message : String(error)}`;
        currentResult.completedAt = Date.now();
        return currentResult;
      }
    }

    args.push(`Task: ${task}`);
    const invocation = getPiInvocation(args);
    const outcome = await runChildProcess(invocation.command, invocation.args, {
      cwd: cwd ?? defaultCwd,
      signal,
      onEvent: (event) => {
        if (event.type === "message_end" && event.message) {
          const msg = event.message as Message;
          currentResult.messages.push(msg);

          if (msg.role === "assistant") {
            currentResult.usage.turns++;
            const usage = msg.usage;
            if (usage) {
              addUsage(currentResult.usage.total, usage);
              currentResult.usage.contextTokens = usage.totalTokens;
            }
            if (!currentResult.model && msg.model) currentResult.model = msg.model;
            if (msg.stopReason) currentResult.stopReason = msg.stopReason;
            if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
          } else if (msg.role === "toolResult" && msg.usage) {
            addUsage(currentResult.usage.total, msg.usage);
          }
          emitUpdate();
        }

        if (event.type === "compaction_end" && event.result?.usage) {
          addUsage(currentResult.usage.total, event.result.usage as Usage);
        }
      },
    });

    currentResult.stderr = outcome.stderr;
    if (outcome.spawnError) {
      currentResult.errorMessage = `Failed to start subagent: ${outcome.spawnError}`;
    }
    const status = classifyChildExit(outcome.code, outcome.signal, outcome.aborted);
    currentResult.exitCode = status.exitCode;
    if (status.stopReason) currentResult.stopReason = status.stopReason;
    if (status.errorMessage) currentResult.errorMessage = status.errorMessage;
    currentResult.completedAt = Date.now();
    return currentResult;
  } finally {
    if (tmpPromptPath)
      try {
        fs.unlinkSync(tmpPromptPath);
      } catch {
        /* ignore */
      }
    if (tmpPromptDir)
      try {
        fs.rmdirSync(tmpPromptDir);
      } catch {
        /* ignore */
      }
  }
}

const ModelOverride = Type.Optional(
  Type.String({
    description: "Model override in provider/model format. Defaults to the agent or parent model.",
  }),
);

const DisplayLabel = Type.Optional(
  Type.String({ description: "Short display label describing the subagent's responsibility" }),
);

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  label: DisplayLabel,
  model: ModelOverride,
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
  label: DisplayLabel,
  model: ModelOverride,
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description:
    'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
  default: "user",
});

const SubagentParams = Type.Object({
  agent: Type.Optional(
    Type.String({ description: "Name of the agent to invoke (for single mode)" }),
  ),
  task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
  label: DisplayLabel,
  model: Type.Optional(
    Type.String({
      description:
        "Model override in provider/model format (single mode). Defaults to the agent or parent model.",
    }),
  ),
  tasks: Type.Optional(
    Type.Array(TaskItem, {
      description: "Array of {agent, task, model?} for parallel execution",
    }),
  ),
  chain: Type.Optional(
    Type.Array(ChainItem, {
      description: "Array of {agent, task, model?} for sequential execution",
    }),
  ),
  agentScope: Type.Optional(AgentScopeSchema),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({
      description: "Prompt before running project-local agents. Default: true.",
      default: true,
    }),
  ),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for the agent process (single mode)" }),
  ),
});

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", (event) => {
    if (event.toolName !== "subagent" || !hasFailedSubagentResult(event.details)) return;
    return { isError: true };
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate tasks to specialized subagents with isolated context.",
      "Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
      "Each subagent may include a short display label describing its responsibility.",
      "Single, parallel, and chain invocations may override the agent model.",
      `Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
      `To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
    ].join(" "),
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agentScope: AgentScope = params.agentScope ?? "user";
      const dispatchDefaults: DispatchDefaults = {
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinkingLevel: ctx.thinkingLevel,
      };
      const discovery = discoverAgents(ctx.cwd, agentScope);
      const agents = discovery.agents;
      const confirmProjectAgents = params.confirmProjectAgents ?? true;

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

      const makeDetails =
        (mode: "single" | "parallel" | "chain") =>
        (results: SingleResult[]): SubagentDetails => ({
          mode,
          agentScope,
          projectAgentsDir: discovery.projectAgentsDir,
          results,
        });

      if (modeCount !== 1) {
        const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
        return {
          content: [
            {
              type: "text",
              text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
            },
          ],
          details: makeDetails("single")([]),
        };
      }

      if (
        (agentScope === "project" || agentScope === "both") &&
        confirmProjectAgents &&
        ctx.hasUI
      ) {
        const requestedAgentNames = new Set<string>();
        if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
        if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
        if (params.agent) requestedAgentNames.add(params.agent);

        const projectAgentsRequested = Array.from(requestedAgentNames)
          .map((name) => agents.find((a) => a.name === name))
          .filter((a): a is AgentConfig => a?.source === "project");

        if (projectAgentsRequested.length > 0) {
          const names = projectAgentsRequested.map((a) => a.name).join(", ");
          const dir = discovery.projectAgentsDir ?? "(unknown)";
          const ok = await ctx.ui.confirm(
            "Run project-local agents?",
            `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
          );
          if (!ok)
            return {
              content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
              details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
            };
        }
      }

      if (params.chain && params.chain.length > 0) {
        const allResults: SingleResult[] = params.chain.map((step, index) => ({
          agent: step.agent,
          agentSource: "unknown",
          task: step.task,
          label: step.label,
          exitCode: -1,
          messages: [],
          stderr: "",
          usage: createUsageStats(),
          model: resolveDispatchConfig(
            agents.find((agent) => agent.name === step.agent)?.model,
            step.model,
            dispatchDefaults,
          ).model,
          step: index + 1,
        }));
        let previousOutput = "";

        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i];
          const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
          const chainUpdate: OnUpdateCallback | undefined = onUpdate
            ? (partial) => {
                const currentResult = partial.details?.results[0];
                if (currentResult) {
                  allResults[i] = {
                    ...currentResult,
                    task: step.task,
                    label: step.label,
                  };
                  onUpdate({
                    content: partial.content,
                    details: makeDetails("chain")([...allResults]),
                  });
                }
              }
            : undefined;

          const result = await runSingleAgent(
            ctx.cwd,
            dispatchDefaults,
            agents,
            step.agent,
            taskWithContext,
            step.label,
            step.model,
            step.cwd,
            i + 1,
            signal,
            chainUpdate,
            makeDetails("chain"),
          );
          result.task = step.task;
          result.label = step.label;
          allResults[i] = result;

          if (isFailedResult(result)) {
            const errorMsg = getResultOutput(result);
            return {
              content: [
                {
                  type: "text",
                  text: truncateOutput(
                    `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`,
                  ),
                },
              ],
              details: makeDetails("chain")(allResults),
              usage: combineUsageStats(allResults).total,
            };
          }
          previousOutput = getFinalOutput(result.messages);
        }
        return {
          content: [
            {
              type: "text",
              text: truncateOutput(
                getFinalOutput(allResults[allResults.length - 1].messages) || "(no output)",
              ),
            },
          ],
          details: makeDetails("chain")(allResults),
          usage: combineUsageStats(allResults).total,
        };
      }

      if (params.tasks && params.tasks.length > 0) {
        if (params.tasks.length > MAX_PARALLEL_TASKS)
          return {
            content: [
              {
                type: "text",
                text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
              },
            ],
            details: makeDetails("parallel")([]),
          };

        // Track all results for streaming updates
        const allResults: SingleResult[] = [];

        // Initialize placeholder results
        for (let i = 0; i < params.tasks.length; i++) {
          const task = params.tasks[i];
          allResults[i] = {
            agent: task.agent,
            agentSource: "unknown",
            task: task.task,
            label: task.label,
            exitCode: -1,
            messages: [],
            stderr: "",
            usage: createUsageStats(),
            model: resolveDispatchConfig(
              agents.find((agent) => agent.name === task.agent)?.model,
              task.model,
              dispatchDefaults,
            ).model,
          };
        }

        const emitParallelUpdate = () => {
          if (onUpdate) {
            onUpdate({
              content: [{ type: "text", text: formatParallelProgress(allResults) }],
              details: makeDetails("parallel")([...allResults]),
            });
          }
        };

        const results = await mapWithConcurrencyLimit(
          params.tasks,
          MAX_CONCURRENCY,
          async (t, index) => {
            const result = await runSingleAgent(
              ctx.cwd,
              dispatchDefaults,
              agents,
              t.agent,
              t.task,
              t.label,
              t.model,
              t.cwd,
              undefined,
              signal,
              // Per-task update callback
              (partial) => {
                if (partial.details?.results[0]) {
                  allResults[index] = { ...partial.details.results[0], exitCode: -1 };
                  emitParallelUpdate();
                }
              },
              makeDetails("parallel"),
            );
            allResults[index] = result;
            emitParallelUpdate();
            return result;
          },
        );

        const successCount = results.filter((r) => !isFailedResult(r)).length;
        const perTaskOutputCap = Math.min(
          PER_TASK_OUTPUT_CAP,
          Math.max(1024, Math.floor((MODEL_VISIBLE_OUTPUT_CAP - 2048) / results.length)),
        );
        const summaries = results.map((r) => {
          const output = truncateOutput(getResultOutput(r), perTaskOutputCap);
          const status = isFailedResult(r)
            ? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
            : "completed";
          return `### [${r.agent}] ${status}\n\n${output}`;
        });
        const combinedOutput = `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`;
        return {
          content: [{ type: "text", text: truncateOutput(combinedOutput) }],
          details: makeDetails("parallel")(results),
          usage: combineUsageStats(results).total,
        };
      }

      if (params.agent && params.task) {
        const result = await runSingleAgent(
          ctx.cwd,
          dispatchDefaults,
          agents,
          params.agent,
          params.task,
          params.label,
          params.model,
          params.cwd,
          undefined,
          signal,
          onUpdate,
          makeDetails("single"),
        );
        const isError = isFailedResult(result);
        if (isError) {
          const errorMsg = getResultOutput(result);
          return {
            content: [
              {
                type: "text",
                text: truncateOutput(`Agent ${result.stopReason || "failed"}: ${errorMsg}`),
              },
            ],
            details: makeDetails("single")([result]),
            usage: result.usage.total,
          };
        }
        return {
          content: [
            {
              type: "text",
              text: truncateOutput(getFinalOutput(result.messages) || "(no output)"),
            },
          ],
          details: makeDetails("single")([result]),
          usage: result.usage.total,
        };
      }

      const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
      return {
        content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
        details: makeDetails("single")([]),
      };
    },

    renderCall(args, theme, _context) {
      const scope: AgentScope = args.agentScope ?? "user";
      if (args.chain && args.chain.length > 0) {
        const text =
          theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", "chain") +
          theme.fg("dim", ` · ${args.chain.length} steps`) +
          theme.fg("muted", ` [${scope}]`);
        return new Text(text, 0, 0);
      }
      if (args.tasks && args.tasks.length > 0) {
        const text =
          theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", "parallel") +
          theme.fg("dim", ` · ${args.tasks.length} tasks`) +
          theme.fg("muted", ` [${scope}]`);
        return new Text(text, 0, 0);
      }
      const agentName = args.agent || "...";
      const responsibility = args.label || args.task;
      const preview = responsibility
        ? responsibility.length > 60
          ? `${responsibility.slice(0, 60)}...`
          : responsibility
        : "...";
      let text =
        theme.fg("toolTitle", theme.bold("subagent ")) +
        theme.fg("accent", agentName) +
        theme.fg("muted", ` [${scope}]`);
      text += `\n  ${theme.fg("dim", preview)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const details = result.details as SubagentDetails | undefined;
      if (!details || details.results.length === 0) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }

      const active =
        isPartial &&
        details.results.some((child) => {
          const status = resultStatus(child);
          return status === "queued" || status === "running";
        });
      if (!expanded || active) {
        const dashboard =
          context.lastComponent instanceof SubagentDashboard
            ? context.lastComponent
            : new SubagentDashboard(details, active, theme);
        dashboard.update(details, active, theme);
        return dashboard;
      }

      const mdTheme = getMarkdownTheme();

      if (details.mode === "single" && details.results.length === 1) {
        const r = details.results[0];
        const isError = isFailedResult(r);
        const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const displayItems = getDisplayItems(r.messages);
        const finalOutput = getFinalOutput(r.messages);

        const container = new Container();
        let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
        if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
        container.addChild(new Text(header, 0, 0));
        addFailureDiagnostic(container, r, theme);
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
        container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
        if (displayItems.length === 0 && !finalOutput) {
          container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
        } else {
          for (const item of displayItems) {
            if (item.type === "toolCall")
              container.addChild(
                new Text(
                  theme.fg("muted", "→ ") +
                    formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                  0,
                  0,
                ),
              );
          }
          if (finalOutput) {
            container.addChild(new Spacer(1));
            container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
          }
        }
        const usageStr = formatUsageStats(r.usage, r.model);
        if (usageStr) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
        }
        return container;
      }

      if (details.mode === "chain") {
        const successCount = details.results.filter((r) => resultStatus(r) === "completed").length;
        const icon =
          successCount === details.results.length
            ? theme.fg("success", "✓")
            : theme.fg("error", "✗");

        const container = new Container();
        container.addChild(
          new Text(
            icon +
              " " +
              theme.fg("toolTitle", theme.bold("chain ")) +
              theme.fg("accent", `${successCount}/${details.results.length} steps`),
            0,
            0,
          ),
        );

        for (const r of details.results) {
          const rIcon =
            resultStatus(r) === "queued"
              ? theme.fg("dim", "–")
              : isFailedResult(r)
                ? theme.fg("error", "✗")
                : theme.fg("success", "✓");
          const displayItems = getDisplayItems(r.messages);
          const finalOutput = getFinalOutput(r.messages);

          container.addChild(new Spacer(1));
          container.addChild(
            new Text(
              `${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
              0,
              0,
            ),
          );
          container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
          if (resultStatus(r) === "queued") {
            container.addChild(new Text(theme.fg("dim", "(not run)"), 0, 0));
          } else {
            addFailureDiagnostic(container, r, theme);
          }

          // Show tool calls
          for (const item of displayItems) {
            if (item.type === "toolCall") {
              container.addChild(
                new Text(
                  theme.fg("muted", "→ ") +
                    formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                  0,
                  0,
                ),
              );
            }
          }

          // Show final output as markdown
          if (finalOutput) {
            container.addChild(new Spacer(1));
            container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
          }

          const stepUsage = formatUsageStats(r.usage, r.model);
          if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
        }

        const usageStr = formatUsageStats(combineUsageStats(details.results));
        if (usageStr) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
        }
        return container;
      }

      if (details.mode === "parallel") {
        const successCount = details.results.filter(
          (r) => r.exitCode !== -1 && !isFailedResult(r),
        ).length;
        const failCount = details.results.filter(
          (r) => r.exitCode !== -1 && isFailedResult(r),
        ).length;
        const icon = failCount > 0 ? theme.fg("error", "×") : theme.fg("success", "✓");
        const status = `${successCount}/${details.results.length} tasks`;

        const container = new Container();
        container.addChild(
          new Text(
            `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
            0,
            0,
          ),
        );

        for (const r of details.results) {
          const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
          const displayItems = getDisplayItems(r.messages);
          const finalOutput = getFinalOutput(r.messages);

          container.addChild(new Spacer(1));
          container.addChild(
            new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
          );
          container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
          addFailureDiagnostic(container, r, theme);

          // Show tool calls
          for (const item of displayItems) {
            if (item.type === "toolCall") {
              container.addChild(
                new Text(
                  theme.fg("muted", "→ ") +
                    formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                  0,
                  0,
                ),
              );
            }
          }

          // Show final output as markdown
          if (finalOutput) {
            container.addChild(new Spacer(1));
            container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
          }

          const taskUsage = formatUsageStats(r.usage, r.model);
          if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
        }

        const usageStr = formatUsageStats(combineUsageStats(details.results));
        if (usageStr) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
        }
        return container;
      }

      const text = result.content[0];
      return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
    },
  });
}
