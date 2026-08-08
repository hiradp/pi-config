import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import {
  BorderedLoader,
  parseSessionEntries,
  SessionManager,
  type ExtensionAPI,
  type SessionEntry,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

const PERIOD_KEYS = ["day", "week", "month"] as const;
const UNATTRIBUTED_PROVIDER = "Unattributed";
const UNATTRIBUTED_MODEL = "Tools / summaries";

export type UsagePeriodKey = (typeof PERIOD_KEYS)[number];

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface ModelUsage extends UsageTotals {
  provider: string;
  model: string;
}

export interface PeriodUsage {
  key: UsagePeriodKey;
  start: number;
  totals: UsageTotals;
  models: ModelUsage[];
}

export interface UsageReport {
  generatedAt: number;
  sessionCount: number;
  skippedFiles: number;
  eventCount: number;
  deduplicatedEntries: number;
  periods: Record<UsagePeriodKey, PeriodUsage>;
}

interface UsageEvent {
  timestamp: number;
  provider: string;
  model: string;
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

interface DisplayUsageRow {
  label: string;
  totals: UsageTotals;
  provider: boolean;
}

interface TableColumn {
  title: string;
  width: number;
  value: (totals: UsageTotals) => string;
}

function emptyTotals(): UsageTotals {
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

function addTotals(target: UsageTotals, source: UsageTotals): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.cost += source.cost;
}

function totalTokens(totals: UsageTotals): number {
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

function eventFromEntry(entry: SessionEntry): UsageEvent | null {
  if (entry.type === "message" && entry.message.role === "assistant") {
    const message = entry.message;
    const usage = normalizeUsage(message.usage);
    const timestamp = entryTimestamp(entry, message.timestamp);
    if (!usage || timestamp === null) return null;

    const provider = message.provider || "Unknown";
    const model = message.responseModel || message.model || "unknown";
    return {
      timestamp,
      provider,
      model,
      usage,
      fingerprint: fingerprint([
        "assistant",
        entry.timestamp,
        message.timestamp,
        message.responseId,
        provider,
        message.model,
        message.responseModel,
        message.usage,
        message.content,
      ]),
    };
  }

  if (entry.type === "message" && entry.message.role === "toolResult") {
    const message = entry.message;
    const usage = normalizeUsage(message.usage);
    const timestamp = entryTimestamp(entry, message.timestamp);
    if (!usage || timestamp === null) return null;

    return {
      timestamp,
      provider: UNATTRIBUTED_PROVIDER,
      model: UNATTRIBUTED_MODEL,
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
    };
  }

  if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
    const usage = normalizeUsage(entry.usage);
    const timestamp = entryTimestamp(entry);
    if (!usage || timestamp === null) return null;

    return {
      timestamp,
      provider: UNATTRIBUTED_PROVIDER,
      model: UNATTRIBUTED_MODEL,
      usage,
      fingerprint: fingerprint([entry.type, entry.timestamp, entry.usage, entry.summary]),
    };
  }

  return null;
}

function periodStarts(now: Date): Record<UsagePeriodKey, number> {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);

  const week = new Date(day);
  week.setDate(week.getDate() - ((week.getDay() + 6) % 7));

  const month = new Date(day);
  month.setDate(1);

  return { day: day.getTime(), week: week.getTime(), month: month.getTime() };
}

function mutablePeriod(key: UsagePeriodKey, start: number): MutablePeriodUsage {
  return { key, start, totals: emptyTotals(), models: new Map() };
}

function addEvent(period: MutablePeriodUsage, event: UsageEvent): void {
  addTotals(period.totals, event.usage);

  const modelKey = JSON.stringify([event.provider, event.model]);
  let model = period.models.get(modelKey);
  if (!model) {
    model = { provider: event.provider, model: event.model, ...emptyTotals() };
    period.models.set(modelKey, model);
  }
  addTotals(model, event.usage);
}

function compareUsage(a: UsageTotals, b: UsageTotals): number {
  return b.cost - a.cost || totalTokens(b) - totalTokens(a);
}

function finalizePeriod(period: MutablePeriodUsage): PeriodUsage {
  const models = [...period.models.values()].sort(
    (a, b) =>
      compareUsage(a, b) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
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
  const mutablePeriods: Record<UsagePeriodKey, MutablePeriodUsage> = {
    day: mutablePeriod("day", starts.day),
    week: mutablePeriod("week", starts.week),
    month: mutablePeriod("month", starts.month),
  };
  const seen = new Set<string>();
  const earliestStart = Math.min(...Object.values(starts));
  let eventCount = 0;
  let deduplicatedEntries = 0;

  for (const entries of sessions) {
    for (const entry of entries) {
      const event = eventFromEntry(entry);
      if (!event || event.timestamp > generatedAt || event.timestamp < earliestStart) continue;
      if (seen.has(event.fingerprint)) {
        deduplicatedEntries++;
        continue;
      }

      seen.add(event.fingerprint);
      eventCount++;
      for (const key of PERIOD_KEYS) {
        if (event.timestamp >= starts[key]) addEvent(mutablePeriods[key], event);
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

export function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return Math.round(tokens).toString();
  if (tokens < 1_000_000) {
    const digits = tokens >= 100_000 ? 0 : 1;
    return `${(tokens / 1_000).toFixed(digits)}k`;
  }
  if (tokens < 1_000_000_000) {
    const digits = tokens >= 100_000_000 ? 0 : tokens >= 10_000_000 ? 1 : 2;
    return `${(tokens / 1_000_000).toFixed(digits)}M`;
  }
  return `${(tokens / 1_000_000_000).toFixed(2)}B`;
}

export function formatUsageCost(cost: number): string {
  const digits = cost >= 1 ? 2 : cost >= 0.01 ? 3 : 4;
  return `$${cost.toFixed(digits)}`;
}

function displayRows(period: PeriodUsage): DisplayUsageRow[] {
  const providers = new Map<string, { totals: UsageTotals; models: ModelUsage[] }>();
  for (const model of period.models) {
    let provider = providers.get(model.provider);
    if (!provider) {
      provider = { totals: emptyTotals(), models: [] };
      providers.set(model.provider, provider);
    }
    addTotals(provider.totals, model);
    provider.models.push(model);
  }

  return [...providers.entries()]
    .sort(
      ([nameA, a], [nameB, b]) => compareUsage(a.totals, b.totals) || nameA.localeCompare(nameB),
    )
    .flatMap(([provider, data]) => [
      { label: provider, totals: data.totals, provider: true },
      ...data.models
        .sort((a, b) => compareUsage(a, b) || a.model.localeCompare(b.model))
        .map((model) => ({ label: `  ${model.model}`, totals: model, provider: false })),
    ]);
}

function fitCell(value: string, width: number, alignRight = false): string {
  const clipped = truncateToWidth(value, Math.max(0, width), "…");
  const padding = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  return alignRight ? padding + clipped : clipped + padding;
}

function tableColumns(width: number): TableColumn[] {
  const tokenColumn = (title: string, value: (totals: UsageTotals) => number): TableColumn => ({
    title,
    width: 9,
    value: (totals) => formatTokenCount(value(totals)),
  });
  const costColumn: TableColumn = {
    title: "Cost",
    width: 10,
    value: (totals) => formatUsageCost(totals.cost),
  };

  if (width >= 94) {
    return [
      tokenColumn("Input", (totals) => totals.input),
      tokenColumn("Output", (totals) => totals.output),
      tokenColumn("Cache R", (totals) => totals.cacheRead),
      tokenColumn("Cache W", (totals) => totals.cacheWrite),
      tokenColumn("Total", totalTokens),
      costColumn,
    ];
  }
  if (width >= 66) {
    return [
      tokenColumn("Input", (totals) => totals.input),
      tokenColumn("Output", (totals) => totals.output),
      tokenColumn("Cache", (totals) => totals.cacheRead + totals.cacheWrite),
      tokenColumn("Total", totalTokens),
      costColumn,
    ];
  }
  if (width >= 32) return [tokenColumn("Total", totalTokens), costColumn];
  if (width >= 20) return [tokenColumn("Total", totalTokens)];
  return [];
}

function tableLine(
  row: DisplayUsageRow | null,
  width: number,
  theme: Theme,
  columns: TableColumn[],
): string {
  const gap = "  ";
  const numericWidth = columns.reduce((sum, column) => sum + column.width, 0);
  const labelWidth = Math.max(1, width - numericWidth - gap.length * columns.length);
  const label = fitCell(row?.label ?? "Provider / model", labelWidth);
  const labelText = row?.provider
    ? theme.fg("accent", theme.bold(label))
    : theme.fg(row ? "text" : "muted", label);
  const values = columns.map((column) => {
    const value = row ? column.value(row.totals) : column.title;
    const cell = fitCell(value, column.width, true);
    if (!row) return theme.fg("muted", cell);
    return theme.fg(row.provider ? "accent" : "dim", row.provider ? theme.bold(cell) : cell);
  });
  return labelText + values.map((value) => gap + value).join("");
}

function formatRange(period: PeriodUsage, generatedAt: number): string {
  const start = new Date(period.start);
  const end = new Date(generatedAt);
  const date = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  if (period.key === "day") return date.format(start);
  return `${date.format(start)} – ${date.format(end)}`;
}

class UsageView implements Component {
  private periodIndex = 0;
  private offset = 0;
  private pageSize = 1;
  private maxOffset = 0;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly report: UsageReport;
  private readonly close: () => void;

  constructor(tui: TUI, theme: Theme, report: UsageReport, close: () => void) {
    this.tui = tui;
    this.theme = theme;
    this.report = report;
    this.close = close;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, "q")) {
      this.close();
      return;
    }

    let changed = false;
    if (matchesKey(data, Key.left)) {
      this.periodIndex = (this.periodIndex + PERIOD_KEYS.length - 1) % PERIOD_KEYS.length;
      this.offset = 0;
      changed = true;
    } else if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      this.periodIndex = (this.periodIndex + 1) % PERIOD_KEYS.length;
      this.offset = 0;
      changed = true;
    } else if (matchesKey(data, "1")) {
      this.periodIndex = 0;
      this.offset = 0;
      changed = true;
    } else if (matchesKey(data, "2")) {
      this.periodIndex = 1;
      this.offset = 0;
      changed = true;
    } else if (matchesKey(data, "3")) {
      this.periodIndex = 2;
      this.offset = 0;
      changed = true;
    } else if (matchesKey(data, Key.up)) {
      this.offset = Math.max(0, this.offset - 1);
      changed = true;
    } else if (matchesKey(data, Key.down)) {
      this.offset = Math.min(this.maxOffset, this.offset + 1);
      changed = true;
    } else if (matchesKey(data, Key.pageUp)) {
      this.offset = Math.max(0, this.offset - this.pageSize);
      changed = true;
    } else if (matchesKey(data, Key.pageDown)) {
      this.offset = Math.min(this.maxOffset, this.offset + this.pageSize);
      changed = true;
    }

    if (changed) this.tui.requestRender();
  }

  render(width: number): string[] {
    const key = PERIOD_KEYS[this.periodIndex] ?? "day";
    const period = this.report.periods[key];
    const rows = displayRows(period);
    const innerWidth = Math.max(1, width - 2);
    const columns = tableColumns(innerWidth);
    const availableRows = Math.max(3, Math.min(20, this.tui.terminal.rows - 11));
    this.pageSize = availableRows;
    this.maxOffset = Math.max(0, rows.length - availableRows);
    this.offset = Math.min(this.offset, this.maxOffset);

    const line = (text: string) => truncateToWidth(` ${text}`, width, "");
    const tabs = PERIOD_KEYS.map((periodKey, index) => {
      const label = { day: "Today", week: "This week", month: "This month" }[periodKey];
      return index === this.periodIndex
        ? this.theme.fg("accent", this.theme.bold(`[${label}]`))
        : this.theme.fg("muted", label);
    }).join(this.theme.fg("dim", "  "));
    const cacheTokens = period.totals.cacheRead + period.totals.cacheWrite;
    const total =
      this.theme.fg("text", `${formatTokenCount(totalTokens(period.totals))} tokens`) +
      this.theme.fg("dim", " · ") +
      this.theme.fg("dim", `↑${formatTokenCount(period.totals.input)}`) +
      this.theme.fg("dim", ` ↓${formatTokenCount(period.totals.output)}`) +
      this.theme.fg("dim", ` cache ${formatTokenCount(cacheTokens)}`) +
      this.theme.fg("dim", " · ") +
      this.theme.fg("accent", formatUsageCost(period.totals.cost));
    const separator = this.theme.fg("border", "─".repeat(Math.max(1, width)));
    const output = [
      line(this.theme.fg("accent", this.theme.bold("Token usage and cost"))),
      line(tabs),
      line(this.theme.fg("dim", `${formatRange(period, this.report.generatedAt)} · local time`)),
      line(total),
      separator,
      line(tableLine(null, innerWidth, this.theme, columns)),
    ];

    if (rows.length === 0) {
      output.push(line(this.theme.fg("muted", "No recorded usage for this period.")));
    } else {
      for (const row of rows.slice(this.offset, this.offset + availableRows)) {
        output.push(line(tableLine(row, innerWidth, this.theme, columns)));
      }
    }

    if (this.maxOffset > 0) {
      const first = this.offset + 1;
      const last = Math.min(rows.length, this.offset + availableRows);
      output.push(line(this.theme.fg("dim", `Rows ${first}–${last} of ${rows.length}`)));
    }

    const scanDetails = [
      `${this.report.sessionCount} sessions`,
      `${this.report.eventCount} usage records`,
    ];
    if (this.report.deduplicatedEntries > 0) {
      scanDetails.push(`${this.report.deduplicatedEntries} copied records deduplicated`);
    }
    if (this.report.skippedFiles > 0) {
      scanDetails.push(`${this.report.skippedFiles} unreadable files skipped`);
    }

    output.push(
      separator,
      line(this.theme.fg("dim", scanDetails.join(" · "))),
      line(this.theme.fg("dim", "←/→ period · ↑/↓ scroll · enter/esc/q close")),
    );
    return output.map((outputLine) => truncateToWidth(outputLine, width, ""));
  }

  invalidate(): void {}
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("usage", {
    description: "Show daily, weekly, and monthly token usage and cost",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI)
          ctx.ui.notify("The usage report is available in interactive mode.", "warning");
        return;
      }

      type LoadResult = { report: UsageReport } | { error: unknown } | null;
      const result = await ctx.ui.custom<LoadResult>((tui, theme, _keybindings, done) => {
        const loader = new BorderedLoader(tui, theme, "Reading Pi session usage…", {
          cancellable: true,
        });
        let settled = false;
        const finish = (value: LoadResult) => {
          if (settled) return;
          settled = true;
          done(value);
        };
        loader.onAbort = () => finish(null);

        void loadUsageReport({
          currentSessionFile: ctx.sessionManager.getSessionFile(),
          currentEntries: ctx.sessionManager.getEntries(),
          signal: loader.signal,
        }).then(
          (report) => finish({ report }),
          (error) => finish({ error }),
        );
        return loader;
      });

      if (result === null) return;
      if ("error" in result) {
        ctx.ui.notify(`Could not load usage: ${errorMessage(result.error)}`, "error");
        return;
      }

      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          new UsageView(tui, theme, result.report, () => done(undefined)),
      );
    },
  });
}
