import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import type {
  CategoryStats,
  ReviewedSession,
  SessionCategory,
  SessionReviewReport,
} from "./types.ts";

const CATEGORIES: SessionCategory[] = ["work", "personal", "unclear"];

export function formatReviewCost(cost: number): string {
  const digits = cost >= 1 ? 2 : cost >= 0.01 ? 3 : 4;
  return `$${cost.toFixed(digits)}`;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function sanitizeDisplayText(value: string): string {
  let result = "";
  let index = 0;
  const consumeControlString = (start: number): number => {
    let cursor = start;
    while (cursor < value.length) {
      const code = value.charCodeAt(cursor);
      if (code === 0x07 || code === 0x9c) return cursor + 1;
      if (code === 0x1b && value.charCodeAt(cursor + 1) === 0x5c) return cursor + 2;
      cursor++;
    }
    return cursor;
  };
  const consumeCsi = (start: number): number => {
    let cursor = start;
    while (cursor < value.length) {
      const code = value.charCodeAt(cursor++);
      if (code >= 0x40 && code <= 0x7e) break;
    }
    return cursor;
  };

  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) {
      const next = value.charCodeAt(index + 1);
      if (next === 0x5b) index = consumeCsi(index + 2);
      else if (next === 0x5d || next === 0x50 || next === 0x5f || next === 0x5e) {
        index = consumeControlString(index + 2);
      } else index += 2;
      continue;
    }
    if (code === 0x9b) {
      index = consumeCsi(index + 1);
      continue;
    }
    if (code === 0x90 || code === 0x9d || code === 0x9e || code === 0x9f) {
      index = consumeControlString(index + 1);
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      if (code === 0x09 || code === 0x0a || code === 0x0d) result += " ";
      index++;
      continue;
    }
    result += value[index];
    index++;
  }
  return result;
}

export function sortSessionsByCost(sessions: readonly ReviewedSession[]): ReviewedSession[] {
  return [...sessions].sort(
    (a, b) => b.cost - a.cost || b.modified - a.modified || a.tagline.localeCompare(b.tagline),
  );
}

export function categoryStats(sessions: readonly ReviewedSession[]): CategoryStats[] {
  return CATEGORIES.map((category) => {
    const matching = sessions.filter((session) => session.category === category);
    return {
      category,
      count: matching.length,
      cost: matching.reduce((sum, session) => sum + session.cost, 0),
      success: matching.filter((session) => session.outcome === "success").length,
      failure: matching.filter((session) => session.outcome === "failure").length,
      unclear: matching.filter((session) => session.outcome === "unclear").length,
    };
  });
}

function successRate(stats: CategoryStats): string {
  const decided = stats.success + stats.failure;
  return decided === 0 ? "— success" : `${Math.round((stats.success / decided) * 100)}% success`;
}

function localRange(report: SessionReviewReport): string {
  const format = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${format.format(new Date(report.cutoff))} – ${format.format(new Date(report.generatedAt))}`;
}

function sessionDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function plainWrapped(value: string, width: number): string[] {
  return wrapTextWithAnsi(sanitizeDisplayText(value), Math.max(1, width));
}

function outcomeMarker(session: ReviewedSession): string {
  if (session.outcome === "success") return "✓";
  if (session.outcome === "failure") return "✗";
  return "?";
}

function outcomeColor(session: ReviewedSession): "success" | "error" | "warning" {
  if (session.outcome === "success") return "success";
  if (session.outcome === "failure") return "error";
  return "warning";
}

function cardLines(session: ReviewedSession, width: number, theme: Theme): string[] {
  const innerWidth = Math.max(1, width - 2);
  const repositories =
    session.repositories.map((repo) => sanitizeDisplayText(repo.name)).join(", ") || "Unknown repo";
  const heading =
    theme.fg(outcomeColor(session), outcomeMarker(session)) +
    " " +
    theme.fg("text", theme.bold(sanitizeDisplayText(session.tagline)));
  const classification =
    theme.fg("accent", titleCase(session.category)) +
    theme.fg("dim", ` (${session.categoryConfidence}) · `) +
    theme.fg(outcomeColor(session), titleCase(session.outcome)) +
    theme.fg("dim", ` (${session.outcomeConfidence}) · `) +
    theme.fg("accent", formatReviewCost(session.cost));
  const metadata = theme.fg("muted", `${repositories} · ${sessionDate(session.modified)}`);
  const lines = [heading, `  ${classification}`, `  ${metadata}`];

  for (const line of plainWrapped(session.summary, Math.max(1, innerWidth - 2))) {
    lines.push(`  ${theme.fg("text", line)}`);
  }
  for (const line of plainWrapped(
    `Evidence: ${session.outcomeReason}`,
    Math.max(1, innerWidth - 2),
  )) {
    lines.push(`  ${theme.fg("dim", line)}`);
  }
  if (session.category === "unclear") {
    for (const line of plainWrapped(
      `Classification: ${session.categoryReason}`,
      Math.max(1, innerWidth - 2),
    )) {
      lines.push(`  ${theme.fg("dim", line)}`);
    }
  }
  lines.push("");
  return lines;
}

export class SessionReviewView implements Component {
  private offset = 0;
  private pageSize = 1;
  private maxOffset = 0;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly report: SessionReviewReport;
  private readonly close: () => void;

  constructor(tui: TUI, theme: Theme, report: SessionReviewReport, close: () => void) {
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

    const previous = this.offset;
    if (matchesKey(data, Key.up)) this.offset = Math.max(0, this.offset - 1);
    else if (matchesKey(data, Key.down)) this.offset = Math.min(this.maxOffset, this.offset + 1);
    else if (matchesKey(data, Key.pageUp)) this.offset = Math.max(0, this.offset - this.pageSize);
    else if (matchesKey(data, Key.pageDown)) {
      this.offset = Math.min(this.maxOffset, this.offset + this.pageSize);
    } else if (matchesKey(data, Key.home)) this.offset = 0;
    else if (matchesKey(data, Key.end)) this.offset = this.maxOffset;

    if (this.offset !== previous) this.tui.requestRender();
  }

  render(width: number): string[] {
    const totalCost = this.report.sessions.reduce((sum, session) => sum + session.cost, 0);
    const successful = this.report.sessions.filter(
      (session) => session.outcome === "success",
    ).length;
    const failed = this.report.sessions.filter((session) => session.outcome === "failure").length;
    const unclear = this.report.sessions.length - successful - failed;
    const stats = categoryStats(this.report.sessions);
    const header = [
      this.theme.fg("accent", this.theme.bold(" Session review")),
      this.theme.fg(
        "dim",
        ` ${localRange(this.report)} · trailing ${this.report.days} days · local time`,
      ),
      ` ${this.theme.fg("text", `${this.report.sessions.length} sessions`)}${this.theme.fg("dim", " · ")}${this.theme.fg("accent", `${formatReviewCost(totalCost)} recorded cost`)}`,
      ` ${this.theme.fg("success", `${successful} successful`)}${this.theme.fg("dim", " · ")}${this.theme.fg("error", `${failed} failed`)}${this.theme.fg("dim", " · ")}${this.theme.fg("warning", `${unclear} unclear`)}`,
      ...stats.map(
        (item) =>
          ` ${this.theme.fg(item.category === "unclear" ? "muted" : "accent", titleCase(item.category))}${this.theme.fg("dim", `: ${item.count} · ${formatReviewCost(item.cost)} · ${successRate(item)}`)}`,
      ),
      this.theme.fg("border", "─".repeat(Math.max(1, width))),
    ];

    const body = this.report.sessions.flatMap((session) => cardLines(session, width, this.theme));
    const warnings = [
      this.report.analysisWarning,
      this.report.skippedFiles > 0
        ? `${this.report.skippedFiles} unreadable session files skipped`
        : undefined,
      this.report.generationCost > 0
        ? `Report generation cost: ${formatReviewCost(this.report.generationCost)}`
        : undefined,
    ].filter((value): value is string => Boolean(value));
    const footer = [
      this.theme.fg("border", "─".repeat(Math.max(1, width))),
      ...(warnings.length > 0
        ? [this.theme.fg("warning", ` ${sanitizeDisplayText(warnings.join(" · "))}`)]
        : []),
      this.theme.fg(
        "dim",
        ` Cost excludes usage copied into forks/clones · ↑/↓ scroll · pgup/pgdn page · enter/esc/q close`,
      ),
    ];

    this.pageSize = Math.max(1, this.tui.terminal.rows - header.length - footer.length - 1);
    this.maxOffset = Math.max(0, body.length - this.pageSize);
    this.offset = Math.min(this.offset, this.maxOffset);
    return [...header, ...body.slice(this.offset, this.offset + this.pageSize), ...footer].map(
      (line) => truncateToWidth(line, width, ""),
    );
  }

  invalidate(): void {}
}
