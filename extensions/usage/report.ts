import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import {
  parseSessionEntries,
  SessionManager,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  PERIOD_KEYS,
  TREND_KEYS,
  type ModelUsage,
  type PeriodUsage,
  type UsageBucket,
  type UsageCategory,
  type UsagePeriodKey,
  type UsageReport,
  type UsageTotals,
  type UsageTrendKey,
} from "./types.ts";

/** Tools whose results carry the usage of a delegated agent rather than of this session. */
const DELEGATED_TOOLS = new Set(["subagent", "claude"]);
const COST_EPSILON = 1e-9;

interface UsageEvent {
  timestamp: number;
  category: UsageCategory;
  provider: string;
  model: string;
  source?: string;
  usage: UsageTotals;
  fingerprint: string;
}

/** Inclusive bounds of the timestamps a report covers. */
interface UsageWindow {
  start: number;
  end: number;
}

interface AssistantIdentity {
  provider: string;
  requestedModel: string;
  model: string;
}

interface MutablePeriodUsage {
  key: UsagePeriodKey;
  start: number;
  totals: UsageTotals;
  models: Map<string, ModelUsage>;
}

interface LoadUsageOptions {
  currentSessionFile?: string;
  currentEntries?: readonly SessionEntry[];
  now?: Date;
  signal?: AbortSignal;
}

export function emptyTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeUsage(usage: Usage | undefined): UsageTotals | null {
  if (!usage) return null;

  const input = finiteNonNegative(usage.input);
  const output = finiteNonNegative(usage.output);
  const cacheRead = finiteNonNegative(usage.cacheRead);
  const cacheWrite = finiteNonNegative(usage.cacheWrite);
  const itemizedCost =
    finiteNonNegative(usage.cost?.input) +
    finiteNonNegative(usage.cost?.output) +
    finiteNonNegative(usage.cost?.cacheRead) +
    finiteNonNegative(usage.cost?.cacheWrite);
  const cost = finiteNonNegative(usage.cost?.total) || itemizedCost;

  if (input + output + cacheRead + cacheWrite === 0 && cost === 0) return null;
  return { input, output, cacheRead, cacheWrite, cost };
}

export function addTotals(target: UsageTotals, source: UsageTotals): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.cost += source.cost;
}

/** Component-wise difference, or null when `part` exceeds `total` anywhere. */
function subtractTotals(total: UsageTotals, part: UsageTotals): UsageTotals | null {
  const remainder = {
    input: total.input - part.input,
    output: total.output - part.output,
    cacheRead: total.cacheRead - part.cacheRead,
    cacheWrite: total.cacheWrite - part.cacheWrite,
    cost: total.cost - part.cost,
  };
  if (Object.values(remainder).some((value) => value < -COST_EPSILON)) return null;
  remainder.cost = Math.max(0, remainder.cost);
  return remainder;
}

function hasUsage(totals: UsageTotals): boolean {
  return totalTokens(totals) > 0 || totals.cost > COST_EPSILON;
}

export function totalTokens(totals: UsageTotals): number {
  return totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
}

function entryTimestamp(entry: SessionEntry, messageTimestamp?: number): number | null {
  if (typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp)) {
    return messageTimestamp;
  }

  const timestamp = Date.parse(entry.timestamp);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function inWindow(timestamp: number, window: UsageWindow): boolean {
  return timestamp >= window.start && timestamp <= window.end;
}

function fingerprint(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("base64url");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function assistantIdentity(message: Record<string, unknown>): AssistantIdentity {
  const provider =
    typeof message.provider === "string" && message.provider ? message.provider : "Unknown";
  const requestedModel =
    typeof message.model === "string" && message.model ? message.model : "unknown";
  const model =
    typeof message.responseModel === "string" && message.responseModel
      ? message.responseModel
      : requestedModel;
  return { provider, requestedModel, model };
}

function assistantEvent(
  entry: SessionEntry,
  message: Record<string, unknown>,
  window: UsageWindow,
): UsageEvent | null {
  const usage = normalizeUsage(message.usage as Usage | undefined);
  const timestamp = entryTimestamp(entry, finiteNumber(message.timestamp));
  // Fingerprinting hashes the message content, so rule the event out by time before paying for it.
  if (!usage || timestamp === null || !inWindow(timestamp, window)) return null;

  const { provider, requestedModel, model } = assistantIdentity(message);
  return {
    timestamp,
    category: "primary",
    provider,
    model,
    usage,
    fingerprint: fingerprint([
      "assistant",
      entry.timestamp,
      message.timestamp,
      message.responseId,
      provider,
      requestedModel,
      message.responseModel,
      message.usage,
      message.content,
    ]),
  };
}

/** Assistant messages a subagent result stored for each child run. */
function nestedAssistantMessages(details: unknown): Record<string, unknown>[] {
  const results = asRecord(details)?.results;
  if (!Array.isArray(results)) return [];

  return results.flatMap((result) => {
    const messages = asRecord(result)?.messages;
    if (!Array.isArray(messages)) return [];
    return messages.flatMap((message) => {
      const record = asRecord(message);
      return record?.role === "assistant" ? [record] : [];
    });
  });
}

/** The model a delegated tool reported: `claude` stores it directly, `subagent` per child run. */
function detailsModel(details: unknown): string {
  const record = asRecord(details);
  if (typeof record?.model === "string") return record.model;

  const results = Array.isArray(record?.results) ? record.results : [];
  const models = new Set(
    results.flatMap((result) => {
      const model = asRecord(result)?.model;
      return typeof model === "string" && model ? [model] : [];
    }),
  );
  return models.size === 1 ? ([...models][0] ?? "") : "";
}

function delegatedEvents(
  entry: SessionEntry,
  message: ToolResultMessage,
  timestamp: number,
  total: UsageTotals,
): UsageEvent[] {
  const source = message.toolName;
  const identity = [entry.timestamp, message.timestamp, message.toolCallId, source];
  const events: UsageEvent[] = [];
  const attributed = emptyTotals();

  nestedAssistantMessages(message.details).forEach((nested, index) => {
    const usage = normalizeUsage(nested.usage as Usage | undefined);
    if (!usage) return;

    const { provider, requestedModel, model } = assistantIdentity(nested);
    addTotals(attributed, usage);
    events.push({
      timestamp,
      category: "delegated",
      provider,
      model,
      source,
      usage,
      fingerprint: fingerprint([
        "delegated",
        ...identity,
        index,
        nested.timestamp,
        nested.responseId,
        provider,
        requestedModel,
        nested.responseModel,
        nested.usage,
        nested.content,
      ]),
    });
  });

  // The result total also covers child work with no nested message, such as compaction or
  // nested tool calls. That remainder goes to the one model that ran when there is one, and
  // otherwise to the model the details name. Nested usage above the total means the details
  // are inconsistent, so only the total is counted.
  let remainder = subtractTotals(total, attributed);
  if (remainder === null) {
    events.length = 0;
    remainder = total;
  }
  if (hasUsage(remainder)) {
    const first = events[0];
    const single =
      first &&
      events.every((event) => event.provider === first.provider && event.model === first.model)
        ? first
        : undefined;
    events.push({
      timestamp,
      category: "delegated",
      provider: single?.provider ?? "",
      model: single?.model ?? detailsModel(message.details),
      source,
      usage: remainder,
      fingerprint: fingerprint(["toolResult", ...identity, message.usage, message.content]),
    });
  }

  return events;
}

function toolResultEvents(
  entry: SessionEntry,
  message: ToolResultMessage,
  window: UsageWindow,
): UsageEvent[] {
  const usage = normalizeUsage(message.usage);
  const timestamp = entryTimestamp(entry, message.timestamp);
  if (!usage || timestamp === null || !inWindow(timestamp, window)) return [];
  if (DELEGATED_TOOLS.has(message.toolName)) {
    return delegatedEvents(entry, message, timestamp, usage);
  }

  return [
    {
      timestamp,
      category: "tool",
      provider: "",
      model: "",
      source: message.toolName || "unknown",
      usage,
      fingerprint: fingerprint([
        "toolResult",
        entry.timestamp,
        message.timestamp,
        message.toolCallId,
        message.toolName,
        message.usage,
        message.content,
      ]),
    },
  ];
}

function eventsFromEntry(entry: SessionEntry, window: UsageWindow): UsageEvent[] {
  if (entry.type === "message" && entry.message.role === "assistant") {
    const event = assistantEvent(
      entry,
      entry.message as unknown as Record<string, unknown>,
      window,
    );
    return event ? [event] : [];
  }

  if (entry.type === "message" && entry.message.role === "toolResult") {
    return toolResultEvents(entry, entry.message, window);
  }

  if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
    const usage = normalizeUsage(entry.usage);
    const timestamp = entryTimestamp(entry);
    if (!usage || timestamp === null || !inWindow(timestamp, window)) return [];

    return [
      {
        timestamp,
        category: "overhead",
        provider: "",
        model: "",
        source: entry.type === "compaction" ? "Compaction" : "Branch summary",
        usage,
        fingerprint: fingerprint([entry.type, entry.timestamp, entry.usage, entry.summary]),
      },
    ];
  }

  return [];
}

function localDayStart(date: Date): number {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

export function addLocalDays(timestamp: number, days: number): number {
  const date = new Date(timestamp);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

function periodStarts(now: Date): Record<UsagePeriodKey, number> {
  const day = new Date(localDayStart(now));

  const week = new Date(day);
  week.setDate(week.getDate() - ((week.getDay() + 6) % 7));

  const month = new Date(day);
  month.setDate(1);

  return { day: day.getTime(), week: week.getTime(), month: month.getTime() };
}

function trendBuckets(now: Date): Record<UsageTrendKey, UsageBucket[]> {
  const today = localDayStart(now);
  const dailyStart = addLocalDays(today, -6);
  const daily7 = Array.from({ length: 7 }, (_, index) => {
    const start = addLocalDays(dailyStart, index);
    return { start, endExclusive: addLocalDays(start, 1), totals: emptyTotals() };
  });

  const weekly30: UsageBucket[] = [];
  const endExclusive = addLocalDays(today, 1);
  let start = addLocalDays(today, -29);
  while (start < endExclusive) {
    const weekday = new Date(start).getDay();
    const daysToMonday = (8 - weekday) % 7 || 7;
    const nextMonday = addLocalDays(start, daysToMonday);
    const end = Math.min(nextMonday, endExclusive);
    weekly30.push({ start, endExclusive: end, totals: emptyTotals() });
    start = end;
  }

  return { daily7, weekly30 };
}

function mutablePeriod(key: UsagePeriodKey, start: number): MutablePeriodUsage {
  return { key, start, totals: emptyTotals(), models: new Map() };
}

function addEvent(period: MutablePeriodUsage, event: UsageEvent): void {
  addTotals(period.totals, event.usage);

  const modelKey = JSON.stringify([event.category, event.source, event.provider, event.model]);
  let model = period.models.get(modelKey);
  if (!model) {
    model = {
      category: event.category,
      provider: event.provider,
      model: event.model,
      ...(event.source ? { source: event.source } : {}),
      ...emptyTotals(),
    };
    period.models.set(modelKey, model);
  }
  addTotals(model, event.usage);
}

export function compareUsage(a: UsageTotals, b: UsageTotals): number {
  return b.cost - a.cost || totalTokens(b) - totalTokens(a);
}

/** Orders models for display: the view renders them as-is, split by category. */
function finalizePeriod(period: MutablePeriodUsage): PeriodUsage {
  const models = [...period.models.values()].sort(
    (a, b) =>
      compareUsage(a, b) ||
      a.category.localeCompare(b.category) ||
      (a.source ?? "").localeCompare(b.source ?? "") ||
      a.provider.localeCompare(b.provider) ||
      a.model.localeCompare(b.model),
  );
  return { key: period.key, start: period.start, totals: { ...period.totals }, models };
}

export function aggregateUsage(
  sessions: readonly (readonly SessionEntry[])[],
  now = new Date(),
): UsageReport {
  const generatedAt = now.getTime();
  if (!Number.isFinite(generatedAt)) throw new Error("Cannot aggregate usage for an invalid date");

  const starts = periodStarts(now);
  const trends = trendBuckets(now);
  const mutablePeriods: Record<UsagePeriodKey, MutablePeriodUsage> = {
    day: mutablePeriod("day", starts.day),
    week: mutablePeriod("week", starts.week),
    month: mutablePeriod("month", starts.month),
  };
  const seen = new Set<string>();
  const window: UsageWindow = {
    start: Math.min(
      ...Object.values(starts),
      ...TREND_KEYS.map((key) => trends[key][0]?.start ?? generatedAt),
    ),
    end: generatedAt,
  };
  let eventCount = 0;
  let deduplicatedEntries = 0;

  for (const entries of sessions) {
    for (const entry of entries) {
      for (const event of eventsFromEntry(entry, window)) {
        if (seen.has(event.fingerprint)) {
          deduplicatedEntries++;
          continue;
        }

        seen.add(event.fingerprint);
        eventCount++;
        for (const key of PERIOD_KEYS) {
          if (event.timestamp >= starts[key]) addEvent(mutablePeriods[key], event);
        }
        for (const key of TREND_KEYS) {
          const bucket = trends[key].find(
            ({ start, endExclusive }) => event.timestamp >= start && event.timestamp < endExclusive,
          );
          if (bucket) addTotals(bucket.totals, event.usage);
        }
      }
    }
  }

  return {
    generatedAt,
    sessionCount: sessions.length,
    skippedFiles: 0,
    eventCount,
    deduplicatedEntries,
    periods: {
      day: finalizePeriod(mutablePeriods.day),
      week: finalizePeriod(mutablePeriods.week),
      month: finalizePeriod(mutablePeriods.month),
    },
    trends,
  };
}

export async function loadUsageReport(options: LoadUsageOptions = {}): Promise<UsageReport> {
  const { currentSessionFile, currentEntries, now = new Date(), signal } = options;
  // listAll() already streams every session file, but it keeps only metadata (id, cwd, name,
  // timestamps, message text) and discards the entries, so each file is read again here.
  const sessionInfos = await SessionManager.listAll();
  signal?.throwIfAborted();

  const paths = new Set(sessionInfos.map((session) => resolve(session.path)));
  const resolvedCurrentFile = currentSessionFile ? resolve(currentSessionFile) : undefined;
  if (resolvedCurrentFile) paths.add(resolvedCurrentFile);

  const sessions: SessionEntry[][] = [];
  let skippedFiles = 0;
  let currentFileLoaded = false;

  for (const path of paths) {
    signal?.throwIfAborted();
    try {
      const content = signal
        ? await readFile(path, { encoding: "utf8", signal })
        : await readFile(path, "utf8");
      const entries = parseSessionEntries(content).filter(
        (entry): entry is SessionEntry => entry.type !== "session",
      );
      sessions.push(entries);
      if (path === resolvedCurrentFile) currentFileLoaded = true;
    } catch (error) {
      if (signal?.aborted) throw error;
      skippedFiles++;
    }
  }

  if (currentEntries && (!resolvedCurrentFile || !currentFileLoaded)) {
    sessions.push([...currentEntries]);
  }

  const report = aggregateUsage(sessions, now);
  report.skippedFiles = skippedFiles;
  return report;
}
