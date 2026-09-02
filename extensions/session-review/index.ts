import { BorderedLoader, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { analyzeSessions } from "./analysis.ts";
import { errorMessage } from "./format.ts";
import { removeHtmlReports, writeHtmlReport } from "./html.ts";
import {
  loadClassificationConfig,
  loadSessionCorpus,
  parseReviewDays,
  prepareRecentSessions,
} from "./sessions.ts";
import type { PreparedSession, SessionReviewReport } from "./types.ts";
import { SessionReviewView, sortSessionsByCost } from "./view.ts";

async function openHtmlReport(pi: ExtensionAPI, path: string): Promise<boolean> {
  try {
    const command =
      process.platform === "darwin"
        ? { executable: "open", args: [path] }
        : process.platform === "win32"
          ? { executable: "cmd.exe", args: ["/c", "start", "", path] }
          : { executable: "xdg-open", args: [path] };
    const result = await pi.exec(command.executable, command.args, { timeout: 10_000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", () => removeHtmlReports());

  pi.registerCommand("session-review", {
    description: "Review recent Pi sessions, costs, outcomes, and work/personal classification",
    getArgumentCompletions: (prefix) => {
      const items = ["7d", "14d", "30d"].filter((value) => value.startsWith(prefix));
      return items.length > 0 ? items.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) {
          ctx.ui.notify("The session review is available in interactive mode.", "warning");
        }
        return;
      }

      let days: number;
      try {
        days = parseReviewDays(args);
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "warning");
        return;
      }

      const model = ctx.model;
      if (!model) {
        ctx.ui.notify("No active model is available for session analysis.", "warning");
        return;
      }
      if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
        ctx.ui.notify(
          `No authentication is configured for ${model.provider}/${model.id}.`,
          "warning",
        );
        return;
      }

      let config;
      try {
        config = await loadClassificationConfig();
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
        return;
      }

      type ScanResult =
        | {
            sessions: PreparedSession[];
            cutoff: number;
            skippedFiles: number;
            skippedLines: number;
          }
        | { error: unknown }
        | null;
      const now = new Date();
      const scan = await ctx.ui.custom<ScanResult>((tui, theme, _keybindings, done) => {
        const loader = new BorderedLoader(tui, theme, "Reading recent Pi sessions…", {
          cancellable: true,
        });
        let settled = false;
        const finish = (value: ScanResult) => {
          if (settled) return;
          settled = true;
          done(value);
        };
        loader.onAbort = () => finish(null);

        void loadSessionCorpus({ days, now, signal: loader.signal })
          .then(async (corpus) => {
            const sessions = await prepareRecentSessions(corpus, config, loader.signal);
            finish({
              sessions,
              cutoff: corpus.cutoff,
              skippedFiles: corpus.skippedFiles,
              skippedLines: corpus.skippedLines,
            });
          })
          .catch((error) => finish({ error }));
        return loader;
      });

      if (scan === null) return;
      if ("error" in scan) {
        ctx.ui.notify(`Could not read Pi sessions: ${errorMessage(scan.error)}`, "error");
        return;
      }
      if (scan.sessions.length === 0) {
        ctx.ui.notify(`No Pi sessions were active in the trailing ${days} days.`, "info");
        return;
      }

      const confirmed = await ctx.ui.confirm(
        "Analyze recent sessions?",
        `Send redacted excerpts from ${scan.sessions.length} sessions to ${model.provider}/${model.id}? This creates new model usage; cancelling after dispatch may still incur charges.`,
      );
      if (!confirmed) return;

      type AnalysisResult =
        | {
            assessments: Awaited<ReturnType<typeof analyzeSessions>>["assessments"];
            generationCost: number;
            warning?: string;
          }
        | { error: unknown }
        | { cancelled: true; generationCost: number };
      const analysis = await ctx.ui.custom<AnalysisResult>((tui, theme, _keybindings, done) => {
        const loader = new BorderedLoader(
          tui,
          theme,
          `Reviewing ${scan.sessions.length} sessions with ${model.name}…`,
          { cancellable: true },
        );
        let settled = false;
        let cancelRequested = false;
        const finish = (value: AnalysisResult) => {
          if (settled) return;
          settled = true;
          done(value);
        };
        loader.onAbort = () => {
          cancelRequested = true;
        };
        void analyzeSessions(scan.sessions, model, ctx, loader.signal).then(
          (result) =>
            finish(
              cancelRequested ? { cancelled: true, generationCost: result.generationCost } : result,
            ),
          (error) => finish(cancelRequested ? { cancelled: true, generationCost: 0 } : { error }),
        );
        return loader;
      });

      if ("cancelled" in analysis) {
        const recorded =
          analysis.generationCost > 0
            ? ` Recorded generation cost: $${analysis.generationCost.toFixed(4)}.`
            : "";
        ctx.ui.notify(
          `Session review cancelled. Requests already dispatched may still incur charges.${recorded}`,
          "warning",
        );
        return;
      }
      if ("error" in analysis) {
        ctx.ui.notify(`Could not analyze Pi sessions: ${errorMessage(analysis.error)}`, "error");
        return;
      }

      const assessments = new Map(
        analysis.assessments.map((assessment) => [assessment.id, assessment]),
      );
      const report: SessionReviewReport = {
        generatedAt: now.getTime(),
        cutoff: scan.cutoff,
        days,
        sessions: sortSessionsByCost(
          scan.sessions.flatMap((session) => {
            const assessment = assessments.get(session.id);
            return assessment ? [{ ...session, ...assessment }] : [];
          }),
        ),
        generationCost: analysis.generationCost,
        ...(analysis.warning ? { analysisWarning: analysis.warning } : {}),
        skippedFiles: scan.skippedFiles,
        skippedLines: scan.skippedLines,
      };

      try {
        const htmlPath = await writeHtmlReport(report);
        if (await openHtmlReport(pi, htmlPath)) {
          ctx.ui.notify(`Opened session review: ${htmlPath}`, "info");
          return;
        }
        ctx.ui.notify(
          `HTML report saved to ${htmlPath}; it could not be opened automatically.`,
          "warning",
        );
      } catch (error) {
        ctx.ui.notify(`Could not create HTML report: ${errorMessage(error)}`, "warning");
      }

      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          new SessionReviewView(tui, theme, report, () => done(undefined)),
      );
    },
  });
}
