import type { SessionEntry, SessionInfo } from "@earendil-works/pi-coding-agent";

export type SessionCategory = "work" | "personal" | "unclear";
export type SessionOutcome = "success" | "failure" | "unclear";
export type ReviewConfidence = "low" | "medium" | "high";

export interface RepositoryInfo {
  name: string;
  path: string;
}

export interface LoadedSession {
  info: SessionInfo;
  entries: SessionEntry[];
}

export interface PreparedSession {
  id: string;
  path: string;
  name?: string;
  firstMessage: string;
  created: number;
  modified: number;
  repositories: RepositoryInfo[];
  evidence: string;
  cost: number;
  categoryOverride?: Exclude<SessionCategory, "unclear">;
}

export interface SessionAssessment {
  id: string;
  tagline: string;
  summary: string;
  outcome: SessionOutcome;
  outcomeConfidence: ReviewConfidence;
  outcomeReason: string;
  category: SessionCategory;
  categoryConfidence: ReviewConfidence;
  categoryReason: string;
}

export interface ReviewedSession extends PreparedSession, SessionAssessment {}

export interface SessionReviewReport {
  generatedAt: number;
  cutoff: number;
  days: number;
  sessions: ReviewedSession[];
  generationCost: number;
  analysisWarning?: string;
  skippedFiles: number;
}

export interface ClassificationConfig {
  work: string[];
  personal: string[];
}

export interface CategoryStats {
  category: SessionCategory;
  count: number;
  cost: number;
  success: number;
  failure: number;
  unclear: number;
}
