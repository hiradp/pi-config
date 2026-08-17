import { BorderedLoader, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadUsageReport } from "./report.ts";
import type { UsageReport } from "./types.ts";
import { UsageView } from "./view.ts";

export { aggregateUsage, loadUsageReport } from "./report.ts";
export type {
  ModelUsage,
  PeriodUsage,
  UsageBucket,
  UsageCategory,
  UsagePeriodKey,
  UsageReport,
  UsageTotals,
  UsageTrendKey,
} from "./types.ts";
export { displayRows, formatTokenCount, formatUsageCost } from "./view.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("usage", {
    description: "Show token usage, cost, and recent trends",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI)
          ctx.ui.notify("The usage report is available in interactive mode.", "warning");
        return;
      }

      type LoadResult = { report: UsageReport } | { error: unknown } | null;
      const result = await ctx.ui.custom<LoadResult>((tui, theme, _keybindings, done) => {
        const loader = new BorderedLoader(tui, theme, "Reading Pi session usage…", {
          cancellable: true,
        });
        let settled = false;
        const finish = (value: LoadResult) => {
          if (settled) return;
          settled = true;
          done(value);
        };
        loader.onAbort = () => finish(null);

        void loadUsageReport({
          currentSessionFile: ctx.sessionManager.getSessionFile(),
          currentEntries: ctx.sessionManager.getEntries(),
          signal: loader.signal,
        }).then(
          (report) => finish({ report }),
          (error) => finish({ error }),
        );
        return loader;
      });

      if (result === null) return;
      if ("error" in result) {
        ctx.ui.notify(`Could not load usage: ${errorMessage(result.error)}`, "error");
        return;
      }

      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          new UsageView(tui, theme, result.report, () => done(undefined)),
      );
    },
  });
}
