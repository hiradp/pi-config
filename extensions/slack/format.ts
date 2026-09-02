import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { SlackOperation } from "./tools.ts";
import type { SlackCallResult } from "./types.ts";

const MAX_FIELD_BYTES = 4_000;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 100;
const MAX_DEPTH = 8;
const SENSITIVE_KEY = /(?:^|_)(?:access|refresh)?_?token$|authorization|code_verifier/i;
const SLACK_TOKEN = /\b(?:xoxe\.xox[abp]|xox[abcdeprs]|xapp)-[A-Za-z0-9-]+\b/g;

export interface SlackToolDetails {
  operation: SlackOperation;
  count?: number;
  cursor?: string;
  truncated: boolean;
  truncation?: {
    by: "lines" | "bytes";
    outputLines: number;
    totalLines: number;
    outputBytes: number;
    totalBytes: number;
  };
}

export function formatSlackResult(
  operation: SlackOperation,
  result: SlackCallResult,
): { text: string; details: SlackToolDetails } {
  const normalized = normalizeResult(result);
  const output =
    normalized.value === undefined
      ? normalized.text || "Slack returned no results."
      : JSON.stringify(normalized.value, null, 2);
  const truncated = truncateHead(output, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  let text = truncated.content;
  if (truncated.truncated) {
    const notice = truncated.firstLineExceedsLimit
      ? `[Slack output omitted because its first line exceeded ${formatSize(DEFAULT_MAX_BYTES)}. Use a smaller page.]`
      : `[Slack output truncated: showing ${truncated.outputLines} of ${truncated.totalLines} lines (${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)}). Use the pagination cursor or a smaller page.]`;
    text += `${text ? "\n\n" : ""}${notice}`;
  }

  return {
    text,
    details: {
      operation,
      ...(normalized.count !== undefined ? { count: normalized.count } : {}),
      ...(normalized.cursor ? { cursor: normalized.cursor } : {}),
      truncated: truncated.truncated,
      ...(truncated.truncated && truncated.truncatedBy
        ? {
            truncation: {
              by: truncated.truncatedBy,
              outputLines: truncated.outputLines,
              totalLines: truncated.totalLines,
              outputBytes: truncated.outputBytes,
              totalBytes: truncated.totalBytes,
            },
          }
        : {}),
    },
  };
}

function normalizeResult(result: SlackCallResult): {
  value?: unknown;
  text: string;
  count?: number;
  cursor?: string;
} {
  let source: unknown = result.structuredContent;
  const textParts = result.content.flatMap((item) =>
    item.type === "text" && typeof item.text === "string" ? [redactSlackTokens(item.text)] : [],
  );
  if (source === undefined && textParts.length === 1) {
    try {
      source = JSON.parse(textParts[0]!) as unknown;
    } catch {}
  }
  if (source !== undefined) {
    const sanitized = sanitizeValue(source, 0);
    return {
      value: sanitized,
      text: "",
      count: findCount(sanitized),
      cursor: findCursor(sanitized),
    };
  }
  const text = textParts.map(boundString).join("\n\n");
  return { text, cursor: findCursorInText(text) };
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth >= MAX_DEPTH) return "[nested content omitted]";
  if (typeof value === "string") return boundString(redactSlackTokens(value));
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS)
      items.push(`[${value.length - MAX_ARRAY_ITEMS} items omitted]`);
    return items;
  }
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);
    for (const [key, item] of entries) {
      output[boundString(key)] = SENSITIVE_KEY.test(key)
        ? "[redacted]"
        : sanitizeValue(item, depth + 1);
    }
    if (Object.keys(value).length > MAX_OBJECT_KEYS) output._truncated = true;
    return output;
  }
  return String(value);
}

function findCount(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  if (!isRecord(value)) return undefined;
  for (const key of ["results", "messages", "channels", "users", "items", "matches"]) {
    if (Array.isArray(value[key])) return value[key].length;
  }
  if (typeof value.count === "number" && Number.isSafeInteger(value.count) && value.count >= 0) {
    return value.count;
  }
  return undefined;
}

function findCursor(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || !isRecord(value)) return undefined;
  for (const key of ["next_cursor", "nextCursor", "cursor"]) {
    if (typeof value[key] === "string" && value[key]) return boundString(value[key]);
  }
  for (const key of ["pagination", "metadata", "response_metadata", "page_info"]) {
    const cursor = findCursor(value[key], depth + 1);
    if (cursor) return cursor;
  }
  return undefined;
}

function findCursorInText(text: string): string | undefined {
  const match = text.match(/(?:next_cursor|nextCursor|cursor)\s*[:=]\s*["']?([^\s,"']+)/);
  return match?.[1] ? boundString(match[1]) : undefined;
}

function boundString(value: string): string {
  if (Buffer.byteLength(value) <= MAX_FIELD_BYTES) return value;
  let end = Math.min(value.length, MAX_FIELD_BYTES);
  while (end > 0 && Buffer.byteLength(value.slice(0, end)) > MAX_FIELD_BYTES - 20) end--;
  return `${value.slice(0, end)}… [truncated]`;
}

export function redactSlackTokens(value: string): string {
  return value.replace(SLACK_TOKEN, "[redacted Slack token]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
