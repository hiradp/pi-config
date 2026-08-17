import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
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

interface UsageEvent {
  timestamp: number;
  category: UsageCategory;
  provider: string;
  model: string;
  source?: string;
  usage: UsageTotals;
  fingerprint: string;
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

function fingerprint(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("base64url");
}

function assistantEvent(
  entry: SessionEntry,
  message: Record<string, unknown>,
  source?: string,
): UsageEvent | null {
  const usage = normalizeUsage(message.usage as Usage | undefined);
  const messageTimestamp =
    typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
      ? message.timestamp
      : undefined;
  const timestamp = entryTimestamp(entry, messageTimestamp);
  if (!usage || timestamp === null) return null;

  const provider =
    typeof message.provider === "string" && message.provider ? message.provider : "Unknown";
  const requestedModel =
    typeof message.model === "string" && message.model ? message.model : "unknown";
  const model =
    typeof message.responseModel === "string" && message.responseModel
      ? message.responseModel
      : requestedModel;
  return {
    timestamp,
    category: source ? "delegated" : "primary",
    provider,
    model,
    ...(source ? { source } : {}),
    usage,
    fingerprint: fingerprint([
      "assistant",
      source,
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

function porterEvents(entry: SessionEntry): UsageEvent[] {
  if (entry.type !== "message" || entry.message.role !== "toolResult") return [];
  if (entry.message.toolName !== "porter") return [];

  const details = entry.message.details;
  if (typeof details !== "object" || details === null || !("messages" in details)) return [];
  const messages = (details as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];

  return messages.flatMap((message) => {
    if (typeof message !== "object" || message === null || !("role" in message)) return [];
    if ((message as { role?: unknown }).role !== "assistant") return [];
    const event = assistantEvent(entry, message as Record<string, unknown>, "Porter");
    return event ? [event] : [];
  });
}

function eventsFromEntry(entry: SessionEntry): UsageEvent[] {
  if (entry.type === "message" && entry.message.role === "assistant") {
    const event = assistantEvent(entry, entry.message as unknown as Record<string, unknown>);
    return event ? [event] : [];
  }

  if (entry.type === "message" && entry.message.role === "toolResult") {
    const nestedEvents = porterEvents(entry);
    if (nestedEvents.length > 0) return nestedEvents;

    const message = entry.message;
    const usage = normalizeUsage(message.usage);
    const timestamp = entryTimestamp(entry, message.timestamp);
    if (!usage || timestamp === null) return [];

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

  if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
    const usage = normalizeUsage(entry.usage);
    const timestamp = entryTimestamp(entry);
    if (!usage || timestamp === null) return [];

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
  const earliestStart = Math.min(
    ...Object.values(starts),
    ...TREND_KEYS.map((key) => trends[key][0]?.start ?? generatedAt),
  );
  let eventCount = 0;
  let deduplicatedEntries = 0;

  for (const entries of sessions) {
    for (const entry of entries) {
      for (const event of eventsFromEntry(entry)) {
        if (event.timestamp > generatedAt || event.timestamp < earliestStart) continue;
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
