import type { ReviewComment, ReviewCommentTarget, ReviewLine, ReviewSnapshot } from "./types.ts";

export interface ComposePromptInput {
  snapshot: ReviewSnapshot;
  comments: ReviewComment[];
  forced?: boolean;
}

function lineNumber(line: ReviewLine): number {
  return line.newLine ?? line.oldLine ?? 0;
}

function selectedRange(
  snapshot: ReviewSnapshot,
  target: Extract<ReviewCommentTarget, { type: "range" }>,
): {
  file: string;
  hunk: string;
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  lines: ReviewLine[];
} | null {
  const file = snapshot.files[target.fileIndex];
  if (!file) return null;

  const start = target.startLineIndex;
  const end = target.endLineIndex;
  const lines = file.hunks.flatMap((hunk) =>
    hunk.lines.filter((line) => {
      const globalIndex = line.id;
      const inSelection =
        globalIndex >= Math.min(start, end) && globalIndex <= Math.max(start, end);
      return (
        inSelection &&
        (line.kind === "context" || line.kind === "addition" || line.kind === "removal")
      );
    }),
  );

  if (lines.length === 0) return null;

  const oldLines = lines.filter((line) => line.oldLine !== null).map((line) => line.oldLine!);
  const newLines = lines.filter((line) => line.newLine !== null).map((line) => line.newLine!);
  const hunk = lines[0]
    ? file.hunks.find((candidate) => candidate.index === lines[0]!.hunkIndex)?.header
    : undefined;

  return {
    file: file.displayPath,
    hunk: hunk ?? "",
    oldStart: oldLines.length > 0 ? Math.min(...oldLines) : 0,
    oldEnd: oldLines.length > 0 ? Math.max(...oldLines) : 0,
    newStart: newLines.length > 0 ? Math.min(...newLines) : 0,
    newEnd: newLines.length > 0 ? Math.max(...newLines) : 0,
    lines,
  };
}

function formatLineRange(
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
): string {
  const oldRange = oldStart === oldEnd ? `${oldStart}` : `${oldStart}-${oldEnd}`;
  const newRange = newStart === newEnd ? `${newStart}` : `${newStart}-${newEnd}`;
  if (oldStart > 0 && newStart > 0) return `old ${oldRange} / new ${newRange}`;
  if (oldStart > 0) return `old line${oldStart === oldEnd ? "" : "s"} ${oldRange}`;
  return `new line${newStart === newEnd ? "" : "s"} ${newRange}`;
}

// A fence must be longer than any backtick run in the content, otherwise a
// context line of three backticks inside the selection ends the block early.
function codeFence(lines: string[]): string {
  let longest = 0;
  for (const line of lines) {
    for (const run of line.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

function commentSortKey(
  snapshot: ReviewSnapshot,
  comment: ReviewComment,
): [number, number, string] {
  if (comment.target.type === "overall") return [-1, 0, comment.id];
  if (comment.target.type === "file") {
    const file = snapshot.files[comment.target.fileIndex];
    return [comment.target.fileIndex, -1, file?.displayPath ?? ""];
  }

  const target = comment.target;
  const file = snapshot.files[target.fileIndex];
  const line = file?.hunks
    .flatMap((hunk) => hunk.lines)
    .find((candidate) => candidate.id === target.startLineIndex);
  return [target.fileIndex, lineNumber(line ?? ({} as ReviewLine)), file?.displayPath ?? ""];
}

export function composeReviewPrompt(input: ComposePromptInput): string {
  const { snapshot, comments, forced = false } = input;
  const sorted = [...comments].sort((a, b) => {
    const aKey = commentSortKey(snapshot, a);
    const bKey = commentSortKey(snapshot, b);
    return aKey[0] - bKey[0] || aKey[1] - bKey[1] || aKey[2].localeCompare(bKey[2]);
  });

  const overall = sorted.filter((comment) => comment.target.type === "overall");
  const specific = sorted.filter((comment) => comment.target.type !== "overall");
  const lines: string[] = [];

  lines.push("# Diff review");
  lines.push(`Repository: ${snapshot.repoRoot}`);
  lines.push(`Base: ${snapshot.baseRevision}`);
  lines.push(`Snapshot: ${snapshot.fingerprint.slice(0, 12)}`);
  lines.push(`Comments: ${specific.length}${overall.length > 0 ? " + overall note" : ""}`);
  if (forced) lines.push("Snapshot status: stale (written with :w!)");
  lines.push("");

  for (const comment of overall) {
    lines.push("## Overall note");
    lines.push("");
    lines.push(comment.body.trim());
    lines.push("");
  }

  lines.push("## Instructions");
  lines.push("");
  lines.push(
    "Address each review comment. Inspect the current files before editing. Answer questions directly instead of changing code unless the comment asks for a change.",
  );
  if (forced) {
    lines.push(
      "The diff changed after this review snapshot was captured. Use the selected code and paths to find the intended locations.",
    );
  }
  lines.push("");

  specific.forEach((comment, index) => {
    if (comment.target.type === "file") {
      const file = snapshot.files[comment.target.fileIndex];
      lines.push(`### ${index + 1}. ${file?.displayPath ?? "(unknown file)"} — whole file`);
      lines.push("");
      lines.push("Comment:");
      lines.push(comment.body.trim());
      lines.push("");
      return;
    }

    if (comment.target.type !== "range") return;
    const range = selectedRange(snapshot, comment.target);
    if (!range) {
      const file = snapshot.files[comment.target.fileIndex];
      lines.push(
        `### ${index + 1}. ${file?.displayPath ?? "(unknown file)"} — selected lines (location unavailable)`,
      );
      lines.push("");
      lines.push("Comment:");
      lines.push(comment.body.trim());
      lines.push("");
      return;
    }

    lines.push(
      `### ${index + 1}. ${range.file} — ${formatLineRange(range.oldStart, range.oldEnd, range.newStart, range.newEnd)}`,
    );
    lines.push("");
    if (range.hunk) lines.push(`Hunk: ${range.hunk}`);
    lines.push("");
    lines.push("Selected code:");
    const fence = codeFence(range.lines.map((line) => line.text));
    lines.push(`${fence}diff`);
    for (const line of range.lines) {
      const prefix = line.kind === "addition" ? "+" : line.kind === "removal" ? "-" : " ";
      lines.push(`${prefix}${line.text}`);
    }
    lines.push(fence);
    lines.push("");
    lines.push("Comment:");
    lines.push(comment.body.trim());
    lines.push("");
  });

  return lines.join("\n").trim();
}
