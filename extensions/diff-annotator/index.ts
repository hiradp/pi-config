import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { captureReviewSnapshot } from "./git.ts";
import { parseReviewSnapshot } from "./parser.ts";
import { composeReviewPrompt } from "./prompt.ts";
import { DiffReviewerComponent, type ReviewerDoneResult } from "./reviewer.ts";
import type { ReviewComment } from "./types.ts";

interface ReviewFlowDeps {
  captureSnapshot: typeof captureReviewSnapshot;
  parseSnapshot: typeof parseReviewSnapshot;
  composePrompt: typeof composeReviewPrompt;
}

type ReviewRunner = Parameters<typeof captureReviewSnapshot>[0];

const defaultDeps: ReviewFlowDeps = {
  captureSnapshot: captureReviewSnapshot,
  parseSnapshot: parseReviewSnapshot,
  composePrompt: composeReviewPrompt,
};

async function runAnnotator(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  deps: ReviewFlowDeps = defaultDeps,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/annotate-diff requires interactive TUI mode", "error");
    return;
  }

  if (!ctx.isIdle()) {
    ctx.ui.notify("Wait for the agent to finish before reviewing the diff", "warning");
    return;
  }

  const editorDraft = ctx.ui.getEditorText();
  const runner: ReviewRunner = {
    exec: (command, args, options) =>
      pi.exec(command, args, {
        cwd: options?.cwd ?? ctx.cwd,
        timeout: options?.timeout,
        signal: options?.signal,
      }),
  };
  let snapshot;
  try {
    snapshot = await deps.captureSnapshot(runner, ctx.cwd, { signal: ctx.signal });
  } catch (error) {
    ctx.ui.notify(
      `Failed to capture working-tree diff: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }
  const parsed = deps.parseSnapshot(snapshot);
  // Raw snapshot files carry no parsed hunks; the merged view is required
  // everywhere line-level data is resolved (styling, prompt composition).
  const reviewSnapshot = { ...snapshot, files: parsed.files };

  const reviewableCount = parsed.files.filter((file) => file.reviewable).length;
  if (snapshot.files.length === 0) {
    ctx.ui.notify("No working-tree changes found", "info");
    return;
  }
  if (reviewableCount === 0) {
    ctx.ui.notify("No reviewable text changes found", "info");
    return;
  }
  if (snapshot.skippedCount > 0) {
    const reason = snapshot.truncated
      ? "the review snapshot exceeded 1MB"
      : "binary, too large, or unreadable";
    ctx.ui.notify(
      `Skipped ${snapshot.skippedCount} of ${snapshot.files.length} changed files (${reason})`,
      snapshot.truncated ? "warning" : "info",
    );
  }

  const comments: ReviewComment[] = [];

  const openReviewer = () =>
    ctx.ui.custom<ReviewerDoneResult>((tui, theme, keybindings, done) => {
      const options = {
        snapshot: reviewSnapshot,
        parsed,
        height: Math.max(1, tui.terminal.rows - 1),
        comments,
      };

      const component = new DiffReviewerComponent(tui, theme, keybindings, done, options);
      return {
        get focused() {
          return component.focused;
        },
        set focused(value: boolean) {
          component.focused = value;
        },
        render: (width) => {
          options.height = Math.max(1, tui.terminal.rows - 1);
          return component.render(width);
        },
        handleInput: (data) => {
          options.height = Math.max(1, tui.terminal.rows - 1);
          component.setHeight(options.height);
          component.handleInput(data);
          tui.requestRender();
        },
        invalidate: () => {
          options.height = Math.max(1, tui.terminal.rows - 1);
          component.setHeight(options.height);
          component.invalidate();
        },
      };
    });

  let forced = false;
  for (;;) {
    const result = await openReviewer();

    if (result.action === "cancel") {
      ctx.ui.notify("Review cancelled", "info");
      return;
    }

    if (comments.length === 0) {
      ctx.ui.notify("No review comments to write", "warning");
      return;
    }

    if (result.force) {
      forced = true;
      break;
    }

    let latestFingerprint: string | null = null;
    try {
      latestFingerprint = (await deps.captureSnapshot(runner, ctx.cwd, { signal: ctx.signal }))
        .fingerprint;
    } catch (error) {
      ctx.ui.notify(
        `Could not verify working-tree state: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
    if (latestFingerprint === snapshot.fingerprint) break;

    // The reviewer closes on :w before staleness can be checked; reopen with
    // the same snapshot and comments so nothing the user wrote is dropped.
    ctx.ui.notify(
      latestFingerprint === null
        ? "Could not verify the working tree — comments kept; use :w! to write this snapshot anyway"
        : "Working tree changed during review — comments kept; use :w! to write this snapshot anyway",
      "warning",
    );
  }

  const prompt = deps.composePrompt({
    snapshot: reviewSnapshot,
    comments,
    forced,
  });
  ctx.ui.setEditorText(editorDraft.trim() ? `${editorDraft.trimEnd()}\n\n${prompt}` : prompt);
  ctx.ui.notify("Review feedback written to the editor", "info");
}

export function createDiffAnnotatorCommand(
  pi: ExtensionAPI,
  deps: ReviewFlowDeps = defaultDeps,
): void {
  pi.registerCommand("annotate-diff", {
    description: "Annotate the working-tree diff with Vim-style line and block comments",
    handler: async (_args, ctx) => {
      await runAnnotator(pi, ctx, deps);
    },
  });
}

export default function (pi: ExtensionAPI): void {
  createDiffAnnotatorCommand(pi);
}
