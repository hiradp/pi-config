import type { ReviewHunk, ReviewLine, ReviewLineKind, ReviewSnapshot } from "./types.ts";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export interface ParsedReview {
  files: ReviewSnapshot["files"];
  lines: ReviewLine[];
}

function parseHunkHeader(header: string): Omit<ReviewHunk, "lines"> | null {
  const match = header.match(HUNK_HEADER);
  if (!match) return null;
  return {
    index: 0,
    header,
    oldStart: Number(match[1]),
    oldLines: Number(match[2] ?? "1"),
    newStart: Number(match[3]),
    newLines: Number(match[4] ?? "1"),
  };
}

export function parseReviewSnapshot(snapshot: ReviewSnapshot): ParsedReview {
  const lines: ReviewLine[] = [];
  let nextLineId = 0;

  const files = snapshot.files.map((file, fileIndex) => {
    const hunks: ReviewHunk[] = [];
    let hunk: ReviewHunk | null = null;
    let oldLine = 0;
    let newLine = 0;

    const pushLine = (
      kind: ReviewLineKind,
      text: string,
      hunkIndex = -1,
      oldLineNumber: number | null = null,
      newLineNumber: number | null = null,
    ): void => {
      lines.push({
        id: nextLineId,
        fileIndex,
        hunkIndex,
        lineIndex: hunkIndex >= 0 ? lines.length : -1,
        kind,
        text,
        oldLine: oldLineNumber,
        newLine: newLineNumber,
      });
      nextLineId += 1;
    };

    pushLine("file", file.displayPath);

    const patchLines = file.patch.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    if (patchLines.at(-1) === "") patchLines.pop();

    for (const rawLine of patchLines) {
      if (rawLine.startsWith("diff --git ") || rawLine.startsWith("index ")) continue;
      if (rawLine.startsWith("similarity index ") || rawLine.startsWith("dissimilarity index ")) {
        continue;
      }

      if (rawLine.startsWith("--- ") || rawLine.startsWith("+++ ")) {
        pushLine("meta", rawLine);
        continue;
      }

      const parsedHunk = parseHunkHeader(rawLine);
      if (parsedHunk) {
        hunk = { ...parsedHunk, index: hunks.length, lines: [] };
        hunks.push(hunk);
        oldLine = parsedHunk.oldStart;
        newLine = parsedHunk.newStart;
        pushLine("hunk", rawLine, hunk.index);
        continue;
      }

      if (!hunk) {
        if (
          rawLine.startsWith("new file mode") ||
          rawLine.startsWith("deleted file mode") ||
          rawLine.startsWith("old mode") ||
          rawLine.startsWith("new mode") ||
          rawLine.startsWith("rename from ") ||
          rawLine.startsWith("rename to ")
        ) {
          pushLine("meta", rawLine);
        }
        continue;
      }

      if (rawLine.startsWith("\\")) {
        pushLine("no-newline", rawLine, hunk.index);
        continue;
      }

      const prefix = rawLine[0];
      if (prefix === "+") {
        pushLine("addition", rawLine.slice(1), hunk.index, null, newLine);
        newLine += 1;
      } else if (prefix === "-") {
        pushLine("removal", rawLine.slice(1), hunk.index, oldLine, null);
        oldLine += 1;
      } else if (rawLine.length > 0) {
        const text = prefix === " " ? rawLine.slice(1) : rawLine;
        pushLine("context", text, hunk.index, oldLine, newLine);
        oldLine += 1;
        newLine += 1;
      }
    }

    if (hunks.length === 0) {
      pushLine("meta", file.note ?? "No reviewable patch");
    }

    return { ...file, hunks };
  });

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.hunkIndex >= 0) {
      line.lineIndex = files[line.fileIndex]!.hunks[line.hunkIndex]!.lines.length;
      files[line.fileIndex]!.hunks[line.hunkIndex]!.lines.push(line);
    }
  }

  return { files, lines };
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function lineIsSelectable(line: ReviewLine | undefined): line is ReviewLine {
  return (
    line !== undefined &&
    line.hunkIndex >= 0 &&
    (line.kind === "context" || line.kind === "addition" || line.kind === "removal")
  );
}

export function commentLocation(
  snapshot: ParsedReview,
  line: ReviewLine,
): { file: string; side: string; range: string } {
  const file = snapshot.files[line.fileIndex]?.displayPath ?? "(unknown file)";
  if (line.kind === "addition") return { file, side: "new", range: `${line.newLine}` };
  if (line.kind === "removal") return { file, side: "old", range: `${line.oldLine}` };
  return { file, side: "context", range: `${line.oldLine ?? "?"}/${line.newLine ?? "?"}` };
}
