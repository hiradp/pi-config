import type { ReviewHunk, ReviewLine, ReviewLineKind, ReviewSnapshot } from "./types.ts";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// C0 and C1 controls other than tab. Left intact they reach the terminal,
// which measures them as zero-width and then acts on them: OSC clipboard
// writes, alternate-screen switches, BEL.
const CONTROL_CHARACTERS = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/g;

export interface ParsedReview {
  files: ReviewSnapshot["files"];
  lines: ReviewLine[];
}

// Show controls the way Vim does (^[ for escape, ^M for a carriage return) so
// they are visible in the review instead of acting on the terminal. Tabs are
// kept and expanded when rendered.
function sanitizeDisplayText(text: string): string {
  return text.replace(CONTROL_CHARACTERS, (character) => {
    const code = character.charCodeAt(0);
    if (code === 0x7f) return "^?";
    if (code < 0x20) return `^${String.fromCharCode(code + 0x40)}`;
    return `<${code.toString(16)}>`;
  });
}

function parseHunkHeader(header: string): Omit<ReviewHunk, "lines"> | null {
  const match = header.match(HUNK_HEADER);
  if (!match) return null;
  return {
    index: 0,
    header: sanitizeDisplayText(header),
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
        lineIndex: -1,
        kind,
        text: sanitizeDisplayText(text),
        oldLine: oldLineNumber,
        newLine: newLineNumber,
      });
      nextLineId += 1;
    };

    const displayPath = sanitizeDisplayText(file.displayPath);
    pushLine("file", displayPath);

    // Binary, oversized, and unreadable files carry at most a header patch;
    // show the reason instead of parsing what is left.
    if (!file.reviewable) {
      pushLine("meta", file.note ?? "No reviewable patch");
      return { ...file, displayPath, hunks };
    }

    // Git breaks lines on LF only: a trailing CR comes from CRLF content and
    // is dropped, while a CR inside a line is content and stays there.
    const patchLines = file.patch
      .split("\n")
      .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
    if (patchLines.at(-1) === "") patchLines.pop();

    for (const rawLine of patchLines) {
      // A type change emits a second section for the same file; its headers
      // must not be read as content of the previous hunk.
      if (rawLine.startsWith("diff --git ")) {
        hunk = null;
        continue;
      }
      if (rawLine.startsWith("index ")) continue;
      if (rawLine.startsWith("similarity index ") || rawLine.startsWith("dissimilarity index ")) {
        continue;
      }

      // Inside a hunk these are content: removing "-- foo" yields "--- foo".
      if (!hunk && (rawLine.startsWith("--- ") || rawLine.startsWith("+++ "))) {
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
      } else {
        // With diff.suppressBlankEmpty Git writes a blank context line as an
        // empty line instead of a single space; it still occupies a line.
        const text = prefix === " " ? rawLine.slice(1) : rawLine;
        pushLine("context", text, hunk.index, oldLine, newLine);
        oldLine += 1;
        newLine += 1;
      }
    }

    if (hunks.length === 0) {
      pushLine("meta", file.note ?? "No reviewable patch");
    }

    return { ...file, displayPath, hunks };
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
