import { lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionReviewReport } from "./types.ts";
import { categoryStats, formatReviewCost, sanitizeDisplayText } from "./view.ts";

function escapeHtml(value: string): string {
  return sanitizeDisplayText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function dateRange(report: SessionReviewReport): string {
  const format = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${format.format(new Date(report.cutoff))} – ${format.format(new Date(report.generatedAt))}`;
}

function sessionDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function successRate(success: number, failure: number): string {
  const decided = success + failure;
  return decided === 0
    ? "No decided outcomes"
    : `${Math.round((success / decided) * 100)}% success`;
}

export function renderHtmlReport(report: SessionReviewReport): string {
  const totalCost = report.sessions.reduce((sum, session) => sum + session.cost, 0);
  const successful = report.sessions.filter((session) => session.outcome === "success").length;
  const failed = report.sessions.filter((session) => session.outcome === "failure").length;
  const unclear = report.sessions.length - successful - failed;
  const stats = categoryStats(report.sessions);
  const categoryCards = stats
    .map(
      (item) => `<article class="metric category-${item.category}">
        <span>${titleCase(item.category)}</span>
        <strong>${item.count}</strong>
        <small>${formatReviewCost(item.cost)} · ${successRate(item.success, item.failure)}</small>
      </article>`,
    )
    .join("\n");
  const sessionCards = report.sessions
    .map((session) => {
      const repositories = session.repositories.map((repo) => escapeHtml(repo.name)).join(", ");
      return `<article class="session outcome-${session.outcome}">
        <div class="session-heading">
          <div>
            <span class="outcome-mark">${session.outcome === "success" ? "✓" : session.outcome === "failure" ? "✕" : "?"}</span>
            <h2>${escapeHtml(session.tagline)}</h2>
          </div>
          <strong class="cost">${formatReviewCost(session.cost)}</strong>
        </div>
        <div class="badges">
          <span class="badge category-${session.category}">${titleCase(session.category)} · ${session.categoryConfidence}</span>
          <span class="badge outcome-${session.outcome}">${titleCase(session.outcome)} · ${session.outcomeConfidence}</span>
        </div>
        <p class="metadata">${repositories || "Unknown repository"} · ${escapeHtml(sessionDate(session.modified))}</p>
        <p class="summary">${escapeHtml(session.summary)}</p>
        <dl>
          <div><dt>Outcome evidence</dt><dd>${escapeHtml(session.outcomeReason)}</dd></div>
          <div><dt>Classification</dt><dd>${escapeHtml(session.categoryReason)}</dd></div>
        </dl>
      </article>`;
    })
    .join("\n");
  const notices = [
    report.analysisWarning,
    report.skippedFiles > 0
      ? `${report.skippedFiles} unreadable session files skipped.`
      : undefined,
    report.generationCost > 0
      ? `Report generation cost: ${formatReviewCost(report.generationCost)}.`
      : undefined,
  ]
    .filter((notice): notice is string => Boolean(notice))
    .map((notice) => `<p class="notice">${escapeHtml(notice)}</p>`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pi session review · ${escapeHtml(dateRange(report))}</title>
  <style>
    :root { color-scheme: light dark; --bg: #f6f4ef; --card: #fffdf8; --text: #292722; --muted: #6f6a61; --border: #ded9cf; --accent: #a64b2a; --success: #287a4b; --failure: #b43b3b; --unclear: #9a6b18; --work: #3f67a8; --personal: #8b4fa3; }
    @media (prefers-color-scheme: dark) { :root { --bg: #1d1b18; --card: #27241f; --text: #eee9df; --muted: #aaa399; --border: #403c35; --accent: #e07a50; --success: #65bd83; --failure: #e27474; --unclear: #d7a64d; --work: #7fa4df; --personal: #c58bd8; } }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(980px, calc(100% - 32px)); margin: 48px auto 80px; }
    header { margin-bottom: 28px; }
    h1 { margin: 0 0 6px; font-size: clamp(2rem, 5vw, 3.4rem); line-height: 1; letter-spacing: -0.04em; }
    header p, .metadata, small, footer { color: var(--muted); }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 24px 0 34px; }
    .metric { padding: 16px; border: 1px solid var(--border); border-radius: 14px; background: var(--card); }
    .metric span, .metric strong, .metric small { display: block; }
    .metric strong { margin: 4px 0; font-size: 1.65rem; }
    .session { margin: 14px 0; padding: 22px; border: 1px solid var(--border); border-left: 5px solid var(--unclear); border-radius: 16px; background: var(--card); box-shadow: 0 8px 30px rgb(0 0 0 / 5%); }
    .session.outcome-success { border-left-color: var(--success); }
    .session.outcome-failure { border-left-color: var(--failure); }
    .session-heading, .session-heading > div { display: flex; align-items: baseline; gap: 10px; }
    .session-heading { justify-content: space-between; }
    .session h2 { display: inline; margin: 0; font-size: 1.2rem; }
    .outcome-mark { font-weight: 800; }
    .outcome-success .outcome-mark { color: var(--success); }
    .outcome-failure .outcome-mark { color: var(--failure); }
    .outcome-unclear .outcome-mark { color: var(--unclear); }
    .cost { color: var(--accent); white-space: nowrap; }
    .badges { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
    .badge { padding: 3px 9px; border: 1px solid currentColor; border-radius: 999px; font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; }
    .category-work { color: var(--work); } .category-personal { color: var(--personal); } .category-unclear { color: var(--muted); }
    .badge.outcome-success { color: var(--success); } .badge.outcome-failure { color: var(--failure); } .badge.outcome-unclear { color: var(--unclear); }
    .summary { margin: 16px 0; font-size: 1.02rem; }
    dl { margin: 0; padding-top: 12px; border-top: 1px solid var(--border); }
    dl div { display: grid; grid-template-columns: 140px 1fr; gap: 12px; margin: 6px 0; }
    dt { color: var(--muted); } dd { margin: 0; }
    .notice { padding: 10px 12px; border-left: 3px solid var(--unclear); background: color-mix(in srgb, var(--unclear) 10%, transparent); }
    footer { margin-top: 30px; font-size: .85rem; }
    @media (max-width: 600px) { main { margin-top: 28px; } .session { padding: 18px; } dl div { grid-template-columns: 1fr; gap: 0; } .session-heading { align-items: flex-start; } }
    @media print { main { width: 100%; margin: 0; } .session { break-inside: avoid; box-shadow: none; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Pi session review</h1>
      <p>${escapeHtml(dateRange(report))} · trailing ${report.days} days · local time</p>
      <p>${report.sessions.length} sessions · ${formatReviewCost(totalCost)} recorded cost · ${successful} successful · ${failed} failed · ${unclear} unclear</p>
    </header>
    <section class="metrics" aria-label="Category summary">${categoryCards}</section>
    <section aria-label="Sessions">${sessionCards}</section>
    ${notices}
    <footer>Recorded cost excludes usage copied into forks and clones. Generated ${escapeHtml(new Date(report.generatedAt).toLocaleString())}.</footer>
  </main>
</body>
</html>\n`;
}

const REPORT_DIRECTORY_PREFIX = "pi-session-review-";
const REPORT_FILE_NAME = "session-review.html";

async function reportModifiedAt(directory: string): Promise<number | undefined> {
  try {
    const directoryStats = await lstat(directory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) return undefined;

    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length !== 1) return undefined;

    const [reportEntry] = entries;
    if (
      reportEntry?.name !== REPORT_FILE_NAME ||
      !reportEntry.isFile() ||
      reportEntry.isSymbolicLink()
    ) {
      return undefined;
    }

    const reportStats = await lstat(join(directory, REPORT_FILE_NAME));
    return reportStats.isFile() && !reportStats.isSymbolicLink() ? reportStats.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

async function removeOlderHtmlReports(
  currentDirectory: string,
  tempDirectory: string,
): Promise<void> {
  const currentModifiedAt = await reportModifiedAt(currentDirectory);
  if (currentModifiedAt === undefined) return;

  let entries;
  try {
    entries = await readdir(tempDirectory, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(
    entries.map(async (entry) => {
      if (
        !entry.name.startsWith(REPORT_DIRECTORY_PREFIX) ||
        !entry.isDirectory() ||
        entry.isSymbolicLink()
      ) {
        return;
      }

      const directory = join(tempDirectory, entry.name);
      if (directory === currentDirectory) return;

      const modifiedAt = await reportModifiedAt(directory);
      if (modifiedAt === undefined || modifiedAt >= currentModifiedAt) return;

      try {
        await rm(directory, { recursive: true });
      } catch {
        // Retention is best-effort; the report just created remains usable.
      }
    }),
  );
}

/** Directories created by this Pi session so shutdown can remove them all. */
const createdDirectories = new Set<string>();

export async function writeHtmlReport(
  report: SessionReviewReport,
  tempDirectory = tmpdir(),
): Promise<string> {
  const directory = await mkdtemp(join(tempDirectory, REPORT_DIRECTORY_PREFIX));
  const path = join(directory, REPORT_FILE_NAME);

  try {
    await writeFile(path, renderHtmlReport(report), { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  createdDirectories.add(directory);
  await removeOlderHtmlReports(directory, tempDirectory).catch(() => {});
  return path;
}

/** Removes every report directory this Pi session created. */
export async function removeHtmlReports(): Promise<void> {
  const directories = [...createdDirectories];
  createdDirectories.clear();
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true }).catch(() => {})),
  );
}
