import type { SessionReviewReport } from "./types.ts";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatReviewCost(cost: number): string {
  const digits = cost >= 1 ? 2 : cost >= 0.01 ? 3 : 4;
  return `$${cost.toFixed(digits)}`;
}

export function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function dateRange(report: Pick<SessionReviewReport, "cutoff" | "generatedAt">): string {
  const format = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${format.format(new Date(report.cutoff))} – ${format.format(new Date(report.generatedAt))}`;
}

export function sessionDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

export function successRate(success: number, failure: number): string {
  const decided = success + failure;
  return decided === 0
    ? "no decided outcomes"
    : `${Math.round((success / decided) * 100)}% success`;
}
