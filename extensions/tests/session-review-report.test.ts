import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import type { SessionEntry, SessionInfo, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { removeHtmlReports, renderHtmlReport, writeHtmlReport } from "../session-review/html.ts";
import {
  createRepositoryLocator,
  discoverRepositories,
  repositoryCategoryOverride,
} from "../session-review/sessions.ts";
import type { ReviewedSession, SessionReviewReport } from "../session-review/types.ts";
import { SessionReviewView } from "../session-review/view.ts";

const AT = "2026-08-30T10:00:00.000Z";

function info(cwd: string): SessionInfo {
  return {
    id: "session",
    path: "/sessions/session.jsonl",
    cwd,
    created: new Date(AT),
    modified: new Date(AT),
    messageCount: 1,
    firstMessage: "Fix",
    allMessagesText: "",
  };
}

function toolCalls(paths: readonly string[]): SessionEntry[] {
  return [
    {
      type: "message",
      id: "a",
      parentId: null,
      timestamp: AT,
      message: {
        role: "assistant",
        content: paths.map((path, index) => ({
          type: "toolCall",
          id: `call-${index}`,
          name: "read",
          arguments: { path },
        })),
      },
    } as unknown as SessionEntry,
  ];
}

function report(overrides: Partial<SessionReviewReport> = {}): SessionReviewReport {
  const session = {
    id: "session-1",
    path: "/sessions/one.jsonl",
    firstMessage: "Fix",
    created: 1,
    modified: 2,
    repositories: [{ name: "repo", path: "/code/repo" }],
    evidence: "",
    cost: 0.5,
    tagline: "Explore the codebase",
    summary: "Looked around.",
    outcome: "unclear",
    outcomeConfidence: "low",
    outcomeReason: "Nothing was verified.",
    category: "work",
    categoryConfidence: "medium",
    categoryReason: "Company repository.",
  } as ReviewedSession;
  return {
    generatedAt: new Date("2026-08-31T12:00:00Z").getTime(),
    cutoff: new Date("2026-08-24T12:00:00Z").getTime(),
    days: 7,
    sessions: [session],
    generationCost: 0,
    skippedFiles: 0,
    skippedLines: 0,
    ...overrides,
  };
}

function renderView(value: SessionReviewReport): string {
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const tui = { terminal: { rows: 60 }, requestRender() {} };
  return new SessionReviewView(tui as unknown as TUI, theme as unknown as Theme, value, () => {})
    .render(160)
    .join("\n");
}

test("expands ~ in repository path overrides", (t) => {
  const previous = process.env.HOME;
  process.env.HOME = "/Users/me";
  t.after(() => {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  });
  const repositories = [{ name: "company-api", path: "/Users/me/Code/company/company-api" }];

  assert.equal(
    repositoryCategoryOverride(repositories, { work: ["~/Code/company"], personal: [] }),
    "work",
  );
  assert.equal(
    repositoryCategoryOverride(repositories, {
      work: [],
      personal: ["~/Code/company/company-api"],
    }),
    "personal",
  );
  assert.equal(
    repositoryCategoryOverride(repositories, { work: ["~/Code/other"], personal: [] }),
    undefined,
  );
});

test("dedupes git root lookups by directory and honours the abort signal", async () => {
  const checked: string[] = [];
  const locate = createRepositoryLocator(async (path) => {
    checked.push(path);
    return path === "/repo/.git";
  });

  assert.equal(await locate("/repo/src/a.ts"), "/repo");
  assert.equal(await locate("/repo/src/b.ts"), "/repo");
  assert.equal(await locate("/repo/src"), "/repo");
  assert.equal(await locate("/elsewhere/file"), null);
  assert.deepEqual(checked, [
    "/repo/src/a.ts/.git",
    "/repo/src/.git",
    "/repo/.git",
    "/repo/src/b.ts/.git",
    "/elsewhere/file/.git",
    "/elsewhere/.git",
    "/.git",
  ]);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    locate("/repo/other", controller.signal),
    (error: unknown) => (error as Error).name === "AbortError",
  );
  await assert.rejects(
    discoverRepositories(info("/repo"), [], controller.signal),
    (error: unknown) => (error as Error).name === "AbortError",
  );
});

test("discovers one repository from duplicated tool paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-review-repo-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "src"));
  const file = join(root, "src", "index.ts");

  const repositories = await discoverRepositories(
    info(root),
    toolCalls([file, file, join(root, "src"), root]),
  );

  assert.deepEqual(repositories, [{ name: basename(root), path: root }]);
});

test("removes every report directory this session created on shutdown", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "session-review-test-"));
  t.after(async () => {
    await removeHtmlReports();
    await rm(temp, { recursive: true, force: true });
  });

  const first = await writeHtmlReport(report(), temp);
  const second = await writeHtmlReport(report({ generatedAt: report().generatedAt + 1_000 }), temp);

  assert.notEqual(first, second);
  await access(second);

  await removeHtmlReports();
  await assert.rejects(access(dirname(first)));
  await assert.rejects(access(dirname(second)));

  const third = await writeHtmlReport(report(), temp);
  await access(third);
});

test("uses the same zero-outcome text and skipped-line notice in both views", () => {
  const value = report({ skippedLines: 3, skippedFiles: 1 });
  const html = renderHtmlReport(value);
  const view = renderView(value);

  assert.match(html, /no decided outcomes/);
  assert.match(view, /no decided outcomes/);
  assert.doesNotMatch(html, /No decided outcomes|— success/);
  assert.doesNotMatch(view, /— success/);
  assert.match(html, /3 unreadable session lines skipped/);
  assert.match(view, /3 unreadable session lines skipped/);
  assert.match(html, /1 unreadable session files skipped/);
});
