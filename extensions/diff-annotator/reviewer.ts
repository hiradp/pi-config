import type { Component, Editor, Focusable, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import {
  Editor as TuiEditor,
  fuzzyFilter,
  Key,
  matchesKey,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { clamp, lineIsSelectable } from "./parser.ts";
import type { ParsedReview } from "./parser.ts";
import { createDiffStyler, fileRowStyle, type DiffStyler } from "./render.ts";
import type {
  ReviewComment,
  ReviewCommentTarget,
  ReviewFile,
  ReviewLine,
  ReviewSnapshot,
} from "./types.ts";

export type ReviewerMode = "normal" | "visual" | "insert" | "command" | "files" | "help";
export type ReviewerDoneResult = { action: "write"; force: boolean } | { action: "cancel" };

export interface ReviewerComponentOptions {
  snapshot: ReviewSnapshot;
  parsed: ParsedReview;
  height: number;
  comments: ReviewComment[];
}

interface SelectionState {
  anchor: number;
}

interface CommandState {
  input: string;
}

interface FilesState {
  query: string;
  selected: number;
}

interface HelpState {
  scroll: number;
}

interface CommentDraftState {
  commentId?: string;
  target: ReviewCommentTarget;
  original: string;
}

const PENDING_TIMEOUT_MS = 1000;
const HELP_LINES = [
  "Diff review keys",
  "",
  "Navigation",
  "  j/k            move one line",
  "  h/l            scroll horizontally",
  "  gg/G           first/last line",
  "  Ctrl-u/Ctrl-d  half page",
  "  [h / ]h        previous/next hunk",
  "  [f / ]f        previous/next file",
  "  [c / ]c        previous/next changed block",
  "  r              toggle relative line numbers",
  "  Ctrl-P or ,f   fuzzy file picker",
  "  ?              toggle this help",
  "",
  "Comments",
  "  v              visual-line selection",
  "  c              comment current line or visual selection",
  "  cc             comment current line",
  "  C              comment whole file",
  "  o              edit overall review note",
  "  Enter          edit comment on current line",
  "  dd             delete the line comment under the cursor",
  "                 (C and o comments are removed by saving them empty)",
  "",
  "Commands",
  "  :w             write comments to the Pi editor",
  "  :w!            write even if the working tree changed",
  "  :wq            alias for :w",
  "  :q             quit when there are no comments",
  "  :q!            discard comments and quit",
  "  :help          show this help (also: ?)",
  "",
  "File picker",
  "  Type to fuzzy-filter, j/k move, Enter jump, Esc close",
  "",
  "Comment editor",
  "  Enter inserts a newline",
  "  Esc saves a non-empty comment",
  "  Ctrl-c cancels the current edit",
  "",
  "Esc / Ctrl-c     cancel pending keys or a selection, else quit like :q",
] as const;

export function createCommentId(now = Date.now()): string {
  return `${now}:${Math.random().toString(36).slice(2, 10)}`;
}

function formatLineNumber(value: number | null): string {
  return value === null ? "".padStart(4, " ") : String(value).padStart(4, " ");
}

function formatRangeCount(count: number): string {
  return count === 0 ? "" : `${count} line${count === 1 ? "" : "s"}`;
}

function buildCommentTargetForLine(line: ReviewLine): ReviewCommentTarget {
  return {
    type: "range",
    fileIndex: line.fileIndex,
    startLineIndex: line.id,
    endLineIndex: line.id,
  };
}

function targetForSelection(lines: ReviewLine[], start: number, end: number): ReviewCommentTarget {
  const first = lines[Math.min(start, end)]!;
  return {
    type: "range",
    fileIndex: first.fileIndex,
    startLineIndex: Math.min(start, end),
    endLineIndex: Math.max(start, end),
  };
}

export function getCommentSummary(
  comment: ReviewComment,
  review: Pick<ReviewSnapshot, "files">,
): string {
  if (comment.target.type === "overall") return "Overall";
  const file = review.files[comment.target.fileIndex];
  if (comment.target.type === "file") return `${file?.displayPath ?? "(unknown)"} — file`;
  if (comment.target.type !== "range") return file?.displayPath ?? "(unknown)";
  const target = comment.target;

  const line = review.files
    .flatMap((candidate) => candidate.hunks)
    .flatMap((hunk) => hunk.lines)
    .find((candidate) => candidate.id === target.startLineIndex);
  if (!line) return `${file?.displayPath ?? "(unknown)"} — range`;
  const lineNumber = line.newLine ?? line.oldLine ?? 0;
  const lineCount = Math.abs(target.endLineIndex - target.startLineIndex) + 1;
  return `${file?.displayPath ?? "(unknown)"}:${lineNumber} · ${lineCount} lines`;
}

export class DiffReviewerComponent implements Component, Focusable {
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value;
  }

  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly done: (result: ReviewerDoneResult) => void;
  private readonly options: ReviewerComponentOptions;
  private readonly editor: Editor;
  private readonly styler: DiffStyler;

  private cursor = 0;
  private scroll = 0;
  private horizontal = 0;
  private mode: ReviewerMode = "normal";
  private visual: SelectionState | null = null;
  private command: CommandState = { input: "" };
  private files: FilesState = { query: "", selected: 0 };
  private help: HelpState = { scroll: 0 };
  private countBuffer = "";
  private relativeNumbers = true;
  private ordinals: Map<number, number> | null = null;
  private pending = "";
  private pendingAt = 0;
  private pendingCount = 1;
  private pendingHasCount = false;
  private status = "";
  private cachedWidth = -1;
  private cachedHeight = -1;
  private cachedLines: string[] = [];
  private draft: CommentDraftState | null = null;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (result: ReviewerDoneResult) => void,
    options: ReviewerComponentOptions,
  ) {
    this.tui = tui;
    this.theme = theme;
    void keybindings;
    this.done = done;
    this.options = options;
    this.editor = new TuiEditor(
      tui,
      {
        borderColor: (text) => this.theme.fg("accent", text),
        selectList: {
          selectedPrefix: (text) => this.theme.fg("accent", text),
          selectedText: (text) => this.theme.fg("accent", text),
          description: (text) => this.theme.fg("muted", text),
          scrollInfo: (text) => this.theme.fg("dim", text),
          noMatch: (text) => this.theme.fg("warning", text),
        },
      },
      { paddingX: 0 },
    );
    this.editor.disableSubmit = true;
    this.styler = createDiffStyler(options.snapshot.files, this.theme);
    this.cursor = this.firstSelectableIndex();
    this.status = "? for keys";
  }

  setHeight(height: number): void {
    if (this.options.height === height) return;
    this.options.height = Math.max(1, height);
    this.refresh();
  }

  private get lines(): ReviewLine[] {
    return this.options.parsed.lines;
  }

  private get comments(): ReviewComment[] {
    return this.options.comments;
  }

  invalidate(): void {
    this.cachedWidth = -1;
    this.cachedLines = [];
    this.styler.clearCache();
  }

  private refresh(): void {
    this.cachedWidth = -1;
    this.cachedLines = [];
    this.tui.requestRender();
  }

  private firstSelectableIndex(): number {
    return Math.max(
      0,
      this.lines.findIndex((line) => lineIsSelectable(line)),
    );
  }

  private firstSelectableInFileAtOrAfter(index: number): number {
    const fileIndex = this.lines[index]?.fileIndex;
    for (let candidate = index; candidate < this.lines.length; candidate += 1) {
      const line = this.lines[candidate]!;
      if (line.fileIndex !== fileIndex) break;
      if (lineIsSelectable(line)) return candidate;
    }
    return index;
  }

  private selectableIndices(): number[] {
    return this.lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => lineIsSelectable(line))
      .map(({ index }) => index);
  }

  private selectableOrdinal(lineId: number): number {
    if (!this.ordinals) {
      this.ordinals = new Map();
      let next = 0;
      for (const line of this.lines) {
        if (lineIsSelectable(line)) this.ordinals.set(line.id, next++);
      }
    }
    return this.ordinals.get(lineId) ?? 0;
  }

  private moveToSelectable(from: number, delta: number, count: number): void {
    const selectable = this.selectableIndices();
    if (selectable.length === 0) return;

    const current = selectable.reduce(
      (best, candidate) => (Math.abs(candidate - from) < Math.abs(best - from) ? candidate : best),
      selectable[0]!,
    );
    const position = Math.max(0, selectable.indexOf(current));
    const target = clamp(position + delta * count, 0, selectable.length - 1);
    this.cursor = selectable[target]!;
  }

  // Targets are buffer positions as shown in the footer; the cursor lands on
  // the nearest selectable line.
  private moveAbsolute(target: number): void {
    const selectable = this.selectableIndices();
    if (selectable.length === 0) return;
    const targetLine = clamp(target, 0, this.lines.length - 1);
    const nearest = selectable.reduce(
      (best, candidate) =>
        Math.abs(candidate - targetLine) < Math.abs(best - targetLine) ? candidate : best,
      selectable[0]!,
    );
    this.cursor = nearest;
  }

  private findMarker(kind: "hunk" | "file", direction: 1 | -1): number {
    const matches = (line: ReviewLine): boolean =>
      kind === "file" ? line.kind === "file" : line.kind === "hunk";

    if (direction === 1) {
      return this.lines.findIndex((line, index) => index > this.cursor && matches(line));
    }

    // Backward motions target the strictly previous container: the first header
    // above the cursor is the current container; the one before it is the goal.
    let skippedCurrent = false;
    for (let index = this.cursor - 1; index >= 0; index -= 1) {
      if (!matches(this.lines[index]!)) continue;
      if (!skippedCurrent) {
        skippedCurrent = true;
        continue;
      }
      return index;
    }
    return -1;
  }

  private moveToMarker(kind: "hunk" | "file", direction: 1 | -1, count: number): void {
    for (let iteration = 0; iteration < count; iteration += 1) {
      const candidate = this.findMarker(kind, direction);
      if (candidate < 0) break;
      this.cursor = this.firstSelectableInFileAtOrAfter(candidate);
    }
  }

  private isChange(index: number): boolean {
    const line = this.lines[index];
    return line !== undefined && (line.kind === "addition" || line.kind === "removal");
  }

  // A changed block is a run of consecutive added and removed lines; hunk and
  // file headers always separate runs.
  private startsChangedBlock(index: number): boolean {
    return this.isChange(index) && !this.isChange(index - 1);
  }

  private moveToChange(direction: 1 | -1, count: number): void {
    for (let iteration = 0; iteration < count; iteration += 1) {
      let candidate = -1;
      for (
        let index = this.cursor + direction;
        index >= 0 && index < this.lines.length;
        index += direction
      ) {
        if (this.startsChangedBlock(index)) {
          candidate = index;
          break;
        }
      }
      if (candidate < 0) break;
      this.cursor = candidate;
    }
  }

  private consumeCount(): number {
    const parsed = Number.parseInt(this.countBuffer, 10);
    this.countBuffer = "";
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }

  private clearPending(): void {
    this.pending = "";
    this.pendingAt = 0;
    this.pendingCount = 1;
    this.pendingHasCount = false;
  }

  private setPending(key: string, count: number, hasCount: boolean): void {
    this.pending = key;
    this.pendingAt = Date.now();
    this.pendingCount = count;
    this.pendingHasCount = hasCount;
  }

  private lineAtCursor(): ReviewLine | undefined {
    return this.lines[this.cursor];
  }

  private commentsForLine(line: ReviewLine): ReviewComment[] {
    return this.comments.filter((comment) => {
      if (comment.target.type !== "range") return false;
      const start = Math.min(comment.target.startLineIndex, comment.target.endLineIndex);
      const end = Math.max(comment.target.startLineIndex, comment.target.endLineIndex);
      return line.id >= start && line.id <= end;
    });
  }

  private commentsForFile(fileIndex: number): ReviewComment[] {
    return this.comments.filter(
      (comment) =>
        (comment.target.type === "range" || comment.target.type === "file") &&
        comment.target.fileIndex === fileIndex,
    );
  }

  private beginComment(target: ReviewCommentTarget, existing?: ReviewComment): void {
    this.clearPending();
    this.countBuffer = "";
    this.draft = {
      commentId: existing?.id,
      target,
      original: existing?.body ?? "",
    };
    this.mode = "insert";
    this.editor.setText(existing?.body ?? "");
    this.refresh();
  }

  private saveDraft(): void {
    if (!this.draft) return;
    const body = this.editor.getText().trim();
    this.editor.setText("");
    const now = Date.now();

    if (this.draft.commentId) {
      const existing = this.comments.find((comment) => comment.id === this.draft?.commentId);
      if (existing) {
        if (body) {
          existing.body = body;
          existing.updatedAt = now;
        } else {
          const index = this.comments.findIndex((comment) => comment.id === existing.id);
          if (index >= 0) this.comments.splice(index, 1);
        }
      }
    } else if (body) {
      this.comments.push({
        id: createCommentId(now),
        target: this.draft.target,
        body,
        createdAt: now,
        updatedAt: now,
      });
    }

    this.draft = null;
    this.mode = "normal";
    this.status = body ? "Comment saved" : "Comment removed";
    this.refresh();
  }

  private cancelDraft(): void {
    if (!this.draft) return;
    this.editor.setText(this.draft.original);
    this.draft = null;
    this.mode = "normal";
    this.status = "Comment edit cancelled";
    this.refresh();
  }

  private editCommentUnderCursor(): void {
    const line = this.lineAtCursor();
    if (!line) return;
    const comment = this.commentsForLine(line)[0];
    if (!comment) {
      this.status = "No comment under cursor";
      this.refresh();
      return;
    }
    this.beginComment(comment.target, comment);
  }

  private deleteCommentUnderCursor(): void {
    const line = this.lineAtCursor();
    if (!line) return;
    const candidates = this.commentsForLine(line).sort(
      (a, b) =>
        Math.abs(a.target.type === "range" ? a.target.startLineIndex - line.id : 0) -
        Math.abs(b.target.type === "range" ? b.target.startLineIndex - line.id : 0),
    );
    const comment = candidates[0];
    if (!comment) {
      this.status = "No comment under cursor";
      this.refresh();
      return;
    }
    const index = this.comments.findIndex((candidate) => candidate.id === comment.id);
    if (index >= 0) this.comments.splice(index, 1);
    this.status = "Comment deleted";
    this.refresh();
  }

  private startVisual(): void {
    const line = this.lineAtCursor();
    if (!lineIsSelectable(line)) return;
    this.mode = "visual";
    this.visual = { anchor: this.cursor };
    this.status = "";
    this.refresh();
  }

  private finishVisualComment(): boolean {
    const line = this.lineAtCursor();
    if (!line || !this.visual) return false;
    const anchorLine = this.lines[this.visual.anchor];
    if (
      !anchorLine ||
      anchorLine.fileIndex !== line.fileIndex ||
      anchorLine.hunkIndex !== line.hunkIndex
    ) {
      this.status = "Selection must stay within one hunk";
      this.refresh();
      return false;
    }
    const target = targetForSelection(this.lines, this.visual.anchor, this.cursor);
    this.beginComment(target);
    return true;
  }

  private fileAtCursor(): ReviewFile | undefined {
    const line = this.lineAtCursor();
    return line ? this.options.snapshot.files[line.fileIndex] : undefined;
  }

  private openFilesPicker(): void {
    this.clearPending();
    this.countBuffer = "";
    this.files = { query: "", selected: 0 };
    this.mode = "files";
    this.status = "";
    this.refresh();
  }

  private filteredFiles(): ReviewFile[] {
    const all = this.options.snapshot.files;
    if (!this.files.query.trim()) return all;
    return fuzzyFilter(all, this.files.query, (file) => file.displayPath);
  }

  private jumpToFile(file: ReviewFile): void {
    const fileIndex = this.options.snapshot.files.indexOf(file);
    if (fileIndex < 0) return;
    const headerIndex = this.lines.findIndex(
      (line) => line.kind === "file" && line.fileIndex === fileIndex,
    );
    if (headerIndex < 0) return;
    this.cursor = this.firstSelectableInFileAtOrAfter(headerIndex);
    this.mode = "normal";
    this.refresh();
  }

  private handleFilesInput(data: string): void {
    const filtered = this.filteredFiles();

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.mode = "normal";
      this.refresh();
      return;
    }

    if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) {
      this.files.selected = clamp(this.files.selected + 1, 0, Math.max(0, filtered.length - 1));
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) {
      this.files.selected = Math.max(0, this.files.selected - 1);
      this.refresh();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      const file = filtered[this.files.selected];
      if (file) this.jumpToFile(file);
      else {
        this.mode = "normal";
        this.refresh();
      }
      return;
    }

    if (matchesKey(data, Key.backspace)) {
      this.files.query = this.files.query.slice(0, -1);
      this.files.selected = 0;
      this.refresh();
      return;
    }

    if (data.length === 1 && data >= " ") {
      this.files.query += data;
      this.files.selected = 0;
      this.refresh();
    }
  }

  private overallTarget(): ReviewCommentTarget {
    return { type: "overall" };
  }

  private openOverallComment(): void {
    const existing = this.comments.find((comment) => comment.target.type === "overall");
    this.beginComment(this.overallTarget(), existing);
  }

  private openFileComment(): void {
    const file = this.fileAtCursor();
    if (!file) return;
    const fileIndex = this.options.snapshot.files.indexOf(file);
    const existing = this.comments.find(
      (comment) => comment.target.type === "file" && comment.target.fileIndex === fileIndex,
    );
    this.beginComment({ type: "file", fileIndex }, existing);
  }

  private enterCommand(): void {
    this.mode = "command";
    this.command = { input: "" };
    this.status = "";
    this.refresh();
  }

  private executeCommand(command: string): void {
    const normalized = command.trim().toLowerCase();
    this.command = { input: "" };
    this.mode = "normal";

    if (normalized === "w" || normalized === "wq") {
      if (this.comments.length === 0) {
        this.status = "No review comments to write";
        this.refresh();
        return;
      }
      this.done({ action: "write", force: false });
      return;
    }

    if (normalized === "w!") {
      this.done({ action: "write", force: true });
      return;
    }

    if (normalized === "q") {
      if (this.comments.length > 0) {
        this.status = "Comments present — use :q! to discard";
        this.refresh();
        return;
      }
      this.done({ action: "cancel" });
      return;
    }

    if (normalized === "q!") {
      this.done({ action: "cancel" });
      return;
    }

    if (normalized === "help" || normalized === "h") {
      this.mode = "help";
      this.help = { scroll: 0 };
      this.refresh();
      return;
    }

    this.status = `Unknown command: :${command}`;
    this.refresh();
  }

  private handleCommandInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.mode = "normal";
      this.command = { input: "" };
      this.refresh();
      return;
    }

    if (matchesKey(data, Key.backspace)) {
      this.command.input = this.command.input.slice(0, -1);
      this.refresh();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      this.executeCommand(this.command.input);
      return;
    }

    const printable = data.length === 1 && data >= " " ? data : undefined;
    if (printable) {
      this.command.input += printable;
      this.refresh();
    }
  }

  private handleHelpInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q" || data === "?") {
      this.mode = "normal";
      this.refresh();
      return;
    }

    const height = Math.max(1, this.options.height - 4);
    if (data === "j" || matchesKey(data, Key.down)) this.help.scroll += 1;
    else if (data === "k" || matchesKey(data, Key.up)) this.help.scroll -= 1;
    else if (matchesKey(data, Key.ctrl("d")))
      this.help.scroll += Math.max(1, Math.floor(height / 2));
    else if (matchesKey(data, Key.ctrl("u")))
      this.help.scroll -= Math.max(1, Math.floor(height / 2));
    this.help.scroll = clamp(this.help.scroll, 0, Math.max(0, HELP_LINES.length - height));
    this.refresh();
  }

  private handleDraftInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.saveDraft();
      return;
    }
    if (matchesKey(data, Key.ctrl("c"))) {
      this.cancelDraft();
      return;
    }
    // The editor's submit binding is disabled, so forward plain Enter as its
    // newline sequence instead of letting it be swallowed.
    if (matchesKey(data, Key.enter)) {
      this.editor.handleInput("\n");
      this.refresh();
      return;
    }
    this.editor.handleInput(data);
    this.refresh();
  }

  private handleNormalOrVisual(data: string): void {
    if (matchesKey(data, Key.ctrl("p"))) {
      this.openFilesPicker();
      return;
    }

    if (matchesKey(data, Key.down)) data = "j";
    else if (matchesKey(data, Key.up)) data = "k";
    else if (matchesKey(data, Key.left)) data = "h";
    else if (matchesKey(data, Key.right)) data = "l";

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      if (this.mode === "visual") {
        this.mode = "normal";
        this.visual = null;
        this.refresh();
        return;
      }
      const hadPending = this.pending !== "" && Date.now() - this.pendingAt <= PENDING_TIMEOUT_MS;
      const hadCount = this.countBuffer !== "";
      this.clearPending();
      this.countBuffer = "";
      if (hadPending || hadCount) {
        this.refresh();
        return;
      }
      // Quitting goes through the same guard as :q so a stray Esc never drops
      // comments; :q! remains the explicit discard.
      this.executeCommand("q");
      return;
    }

    if (matchesKey(data, Key.ctrl("d"))) {
      this.moveToSelectable(
        this.cursor,
        1,
        this.consumeCount() * Math.max(1, Math.floor(this.options.height / 2)),
      );
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.ctrl("u"))) {
      this.moveToSelectable(
        this.cursor,
        -1,
        this.consumeCount() * Math.max(1, Math.floor(this.options.height / 2)),
      );
      this.refresh();
      return;
    }

    if (data === "?") {
      this.mode = "help";
      this.help = { scroll: 0 };
      this.countBuffer = "";
      this.clearPending();
      this.refresh();
      return;
    }

    if ((data >= "1" && data <= "9") || (data === "0" && this.countBuffer !== "")) {
      this.countBuffer += data;
      this.refresh();
      return;
    }

    const inputHasCount = this.countBuffer !== "";
    const inputCount = this.consumeCount();
    const pendingKey =
      this.pending && Date.now() - this.pendingAt <= PENDING_TIMEOUT_MS ? this.pending : "";
    const hasCount = pendingKey ? this.pendingHasCount : inputHasCount;
    const count = pendingKey ? this.pendingCount : inputCount;
    this.clearPending();

    if (pendingKey === "g" && data === "g") {
      this.moveAbsolute(hasCount ? count - 1 : 0);
      this.refresh();
      return;
    }
    if (pendingKey === "," && data === "f") {
      this.openFilesPicker();
      return;
    }
    if (pendingKey === "[") {
      if (data === "h") this.moveToMarker("hunk", -1, count);
      else if (data === "f") this.moveToMarker("file", -1, count);
      else if (data === "c") this.moveToChange(-1, count);
      else this.status = `Unknown motion [${data}`;
      this.refresh();
      return;
    }
    if (pendingKey === "]") {
      if (data === "h") this.moveToMarker("hunk", 1, count);
      else if (data === "f") this.moveToMarker("file", 1, count);
      else if (data === "c") this.moveToChange(1, count);
      else this.status = `Unknown motion ]${data}`;
      this.refresh();
      return;
    }
    if (pendingKey === "c" && data === "c") {
      const line = this.lineAtCursor();
      if (lineIsSelectable(line)) this.beginComment(buildCommentTargetForLine(line));
      this.refresh();
      return;
    }
    if (pendingKey === "d" && data === "d") {
      this.deleteCommentUnderCursor();
      this.refresh();
      return;
    }

    switch (data) {
      case "j":
        this.moveToSelectable(this.cursor, 1, count);
        break;
      case "k":
        this.moveToSelectable(this.cursor, -1, count);
        break;
      case "h":
        this.horizontal = Math.max(0, this.horizontal - 4 * count);
        break;
      case "l":
        this.horizontal += 4 * count;
        break;
      case "G":
        this.moveAbsolute(hasCount ? count - 1 : this.lines.length - 1);
        break;
      case "r":
        this.relativeNumbers = !this.relativeNumbers;
        this.status = this.relativeNumbers
          ? "Relative line numbers on"
          : "Relative line numbers off";
        break;
      case "v":
        if (this.mode === "normal") this.startVisual();
        else {
          this.mode = "normal";
          this.visual = null;
        }
        break;
      case "o":
        if (this.mode === "visual" && this.visual) {
          const anchor = this.visual.anchor;
          this.visual.anchor = this.cursor;
          this.cursor = anchor;
        } else {
          this.openOverallComment();
        }
        break;
      case "c":
        if (this.mode === "visual") {
          // A refused selection stays active so it can be adjusted.
          if (this.finishVisualComment()) this.visual = null;
        } else {
          this.setPending("c", count, hasCount);
        }
        break;
      case "C":
        this.openFileComment();
        break;
      case "d":
      case "g":
      case "[":
      case "]":
      case ",":
        this.setPending(data, count, hasCount);
        break;
      case ":":
        this.enterCommand();
        break;
      case "q":
        this.executeCommand("q");
        return;
      default:
        if (matchesKey(data, Key.enter)) this.editCommentUnderCursor();
        break;
    }

    this.refresh();
  }

  handleInput(data: string): void {
    if (this.draft) {
      this.handleDraftInput(data);
      return;
    }

    if (this.mode === "command") {
      this.handleCommandInput(data);
      return;
    }

    if (this.mode === "files") {
      this.handleFilesInput(data);
      return;
    }

    if (this.mode === "help") {
      this.handleHelpInput(data);
      return;
    }

    this.handleNormalOrVisual(data);
  }

  private ensureCursorVisible(contentHeight: number): void {
    this.scroll = clamp(this.scroll, 0, Math.max(0, this.lines.length - contentHeight));
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    if (this.cursor >= this.scroll + contentHeight) this.scroll = this.cursor - contentHeight + 1;
  }

  private selectionRange(): [number, number] | null {
    if (this.mode !== "visual" || !this.visual) return null;
    const anchor = this.lines[this.visual.anchor];
    const cursor = this.lineAtCursor();
    if (
      !anchor ||
      !cursor ||
      anchor.fileIndex !== cursor.fileIndex ||
      anchor.hunkIndex !== cursor.hunkIndex
    ) {
      return null;
    }
    return [Math.min(this.visual.anchor, this.cursor), Math.max(this.visual.anchor, this.cursor)];
  }

  private renderHeader(width: number): string {
    const current = this.lineAtCursor();
    const file = current ? this.options.snapshot.files[current.fileIndex] : undefined;
    const reviewComments = this.comments.length;
    const fileComments = current ? this.commentsForFile(current.fileIndex).length : 0;
    const mode = this.draft
      ? "COMMENT"
      : this.mode === "visual"
        ? "VISUAL"
        : this.mode === "command"
          ? "COMMAND"
          : this.mode === "files"
            ? "FILES"
            : this.mode === "help"
              ? "HELP"
              : "NORMAL";
    const selection = this.selectionRange();
    const selectionText = selection
      ? ` · ${formatRangeCount(selection[1] - selection[0] + 1)}`
      : "";
    const status = file ? file.status[0]!.toUpperCase() : "-";
    const path = file?.displayPath ?? "(no file)";
    const skipped = this.options.snapshot.skippedCount;
    const skippedText = skipped > 0 ? ` · ${skipped} skipped` : "";
    const right = this.theme.fg(
      "muted",
      ` ${status} · ${reviewComments} comment${reviewComments === 1 ? "" : "s"}${fileComments ? ` · ${fileComments} here` : ""}${selectionText}${skippedText} `,
    );
    const label = ` ${this.theme.fg("accent", this.theme.bold(mode))}  `;
    const pathWidth = Math.max(10, width - visibleWidth(label) - visibleWidth(right));
    const title = `${label}${this.theme.fg("text", truncateToWidth(path, pathWidth))}`;
    return truncateToWidth(title + right, width, "", true);
  }

  private renderReviewLine(line: ReviewLine, width: number): string {
    const selection = this.selectionRange();
    const selected = selection !== null && line.id >= selection[0] && line.id <= selection[1];
    const isCursor = line.id === this.cursor;
    const lineComments = this.commentsForLine(line);
    const marker = lineComments.length > 0 ? this.theme.fg("warning", "●") : " ";
    let numbers: string;
    if (this.relativeNumbers) {
      if (!lineIsSelectable(line)) {
        numbers = "    ";
      } else if (line.id === this.lineAtCursor()?.id) {
        numbers = formatLineNumber(line.newLine ?? line.oldLine);
      } else {
        const distance = Math.abs(
          this.selectableOrdinal(line.id) -
            this.selectableOrdinal(this.lineAtCursor()?.id ?? line.id),
        );
        numbers = formatLineNumber(distance);
      }
    } else {
      numbers = `${formatLineNumber(line.oldLine)} ${formatLineNumber(line.newLine)}`;
    }
    const prefix =
      line.kind === "addition"
        ? "+"
        : line.kind === "removal"
          ? "-"
          : line.kind === "context"
            ? " "
            : " ";
    const gutter = `${marker} ${numbers} ${prefix} `;
    const contentWidth = Math.max(1, width - visibleWidth(gutter));
    const styled = this.styler.styleText(line, line.text, { selected });
    const content = sliceByColumn(styled, this.horizontal, contentWidth, true);

    const gutterStyled = isCursor ? this.theme.fg("accent", gutter) : this.theme.fg("dim", gutter);
    const body = `${gutterStyled}${content}`;
    const padded = truncateToWidth(body, width, "", true);

    if (selected) return this.theme.bg("selectedBg", padded);
    return padded;
  }

  private renderFiles(width: number, height: number): string[] {
    const filtered = this.filteredFiles();
    this.files.selected = clamp(this.files.selected, 0, Math.max(0, filtered.length - 1));

    const query = this.files.query;
    const title = this.theme.fg("accent", this.theme.bold(" Jump to file "));
    const inputLine = ` ${this.theme.fg("muted", "/")} ${query}${this.theme.fg("accent", "▌")}`;
    const rendered: string[] = [
      truncateToWidth(title, width, "", true),
      truncateToWidth(inputLine, width, "", true),
      "".padEnd(width, " "),
    ];

    const listHeight = Math.max(1, height - rendered.length - 1);
    const selected = this.files.selected;
    const start = clamp(
      selected - Math.floor(listHeight / 2),
      0,
      Math.max(0, filtered.length - listHeight),
    );
    const visible = filtered.slice(start, start + listHeight);

    if (visible.length === 0) {
      rendered.push(this.theme.fg("dim", truncateToWidth(" No matching files", width, "…", true)));
    }

    visible.forEach((file, index) => {
      const absoluteIndex = start + index;
      const commentCount = this.commentsForFile(this.options.snapshot.files.indexOf(file)).length;
      rendered.push(
        fileRowStyle(file, commentCount, absoluteIndex === selected, width, this.theme, (text, w) =>
          truncateToWidth(text, w, "…", true),
        ),
      );
    });

    while (rendered.length < height - 1) rendered.push("".padEnd(width, " "));
    rendered.push(
      truncateToWidth(
        this.theme.fg("dim", " type to filter · ↑/↓ or C-n/C-p move · Enter jump · Esc close "),
        width,
        "",
        true,
      ),
    );
    return rendered.slice(0, height);
  }

  private renderCommentPreview(width: number): string[] {
    const line = this.lineAtCursor();
    if (!line) return [];
    const comments = this.commentsForLine(line);
    if (comments.length === 0) return [];
    return comments.slice(0, 2).map((comment) => {
      const firstLine = comment.body.split("\n")[0] ?? "";
      const suffix = comment.body.includes("\n") ? "…" : "";
      return this.theme.fg(
        "warning",
        truncateToWidth(` ● ${firstLine}${suffix}`, width, "…", true),
      );
    });
  }

  private renderCommentDock(width: number, height: number): string[] {
    if (!this.draft) return [];
    const target = getCommentSummary(
      { target: this.draft.target, body: "", id: "", createdAt: 0, updatedAt: 0 },
      this.options.parsed,
    );
    const title = truncateToWidth(
      `${this.theme.fg("accent", this.theme.bold(" Comment "))} ${this.theme.fg("muted", target)}`,
      width,
      "…",
      true,
    );
    // Bound the dock to half the component height. The editor scrolls so its
    // cursor stays in its visible window, so when over budget keep the bottom
    // rows (where the cursor sits while typing) rather than slicing the top.
    const budget = clamp(Math.floor(height / 2), 4, 12);
    const renderedEditor = this.editor.render(width);
    const editorLines =
      renderedEditor.length > budget - 2 ? renderedEditor.slice(-(budget - 2)) : renderedEditor;
    const hint = truncateToWidth(
      this.theme.fg("dim", " Enter inserts newline · Esc saves · Ctrl-c cancels "),
      width,
      "",
      true,
    );
    return [title, ...editorLines, hint];
  }

  private renderHelp(width: number, height: number): string[] {
    const visible = HELP_LINES.slice(this.help.scroll, this.help.scroll + Math.max(0, height - 1));
    const footer = this.theme.fg("dim", " Esc/q close help ");
    return [...visible.map((line) => truncateToWidth(` ${line}`, width, "…", true)), footer].slice(
      0,
      height,
    );
  }

  private renderFooter(width: number): string {
    const pending =
      this.pending && Date.now() - this.pendingAt <= PENDING_TIMEOUT_MS ? this.pending : "";
    if (pending) {
      const count = this.pendingHasCount ? String(this.pendingCount) : "";
      return truncateToWidth(this.theme.fg("muted", ` ${count}${pending}`), width, "", true);
    }

    if (this.mode === "command") {
      return truncateToWidth(this.theme.fg("text", `:${this.command.input}`), width, "", true);
    }
    if (this.status)
      return truncateToWidth(this.theme.fg("warning", ` ${this.status}`), width, "", true);
    if (this.mode === "visual")
      return truncateToWidth(this.theme.fg("accent", " -- VISUAL -- "), width, "", true);
    const position = `${this.cursor + 1}/${this.lines.length}`;
    const hints = " j/k move · v select · c comment · C-p files · :w write · ? help ";
    return truncateToWidth(
      `${this.theme.fg("dim", hints)}${this.theme.fg("muted", position)}`,
      width,
      "",
      true,
    );
  }

  render(width: number): string[] {
    const height = Math.max(1, this.options.height);
    if (this.cachedWidth === width && this.cachedHeight === height) return this.cachedLines;

    if (this.mode === "files") {
      this.cachedLines = this.renderFiles(width, height);
      this.cachedWidth = width;
      this.cachedHeight = height;
      return this.cachedLines;
    }

    if (this.mode === "help") {
      this.cachedLines = this.renderHelp(width, height);
      this.cachedWidth = width;
      this.cachedHeight = height;
      return this.cachedLines;
    }

    const footerHeight = 1;
    const preview = this.draft ? [] : this.renderCommentPreview(width);
    const dock = this.renderCommentDock(width, height);
    const contentHeight = Math.max(1, height - 1 - footerHeight - preview.length - dock.length);
    this.ensureCursorVisible(contentHeight);

    const rendered = [this.renderHeader(width)];
    for (
      let index = this.scroll;
      index < Math.min(this.lines.length, this.scroll + contentHeight);
      index += 1
    ) {
      rendered.push(this.renderReviewLine(this.lines[index]!, width));
    }
    rendered.push(...preview);
    while (rendered.length < height - dock.length - 1) rendered.push("".padEnd(width, " "));
    rendered.push(...dock);
    rendered.push(this.renderFooter(width));

    this.cachedWidth = width;
    this.cachedHeight = height;
    this.cachedLines = rendered.slice(0, height);
    return this.cachedLines;
  }
}
