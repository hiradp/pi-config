export const PERIOD_KEYS = ["day", "week", "month"] as const;
export const TREND_KEYS = ["daily7", "weekly30"] as const;

export type UsagePeriodKey = (typeof PERIOD_KEYS)[number];
export type UsageTrendKey = (typeof TREND_KEYS)[number];

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export type UsageCategory = "primary" | "delegated" | "overhead" | "tool";

export interface ModelUsage extends UsageTotals {
  category: UsageCategory;
  provider: string;
  model: string;
  source?: string;
}

export interface PeriodUsage {
  key: UsagePeriodKey;
  start: number;
  totals: UsageTotals;
  models: ModelUsage[];
}

export interface UsageBucket {
  start: number;
  endExclusive: number;
  totals: UsageTotals;
}

export interface UsageReport {
  generatedAt: number;
  sessionCount: number;
  skippedFiles: number;
  eventCount: number;
  deduplicatedEntries: number;
  periods: Record<UsagePeriodKey, PeriodUsage>;
  trends: Record<UsageTrendKey, UsageBucket[]>;
}
