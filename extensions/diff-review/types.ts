export type ReviewChangeStatus = "added" | "modified" | "deleted" | "renamed";
export type ReviewFileKind = "text" | "binary" | "too-large" | "error";
export type ReviewLineKind =
  | "file"
  | "hunk"
  | "meta"
  | "context"
  | "addition"
  | "removal"
  | "no-newline";

export interface ReviewFile {
  id: string;
  oldPath: string | null;
  newPath: string | null;
  displayPath: string;
  status: ReviewChangeStatus;
  kind: ReviewFileKind;
  reviewable: boolean;
  patch: string;
  hunks: ReviewHunk[];
  note?: string;
}

export interface ReviewHunk {
  index: number;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: ReviewLine[];
}

export interface ReviewLine {
  id: number;
  fileIndex: number;
  hunkIndex: number;
  lineIndex: number;
  kind: ReviewLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface ReviewSnapshot {
  repoRoot: string;
  baseRevision: string;
  head: string | null;
  fingerprint: string;
  files: ReviewFile[];
  skippedCount: number;
  truncated: boolean;
}

export type ReviewCommentTarget =
  | {
      type: "range";
      fileIndex: number;
      startLineIndex: number;
      endLineIndex: number;
    }
  | { type: "file"; fileIndex: number }
  | { type: "overall" };

export interface ReviewComment {
  id: string;
  target: ReviewCommentTarget;
  body: string;
  createdAt: number;
  updatedAt: number;
}
