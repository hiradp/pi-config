import { diffWords } from "diff";
import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import type { ReviewFile, ReviewLine } from "./types.ts";

export interface DiffStyler {
  styleText(line: ReviewLine, text: string, opts?: { selected?: boolean }): string;
  clearCache(): void;
}

export interface DiffStyleTheme {
  fg(color: "toolDiffContext" | "accent" | "dim", text: string): string;
  bg(color: "toolSuccessBg" | "toolErrorBg", text: string): string;
}

export interface FileRowStyle {
  fg(
    color: "text" | "muted" | "dim" | "accent" | "success" | "warning" | "error",
    text: string,
  ): string;
  bg(color: "selectedBg", text: string): string;
  bold(text: string): string;
}

export function statusLetter(file: ReviewFile): string {
  switch (file.status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    default:
      return "M";
  }
}

export function fileRowStyle(
  file: ReviewFile,
  commentCount: number,
  selected: boolean,
  width: number,
  theme: FileRowStyle,
  pad: (text: string, width: number) => string,
): string {
  const statusColor =
    file.status === "added"
      ? "success"
      : file.status === "deleted"
        ? "error"
        : file.status === "renamed"
          ? "warning"
          : "accent";
  const marker = !file.reviewable
    ? theme.fg("dim", "○")
    : commentCount > 0
      ? theme.fg("warning", "●")
      : " ";
  const status = theme.fg(statusColor, statusLetter(file));
  const path = file.reviewable
    ? selected
      ? theme.fg("text", theme.bold(file.displayPath))
      : theme.fg("text", file.displayPath)
    : theme.fg("dim", file.displayPath);
  const meta = !file.reviewable
    ? theme.fg("dim", ` ${file.kind}`)
    : commentCount > 0
      ? theme.fg("muted", ` ${commentCount}`)
      : "";
  const row = pad(`${marker} ${status} ${path}${meta}`, width);
  return selected ? theme.bg("selectedBg", row) : row;
}

interface TextRange {
  start: number;
  end: number;
}

const MIN_PAIR_SIMILARITY = 0.45;

function groupChangeRuns(lines: ReviewLine[]): ReviewLine[][] {
  const runs: ReviewLine[][] = [];
  let current: ReviewLine[] = [];

  const flush = (): void => {
    if (current.length > 0) runs.push(current);
    current = [];
  };

  for (const line of lines) {
    if (line.kind === "addition" || line.kind === "removal") {
      current.push(line);
    } else {
      flush();
    }
  }
  flush();
  return runs;
}

function pairSimilarity(oldText: string, newText: string, commonLength: number): number {
  const oldLength = oldText.trim().length;
  const newLength = newText.trim().length;
  if (oldLength === 0 || newLength === 0) return oldLength === newLength ? 1 : 0;
  return commonLength / Math.max(oldLength, newLength);
}

function buildIntraLineRanges(lines: ReviewLine[]): Map<number, TextRange[]> {
  const rangesByLine = new Map<number, TextRange[]>();

  for (const run of groupChangeRuns(lines)) {
    const removed = run.filter((line) => line.kind === "removal");
    const added = run.filter((line) => line.kind === "addition");
    const pairs = Math.min(removed.length, added.length);

    for (let index = 0; index < pairs; index += 1) {
      const oldLine = removed[index]!;
      const newLine = added[index]!;
      const parts = diffWords(oldLine.text, newLine.text);
      const commonLength = parts.reduce(
        (sum, part) => (part.added || part.removed ? sum : sum + part.value.trim().length),
        0,
      );
      if (pairSimilarity(oldLine.text, newLine.text, commonLength) < MIN_PAIR_SIMILARITY) {
        continue;
      }

      const oldRanges: TextRange[] = [];
      const newRanges: TextRange[] = [];
      let oldPos = 0;
      let newPos = 0;
      let firstRemoved = true;
      let firstAdded = true;

      for (const part of parts) {
        if (part.removed) {
          const length = part.value.length;
          const leading = firstRemoved ? (part.value.match(/^\s*/)?.[0].length ?? 0) : 0;
          firstRemoved = false;
          if (length > leading) {
            oldRanges.push({ start: oldPos + leading, end: oldPos + length });
          }
          oldPos += length;
        } else if (part.added) {
          const length = part.value.length;
          const leading = firstAdded ? (part.value.match(/^\s*/)?.[0].length ?? 0) : 0;
          firstAdded = false;
          if (length > leading) {
            newRanges.push({ start: newPos + leading, end: newPos + length });
          }
          newPos += length;
        } else {
          oldPos += part.value.length;
          newPos += part.value.length;
        }
      }

      rangesByLine.set(oldLine.id, oldRanges);
      rangesByLine.set(newLine.id, newRanges);
    }
  }

  return rangesByLine;
}

const ANSI_SEQUENCE = /^\x1b\[[0-9;]*m/;
const INVERSE_ON = "\x1b[7m";
const INVERSE_OFF = "\x1b[27m";

/**
 * Apply inverse-video ranges to a string that may already contain ANSI codes.
 * Range offsets refer to visible text positions (ANSI codes are skipped).
 */
export function applyInverseRanges(text: string, ranges: TextRange[]): string {
  if (ranges.length === 0) return text;

  const boundaries = new Map<number, string[]>();
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    boundaries.set(range.start, [...(boundaries.get(range.start) ?? []), INVERSE_ON]);
    boundaries.set(range.end, [...(boundaries.get(range.end) ?? []), INVERSE_OFF]);
  }

  let output = "";
  let position = 0;
  let index = 0;
  const emitBoundary = (at: number): void => {
    const codes = boundaries.get(at);
    if (codes) output += codes.join("");
  };

  while (index < text.length) {
    emitBoundary(position);
    const ansi = ANSI_SEQUENCE.exec(text.slice(index));
    if (ansi) {
      output += ansi[0];
      index += ansi[0].length;
      continue;
    }
    output += text[index];
    index += 1;
    position += 1;
  }
  emitBoundary(position);
  return output;
}

export function createDiffStyler(files: ReviewFile[], theme: DiffStyleTheme): DiffStyler {
  const intraLineCache = new Map<number, Map<number, TextRange[]>>();
  const syntaxCache = new Map<number, Map<number, string>>();

  const intraLineRanges = (file: ReviewFile, fileIndex: number): Map<number, TextRange[]> => {
    const cached = intraLineCache.get(fileIndex);
    if (cached) return cached;
    const ranges = buildIntraLineRanges(file.hunks.flatMap((hunk) => hunk.lines));
    intraLineCache.set(fileIndex, ranges);
    return ranges;
  };

  const syntaxLines = (file: ReviewFile, fileIndex: number): Map<number, string> => {
    const cached = syntaxCache.get(fileIndex);
    if (cached) return cached;

    const map = new Map<number, string>();
    const lang = getLanguageFromPath(file.newPath ?? file.oldPath ?? "");
    if (!lang) {
      syntaxCache.set(fileIndex, map);
      return map;
    }

    for (const hunk of file.hunks) {
      const contentLines = hunk.lines.filter(
        (line) => line.kind === "context" || line.kind === "addition" || line.kind === "removal",
      );
      if (contentLines.length === 0) continue;

      try {
        const highlighted = highlightCode(contentLines.map((line) => line.text).join("\n"), lang);
        contentLines.forEach((line, index) => {
          if (highlighted[index] !== undefined) map.set(line.id, highlighted[index]!);
        });
      } catch {
        // Keep plain colors for this file if highlighting fails.
      }
    }

    syntaxCache.set(fileIndex, map);
    return map;
  };

  return {
    styleText(line, text, opts = {}) {
      const file = files[line.fileIndex];
      if (!file) return text;

      if (line.kind === "hunk") return theme.fg("accent", text);
      if (line.kind === "meta" || line.kind === "no-newline" || line.kind === "file") {
        return theme.fg("dim", text);
      }

      const highlighted = syntaxLines(file, line.fileIndex).get(line.id);

      if (line.kind === "addition" || line.kind === "removal") {
        const ranges = intraLineRanges(file, line.fileIndex).get(line.id) ?? [];
        const body = applyInverseRanges(highlighted ?? text, ranges);
        if (opts.selected) return body;
        return theme.bg(line.kind === "addition" ? "toolSuccessBg" : "toolErrorBg", body);
      }

      if (highlighted === undefined) return theme.fg("toolDiffContext", text);
      return highlighted;
    },

    clearCache() {
      intraLineCache.clear();
      syntaxCache.clear();
    },
  };
}
