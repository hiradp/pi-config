import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { addLocalDays, addTotals, emptyTotals, totalTokens } from "./report.ts";
import {
  PERIOD_KEYS,
  TREND_KEYS,
  type PeriodUsage,
  type UsageBucket,
  type UsageCategory,
  type UsageReport,
  type UsageTotals,
  type UsageTrendKey,
} from "./types.ts";

interface DisplayUsageRow {
  label: string;
  totals?: UsageTotals;
  heading: boolean;
}

interface TableColumn {
  title: string;
  width: number;
  value: (totals: UsageTotals) => string;
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

export function displayRows(period: PeriodUsage): DisplayUsageRow[] {
  const categories: { category: UsageCategory; heading: string }[] = [
    { category: "primary", heading: "Primary models" },
    { category: "delegated", heading: "Delegated agents" },
    { category: "overhead", heading: "Session overhead" },
    { category: "tool", heading: "Tool usage" },
  ];

  // The report already orders models by usage, so each category keeps that order.
  return categories.flatMap(({ category, heading }) => {
    const rows = period.models
      .filter((item) => item.category === category)
      .map((item): DisplayUsageRow => {
        const identity = [item.provider, item.model].filter(Boolean).join(" / ");
        const label = item.source
          ? identity
            ? `${item.source} · ${identity}`
            : item.source
          : identity;
        return { label: `  ${label}`, totals: item, heading: false };
      });

    return rows.length > 0 ? [{ label: heading, heading: true }, ...rows] : [];
  });
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
  const label = fitCell(row?.label ?? "Source", labelWidth);
  const labelText = row?.heading
    ? theme.fg("accent", theme.bold(label))
    : theme.fg(row ? "text" : "muted", label);
  const values = columns.map((column) => {
    const value = row?.totals ? column.value(row.totals) : row ? "" : column.title;
    const cell = fitCell(value, column.width, true);
    if (!row) return theme.fg("muted", cell);
    return theme.fg("dim", cell);
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

type UsageViewMode = "summary" | "trend";
type TrendMetric = "tokens" | "cost";

function scanDetails(report: UsageReport): string {
  const details = [`${report.sessionCount} sessions`, `${report.eventCount} usage records`];
  if (report.deduplicatedEntries > 0) {
    details.push(`${report.deduplicatedEntries} copied records deduplicated`);
  }
  if (report.skippedFiles > 0) {
    details.push(`${report.skippedFiles} unreadable files skipped`);
  }
  return details.join(" · ");
}

function trendValue(totals: UsageTotals, metric: TrendMetric): number {
  return metric === "tokens" ? totalTokens(totals) : totals.cost;
}

function trendBucketLabel(bucket: UsageBucket, key: UsageTrendKey): string {
  const start = new Date(bucket.start);
  if (key === "daily7") {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(start);
  }

  const end = new Date(addLocalDays(bucket.endExclusive, -1));
  const date = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  const startLabel = date.format(start);
  const endLabel = date.format(end);
  return startLabel === endLabel ? startLabel : `${startLabel}–${endLabel}`;
}

function trendRange(buckets: readonly UsageBucket[], generatedAt: number): string {
  const start = buckets[0]?.start ?? generatedAt;
  const date = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${date.format(new Date(start))} – ${date.format(new Date(generatedAt))}`;
}

function chartBar(value: number, maximum: number, width: number, theme: Theme): string {
  if (width <= 0) return "";
  if (value <= 0 || maximum <= 0) return " ".repeat(width);

  const scaled = Math.min(width, (value / maximum) * width);
  let fullBlocks = Math.floor(scaled);
  let fraction = "";
  if (fullBlocks < width) {
    const fractions = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
    let fractionIndex = Math.floor((scaled - fullBlocks) * 8);
    if (fullBlocks === 0 && fractionIndex === 0) fractionIndex = 1;
    fraction = fractions[fractionIndex] ?? "";
  } else {
    fullBlocks = width;
  }

  const filled = "█".repeat(fullBlocks) + fraction;
  return theme.fg("accent", filled) + " ".repeat(Math.max(0, width - visibleWidth(filled)));
}

function chartLine(
  bucket: UsageBucket,
  key: UsageTrendKey,
  metric: TrendMetric,
  maximum: number,
  width: number,
  theme: Theme,
): string {
  const label = trendBucketLabel(bucket, key);
  const tokenText = formatTokenCount(totalTokens(bucket.totals));
  const costText = formatUsageCost(bucket.totals.cost);
  let showBothValues = true;
  let valueWidth = visibleWidth(`${tokenText}  ${costText}`);
  const idealLabelWidth = key === "daily7" ? 14 : 19;
  const labelWidth = Math.min(idealLabelWidth, Math.max(6, Math.floor(width * 0.3)));
  let barWidth = width - labelWidth - valueWidth - 4;

  if (barWidth < 3) {
    showBothValues = false;
    valueWidth = visibleWidth(metric === "tokens" ? tokenText : costText);
    barWidth = width - labelWidth - valueWidth - 4;
  }

  const values = showBothValues
    ? theme.fg("text", tokenText) + theme.fg("dim", "  ") + theme.fg("accent", costText)
    : theme.fg(metric === "tokens" ? "text" : "accent", metric === "tokens" ? tokenText : costText);

  if (barWidth < 1) {
    const compactLabelWidth = Math.max(1, width - valueWidth - 1);
    return theme.fg("muted", fitCell(label, compactLabelWidth)) + " " + values;
  }

  return (
    theme.fg("muted", fitCell(label, labelWidth)) +
    "  " +
    chartBar(trendValue(bucket.totals, metric), maximum, barWidth, theme) +
    "  " +
    values
  );
}

export class UsageView implements Component {
  private view: UsageViewMode = "summary";
  private periodIndex = 0;
  private trendIndex = 0;
  private metric: TrendMetric = "tokens";
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
    if (matchesKey(data, Key.tab) || matchesKey(data, "g")) {
      this.view = this.view === "summary" ? "trend" : "summary";
      changed = true;
    } else if (matchesKey(data, "m") && this.view === "trend") {
      this.metric = this.metric === "tokens" ? "cost" : "tokens";
      changed = true;
    } else if (matchesKey(data, Key.left)) {
      if (this.view === "summary") {
        this.periodIndex = (this.periodIndex + PERIOD_KEYS.length - 1) % PERIOD_KEYS.length;
        this.offset = 0;
      } else {
        this.trendIndex = (this.trendIndex + TREND_KEYS.length - 1) % TREND_KEYS.length;
      }
      changed = true;
    } else if (matchesKey(data, Key.right)) {
      if (this.view === "summary") {
        this.periodIndex = (this.periodIndex + 1) % PERIOD_KEYS.length;
        this.offset = 0;
      } else {
        this.trendIndex = (this.trendIndex + 1) % TREND_KEYS.length;
      }
      changed = true;
    } else if (matchesKey(data, "1")) {
      if (this.view === "summary") this.periodIndex = 0;
      else this.trendIndex = 0;
      this.offset = 0;
      changed = true;
    } else if (matchesKey(data, "2")) {
      if (this.view === "summary") this.periodIndex = 1;
      else this.trendIndex = 1;
      this.offset = 0;
      changed = true;
    } else if (matchesKey(data, "3") && this.view === "summary") {
      this.periodIndex = 2;
      this.offset = 0;
      changed = true;
    } else if (matchesKey(data, Key.up) && this.view === "summary") {
      this.offset = Math.max(0, this.offset - 1);
      changed = true;
    } else if (matchesKey(data, Key.down) && this.view === "summary") {
      this.offset = Math.min(this.maxOffset, this.offset + 1);
      changed = true;
    } else if (matchesKey(data, Key.pageUp) && this.view === "summary") {
      this.offset = Math.max(0, this.offset - this.pageSize);
      changed = true;
    } else if (matchesKey(data, Key.pageDown) && this.view === "summary") {
      this.offset = Math.min(this.maxOffset, this.offset + this.pageSize);
      changed = true;
    }

    if (changed) this.tui.requestRender();
  }

  render(width: number): string[] {
    const output = this.view === "summary" ? this.renderSummary(width) : this.renderTrend(width);
    return output.map((line) => truncateToWidth(line, width, ""));
  }

  private line(text: string, width: number): string {
    return truncateToWidth(` ${text}`, width, "");
  }

  private separator(width: number): string {
    return this.theme.fg("border", "─".repeat(Math.max(1, width)));
  }

  private tabs(labels: readonly string[], selected: number): string {
    return labels
      .map((label, index) =>
        index === selected
          ? this.theme.fg("accent", this.theme.bold(`[${label}]`))
          : this.theme.fg("muted", label),
      )
      .join(this.theme.fg("dim", "  "));
  }

  private viewTabs(): string {
    return this.tabs(["Summary", "Trend"], this.view === "summary" ? 0 : 1);
  }

  private renderSummary(width: number): string[] {
    const key = PERIOD_KEYS[this.periodIndex] ?? "day";
    const period = this.report.periods[key];
    const rows = displayRows(period);
    const innerWidth = Math.max(1, width - 2);
    const columns = tableColumns(innerWidth);
    const availableRows = Math.max(3, Math.min(20, this.tui.terminal.rows - 12));
    this.pageSize = availableRows;
    this.maxOffset = Math.max(0, rows.length - availableRows);
    this.offset = Math.min(this.offset, this.maxOffset);

    const periodTabs = this.tabs(["Today", "This week", "This month"], this.periodIndex);
    const cacheTokens = period.totals.cacheRead + period.totals.cacheWrite;
    const total =
      this.theme.fg("text", `${formatTokenCount(totalTokens(period.totals))} tokens`) +
      this.theme.fg("dim", " · ") +
      this.theme.fg("dim", `↑${formatTokenCount(period.totals.input)}`) +
      this.theme.fg("dim", ` ↓${formatTokenCount(period.totals.output)}`) +
      this.theme.fg("dim", ` cache ${formatTokenCount(cacheTokens)}`) +
      this.theme.fg("dim", " · ") +
      this.theme.fg("accent", formatUsageCost(period.totals.cost));
    const output = [
      this.line(this.theme.fg("accent", this.theme.bold("Token usage and cost")), width),
      this.line(this.viewTabs(), width),
      this.line(periodTabs, width),
      this.line(
        this.theme.fg("dim", `${formatRange(period, this.report.generatedAt)} · local time`),
        width,
      ),
      this.line(total, width),
      this.separator(width),
      this.line(tableLine(null, innerWidth, this.theme, columns), width),
    ];

    if (rows.length === 0) {
      output.push(this.line(this.theme.fg("muted", "No recorded usage for this period."), width));
    } else {
      for (const row of rows.slice(this.offset, this.offset + availableRows)) {
        output.push(this.line(tableLine(row, innerWidth, this.theme, columns), width));
      }
    }

    if (this.maxOffset > 0) {
      const first = this.offset + 1;
      const last = Math.min(rows.length, this.offset + availableRows);
      output.push(
        this.line(this.theme.fg("dim", `Rows ${first}–${last} of ${rows.length}`), width),
      );
    }

    output.push(
      this.separator(width),
      this.line(this.theme.fg("dim", scanDetails(this.report)), width),
      this.line(
        this.theme.fg("dim", "tab trend · ←/→ period · ↑/↓ scroll · enter/esc/q close"),
        width,
      ),
    );
    return output;
  }

  private renderTrend(width: number): string[] {
    const key = TREND_KEYS[this.trendIndex] ?? "daily7";
    const buckets = this.report.trends[key];
    const innerWidth = Math.max(1, width - 2);
    const totals = emptyTotals();
    for (const bucket of buckets) addTotals(totals, bucket.totals);
    const maximum = Math.max(0, ...buckets.map((bucket) => trendValue(bucket.totals, this.metric)));
    const rangeTabs = this.tabs(["7 days · daily", "30 days · weekly"], this.trendIndex);
    const metricTabs = this.tabs(["Tokens", "Cost"], this.metric === "tokens" ? 0 : 1);
    const controls = rangeTabs + this.theme.fg("dim", "   ·   ") + metricTabs;
    const days = key === "daily7" ? 7 : 30;
    const average =
      this.metric === "tokens"
        ? `${formatTokenCount(totalTokens(totals) / days)} tokens/day`
        : `${formatUsageCost(totals.cost / days)}/day`;
    const total =
      this.theme.fg("text", `${formatTokenCount(totalTokens(totals))} tokens`) +
      this.theme.fg("dim", " · ") +
      this.theme.fg("accent", formatUsageCost(totals.cost)) +
      this.theme.fg("dim", ` · avg ${average}`);
    const output = [
      this.line(this.theme.fg("accent", this.theme.bold("Token usage and cost")), width),
      this.line(this.viewTabs(), width),
      this.line(controls, width),
      this.line(
        this.theme.fg("dim", `${trendRange(buckets, this.report.generatedAt)} · local time`),
        width,
      ),
      this.line(total, width),
      this.separator(width),
    ];

    for (const bucket of buckets) {
      output.push(
        this.line(chartLine(bucket, key, this.metric, maximum, innerWidth, this.theme), width),
      );
    }

    output.push(
      this.separator(width),
      this.line(this.theme.fg("dim", scanDetails(this.report)), width),
      this.line(
        this.theme.fg("dim", "tab summary · ←/→ range · m metric · enter/esc/q close"),
        width,
      ),
    );
    return output;
  }

  invalidate(): void {}
}
