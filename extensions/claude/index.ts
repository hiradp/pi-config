import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  formatSize,
  type TruncationResult,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_MODEL = "opus";
const DEFAULT_EFFORT = "high";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_PERSISTED_OUTPUT_BYTES = 50 * 1024 * 1024;
const KILL_GRACE_MS = 5000;

interface ClaudeParams {
  prompt: string;
  model?: string;
  effort?: (typeof EFFORTS)[number];
}

interface ClaudeJsonResult {
  result?: unknown;
  is_error?: unknown;
  subtype?: unknown;
  total_cost_usd?: unknown;
  usage?: unknown;
}

interface ClaudeDetails {
  model: string;
  effort: (typeof EFFORTS)[number];
  exitCode: number | null;
  killed: boolean;
  failed?: boolean;
  stderr?: string;
  stderrTruncated?: boolean;
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

export interface ParsedClaudeOutput {
  text: string;
  isError: boolean;
  usage?: Usage;
}

export interface BoundedCommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
  aborted: boolean;
  stdoutOverflow: boolean;
  stderrTruncated: boolean;
  spawnError?: string;
}

interface RunCommandOptions {
  cwd: string;
  signal?: AbortSignal;
  input?: string;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  killGraceMs?: number;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseUsage(payload: ClaudeJsonResult): Usage | undefined {
  if (!payload.usage || typeof payload.usage !== "object") return undefined;

  const raw = payload.usage as Record<string, unknown>;
  const input = finiteNumber(raw.input_tokens);
  const output = finiteNumber(raw.output_tokens);
  const cacheRead = finiteNumber(raw.cache_read_input_tokens);
  const cacheWrite = finiteNumber(raw.cache_creation_input_tokens);
  const totalTokens = input + output + cacheRead + cacheWrite;
  if (totalTokens === 0) return undefined;

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: finiteNumber(payload.total_cost_usd),
    },
  };
}

export function parseClaudeOutput(stdout: string): ParsedClaudeOutput {
  const fallback = stdout.trim() || "(no output)";

  let payload: ClaudeJsonResult;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== "object") {
      return { text: fallback, isError: false };
    }
    payload = parsed as ClaudeJsonResult;
  } catch {
    return { text: fallback, isError: false };
  }

  const text =
    typeof payload.result === "string" ? payload.result.trim() || "(no output)" : fallback;
  const subtype = typeof payload.subtype === "string" ? payload.subtype : "";
  return {
    text,
    isError: payload.is_error === true || subtype.includes("error"),
    usage: parseUsage(payload),
  };
}

export function buildClaudeArgs(params: ClaudeParams): {
  args: string[];
  input: string;
  model: string;
  effort: (typeof EFFORTS)[number];
} {
  const model = params.model?.trim() || DEFAULT_MODEL;
  const effort = params.effort ?? DEFAULT_EFFORT;
  return {
    model,
    effort,
    input: params.prompt,
    args: [
      "-p",
      "--no-session-persistence",
      "--safe-mode",
      "--tools",
      "",
      "--output-format",
      "json",
      "--model",
      model,
      "--effort",
      effort,
    ],
  };
}

export async function runBoundedCommand(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<BoundedCommandResult> {
  if (options.signal?.aborted) {
    return {
      stdout: "",
      stderr: "",
      code: null,
      signal: null,
      killed: false,
      aborted: true,
      stdoutOverflow: false,
      stderrTruncated: false,
    };
  }

  const maxStdoutBytes = options.maxStdoutBytes ?? MAX_STDOUT_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? MAX_STDERR_BYTES;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (options.input !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(options.input);
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutOverflow = false;
    let stderrTruncated = false;
    let aborted = false;
    let killed = false;
    let closed = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const terminate = () => {
      if (closed || killed) return;
      killed = child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, killGraceMs);
    };

    const append = (
      chunks: Buffer[],
      chunk: Buffer,
      currentBytes: number,
      maxBytes: number,
    ): { bytes: number; truncated: boolean } => {
      const remaining = Math.max(0, maxBytes - currentBytes);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      return {
        bytes: currentBytes + Math.min(chunk.length, remaining),
        truncated: chunk.length > remaining,
      };
    };

    child.stdout!.on("data", (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const next = append(stdoutChunks, chunk, stdoutBytes, maxStdoutBytes);
      stdoutBytes = next.bytes;
      if (next.truncated) {
        stdoutOverflow = true;
        terminate();
      }
    });

    child.stderr!.on("data", (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const next = append(stderrChunks, chunk, stderrBytes, maxStderrBytes);
      stderrBytes = next.bytes;
      stderrTruncated ||= next.truncated;
    });

    const finish = (
      code: number | null,
      closeSignal: NodeJS.Signals | null,
      spawnError?: string,
    ) => {
      if (closed) return;
      closed = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (options.signal) options.signal.removeEventListener("abort", abortHandler);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        code,
        signal: closeSignal,
        killed,
        aborted,
        stdoutOverflow,
        stderrTruncated,
        spawnError,
      });
    };

    const abortHandler = () => {
      aborted = true;
      terminate();
    };

    child.on("close", (code, closeSignal) => finish(code, closeSignal));
    child.on("error", (error) => finish(null, null, error.message));
    options.signal?.addEventListener("abort", abortHandler, { once: true });
  });
}

function utf8Prefix(text: string, maxBytes: number, suffix = ""): string {
  const safeSuffix = Buffer.byteLength(suffix, "utf8") <= maxBytes ? suffix : "";
  const byteBudget = Math.max(0, maxBytes - Buffer.byteLength(safeSuffix, "utf8"));
  let prefix = Buffer.from(text, "utf8").subarray(0, byteBudget).toString("utf8");
  while (Buffer.byteLength(prefix, "utf8") > byteBudget) prefix = prefix.slice(0, -1);
  return `${prefix}${safeSuffix}`;
}

export function boundedDiagnostic(text: string, maxBytes = 4096, maxLines = 40): string {
  const trimmed = text.trim();
  if (!trimmed) return "";

  const truncation = truncateHead(trimmed, { maxBytes, maxLines });
  if (truncation.content.trim()) return truncation.content.trim();
  return utf8Prefix(trimmed.split("\n", 1)[0], maxBytes, "… [truncated]");
}

export function formatBoundedClaudeOutput(
  output: string,
  fullOutputPath?: string,
): { text: string; truncation?: TruncationResult } {
  const initial = truncateHead(output, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!initial.truncated) return { text: initial.content };

  let maxBodyBytes = DEFAULT_MAX_BYTES;
  let truncation = initial;
  let notice = "";
  let text = "";

  do {
    truncation = truncateHead(output, {
      maxBytes: maxBodyBytes,
      maxLines: DEFAULT_MAX_LINES - 2,
    });
    if (!truncation.content && output) {
      const content = utf8Prefix(output, maxBodyBytes);
      truncation = {
        ...truncation,
        content,
        outputBytes: Buffer.byteLength(content, "utf8"),
        outputLines: content ? 1 : 0,
      };
    }
    const persistence = fullOutputPath
      ? `Full output saved to: ${fullOutputPath}`
      : "Full output was not saved";
    notice = `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ${persistence}]`;
    text = `${truncation.content}\n\n${notice}`;
    const excessBytes = Buffer.byteLength(text, "utf8") - DEFAULT_MAX_BYTES;
    if (excessBytes > 0) maxBodyBytes = Math.max(0, maxBodyBytes - excessBytes);
  } while (Buffer.byteLength(text, "utf8") > DEFAULT_MAX_BYTES);

  return { text, truncation };
}

export function hasFailedClaudeResult(details: unknown): boolean {
  return Boolean(
    details && typeof details === "object" && (details as { failed?: unknown }).failed,
  );
}

export default function (pi: ExtensionAPI) {
  let outputDirectory: Promise<string> | undefined;
  let persistedOutputBytes = 0;

  const setClaudeActive = (active: boolean) => {
    const activeTools = pi.getActiveTools();
    pi.setActiveTools(
      active
        ? [...new Set([...activeTools, "claude"])]
        : activeTools.filter((name) => name !== "claude"),
    );
  };

  const isClaudeActive = () => pi.getActiveTools().includes("claude");

  const saveFullOutput = async (output: string): Promise<string | undefined> => {
    const outputBytes = Buffer.byteLength(output, "utf8");
    if (persistedOutputBytes + outputBytes > MAX_PERSISTED_OUTPUT_BYTES) return undefined;
    persistedOutputBytes += outputBytes;

    try {
      outputDirectory ??= mkdtemp(join(tmpdir(), "pi-claude-"));
      const filePath = join(await outputDirectory, `${randomUUID()}.txt`);
      await withFileMutationQueue(filePath, () =>
        writeFile(filePath, output, { encoding: "utf8", mode: 0o600 }),
      );
      return filePath;
    } catch {
      persistedOutputBytes -= outputBytes;
      return undefined;
    }
  };

  pi.on("session_start", () => {
    setClaudeActive(false);
  });

  pi.on("session_shutdown", async () => {
    const directory = outputDirectory;
    outputDirectory = undefined;
    persistedOutputBytes = 0;
    if (!directory) return;

    try {
      await rm(await directory, { recursive: true, force: true });
    } catch {
      // Temporary output cleanup is best-effort.
    }
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== "claude") return;
    setClaudeActive(false);
    if (hasFailedClaudeResult(event.details)) return { isError: true };
  });

  pi.registerCommand("claude-tool", {
    description: "Arm or disarm Claude Code delegation for one invocation",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "on") {
        setClaudeActive(true);
        ctx.ui.notify("Claude delegation armed for one invocation", "info");
        return;
      }
      if (action === "off") {
        setClaudeActive(false);
        ctx.ui.notify("Claude delegation disarmed", "info");
        return;
      }
      ctx.ui.notify(
        `Claude delegation is ${isClaudeActive() ? "armed" : "disarmed"}. Usage: /claude-tool on|off`,
        "info",
      );
    },
  });

  pi.registerTool({
    name: "claude",
    label: "Claude Code",
    description: `Delegate a prompt to the official Claude Code CLI only when the user explicitly requests Claude Code delegation. Defaults to model "${DEFAULT_MODEL}" with "${DEFAULT_EFFORT}" effort. Claude runs without nested tools. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; full truncated output is saved temporarily when possible.`,
    promptGuidelines: [
      "Use claude only when the user explicitly asks to delegate to Claude Code. Do not use claude for routine analysis, implementation, review, or unsolicited second opinions.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Prompt to send to Claude Code", minLength: 1 }),
      model: Type.Optional(
        Type.String({
          description: `Claude model or alias. Defaults to "${DEFAULT_MODEL}".`,
          default: DEFAULT_MODEL,
        }),
      ),
      effort: Type.Optional(
        StringEnum(EFFORTS, {
          description: `Claude effort level. Defaults to "${DEFAULT_EFFORT}".`,
          default: DEFAULT_EFFORT,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const invocation = buildClaudeArgs(params);
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Running Claude Code (${invocation.model}, ${invocation.effort})…`,
          },
        ],
        details: {
          model: invocation.model,
          effort: invocation.effort,
          exitCode: null,
          killed: false,
        } satisfies ClaudeDetails,
      });

      const result = await runBoundedCommand("claude", invocation.args, {
        cwd: ctx.cwd,
        signal,
        input: invocation.input,
      });
      const parsed = parseClaudeOutput(result.stdout);
      const stderr = boundedDiagnostic(result.stderr);
      const details: ClaudeDetails = {
        model: invocation.model,
        effort: invocation.effort,
        exitCode: result.code,
        killed: result.killed,
        stderr: stderr || undefined,
        stderrTruncated: result.stderrTruncated || undefined,
      };

      let failure: string | undefined;
      if (result.aborted) failure = "Claude Code invocation was canceled";
      else if (result.spawnError) failure = `Failed to start Claude Code: ${result.spawnError}`;
      else if (result.stdoutOverflow)
        failure = `Claude Code output exceeded ${formatSize(MAX_STDOUT_BYTES)}`;
      else if (result.killed)
        failure = `Claude Code was killed${result.signal ? ` (${result.signal})` : ""}`;
      else if (result.code !== 0) failure = `Claude Code exited with code ${result.code}`;
      else if (parsed.isError) failure = "Claude Code reported an error";

      if (failure) {
        details.failed = true;
        const responseDiagnostic =
          parsed.text === "(no output)" ? "" : boundedDiagnostic(parsed.text, 3072, 30);
        const stderrDiagnostic = boundedDiagnostic(result.stderr, 1024, 10);
        const diagnostic = [responseDiagnostic, stderrDiagnostic].filter(Boolean).join("\n");
        return {
          content: [{ type: "text", text: `${failure}${diagnostic ? `:\n${diagnostic}` : ""}` }],
          details,
          usage: parsed.usage,
        };
      }

      const initial = truncateHead(parsed.text, {
        maxBytes: DEFAULT_MAX_BYTES,
        maxLines: DEFAULT_MAX_LINES,
      });
      if (!initial.truncated) {
        return {
          content: [{ type: "text", text: initial.content }],
          details,
          usage: parsed.usage,
        };
      }

      const fullOutputPath = await saveFullOutput(parsed.text);
      if (fullOutputPath) details.fullOutputPath = fullOutputPath;
      const bounded = formatBoundedClaudeOutput(parsed.text, fullOutputPath);
      details.truncation = bounded.truncation;
      return {
        content: [{ type: "text", text: bounded.text }],
        details,
        usage: parsed.usage,
      };
    },
  });
}
