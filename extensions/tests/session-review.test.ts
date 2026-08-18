import assert from "node:assert/strict";
import { test } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionInfo } from "@earendil-works/pi-coding-agent";
import { parseAnalysisResponse } from "../session-review/analysis.ts";
import { renderHtmlReport } from "../session-review/html.ts";
import {
  attributeSessionCosts,
  isSessionEntry,
  parseReviewDays,
  parseSessionFile,
  redactSessionText,
  repositoryCategoryOverride,
  safeToolArguments,
} from "../session-review/sessions.ts";
import type { LoadedSession, PreparedSession, ReviewedSession } from "../session-review/types.ts";
import { categoryStats, sanitizeDisplayText, sortSessionsByCost } from "../session-review/view.ts";

function usage(cost: number): Usage {
  return {
    input: 100,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 120,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function assistantEntry(id: string, at: Date, cost: number): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: at.toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Completed the requested change." }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test-model",
      usage: usage(cost),
      stopReason: "stop",
      timestamp: at.getTime(),
    },
  };
}

function sessionInfo(id: string, path: string, created: Date): SessionInfo {
  return {
    id,
    path,
    cwd: "/code/repo",
    created,
    modified: created,
    messageCount: 1,
    firstMessage: "Fix the tests",
    allMessagesText: "Fix the tests Completed the requested change.",
  };
}

function prepared(categoryOverride?: "work" | "personal"): PreparedSession {
  return {
    id: "session-1",
    path: "/sessions/one.jsonl",
    firstMessage: "Fix the failing authentication tests",
    created: 1,
    modified: 2,
    repositories: [{ name: "repo", path: "/code/repo" }],
    evidence: "USER: Fix the tests",
    cost: 1,
    ...(categoryOverride ? { categoryOverride } : {}),
  };
}

test("parses review periods", () => {
  assert.equal(parseReviewDays(""), 7);
  assert.equal(parseReviewDays("14d"), 14);
  assert.equal(parseReviewDays("30 days"), 30);
  assert.throws(() => parseReviewDays("0d"), /between 1 and 90/);
  assert.throws(() => parseReviewDays("last week"), /Usage/);
});

test("attributes copied usage to the earliest session", () => {
  const firstAt = new Date("2026-03-20T10:00:00Z");
  const copied = assistantEntry("original", firstAt, 1.5);
  const original: LoadedSession = {
    info: sessionInfo("original", "/sessions/original.jsonl", new Date("2026-03-20T09:00:00Z")),
    entries: [copied],
  };
  const clone: LoadedSession = {
    info: sessionInfo("clone", "/sessions/clone.jsonl", new Date("2026-03-21T09:00:00Z")),
    entries: [
      structuredClone(copied),
      assistantEntry("new", new Date("2026-03-21T10:00:00Z"), 0.5),
    ],
  };

  const costs = attributeSessionCosts([clone, original]);

  assert.equal(costs.get(original.info.path), 1.5);
  assert.equal(costs.get(clone.info.path), 0.5);
});

test("normalizes model output and enforces category overrides", () => {
  const session = prepared("personal");
  const longSummary = Array.from({ length: 105 }, (_, index) => `word${index}`).join(" ");
  const result = parseAnalysisResponse(
    JSON.stringify({
      sessions: [
        {
          id: session.id,
          tagline: "Fix authentication tests and verify all relevant checks now",
          summary: longSummary,
          outcome: "success",
          outcomeConfidence: "high",
          outcomeReason: "The final test command passed.",
          category: "work",
          categoryConfidence: "medium",
          categoryReason: "The repository looked organizational.",
        },
      ],
    }),
    [session],
  );

  assert.equal(result[0]?.summary.trim().split(/\s+/).length, 100);
  assert.equal(result[0]?.category, "personal");
  assert.equal(result[0]?.categoryConfidence, "high");
  assert.match(result[0]?.categoryReason ?? "", /override/);
});

test("falls back safely when a model omits a session", () => {
  const session = prepared();
  const [result] = parseAnalysisResponse('{"sessions":[]}', [session]);

  assert.equal(result?.outcome, "unclear");
  assert.equal(result?.category, "unclear");
  assert.match(result?.tagline ?? "", /Fix the failing/);
});

test("matches repository name and path overrides without guessing conflicts", () => {
  const repositories = [{ name: "company-api", path: "/Users/me/Code/company/company-api" }];

  assert.equal(
    repositoryCategoryOverride(repositories, { work: ["company-api"], personal: [] }),
    "work",
  );
  assert.equal(
    repositoryCategoryOverride(repositories, { work: ["/Users/me/Code/company"], personal: [] }),
    "work",
  );
  assert.equal(
    repositoryCategoryOverride(repositories, { work: ["company-api"], personal: ["company-api"] }),
    undefined,
  );
});

test("redacts common credentials from session evidence", () => {
  const redacted = redactSessionText(
    'API_TOKEN=secret-value Authorization: Basic basic-secret x-api-key: key-secret {"token":"json-secret","AWS_SECRET_ACCESS_KEY":"aws-secret"} DATABASE_URL=postgres://dbuser:dbpass@host/db curl --authorization flag-secret https://user:pass@example.com sk-abcdefghijklmnop\nCookie: sessionid=cookie-secret; Path=/\nSet-Cookie: sid=set-cookie-secret\neyJabcdefghijk.abcdefghijklmnop.zyxwvutsrqpon\nPRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----"',
  );

  assert.doesNotMatch(
    redacted,
    /secret-value|basic-secret|key-secret|json-secret|aws-secret|dbuser:dbpass|flag-secret|user:pass|sk-abcdefghijklmnop|cookie-secret|set-cookie-secret|eyJabcdefghijk|private-material/,
  );
});

test("rejects malformed session entries before report processing", () => {
  assert.equal(
    isSessionEntry({
      type: "message",
      id: "entry",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [null] },
    }),
    false,
  );
  assert.equal(
    isSessionEntry({
      type: "message",
      id: "entry",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [{ type: "toolCall" }] },
    }),
    false,
  );

  const header = JSON.stringify({
    type: "session",
    id: "session",
    timestamp: new Date().toISOString(),
  });
  assert.equal(parseSessionFile(`${header}\n{not-json}\n`), null);
  assert.equal(
    parseSessionFile(
      `${header}\n${JSON.stringify({
        type: "message",
        id: "entry",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "assistant", content: [null] },
      })}\n`,
    ),
    null,
  );
});

test("makes standard tool paths repository-relative before model analysis", () => {
  const args = safeToolArguments(
    { path: "/Volumes/Clients/Acme/api/src/auth.ts", cwd: "/tmp/other", pattern: "token" },
    "/Volumes/Clients/Acme/api",
    [{ name: "api", path: "/Volumes/Clients/Acme/api" }],
  );

  assert.deepEqual(args, {
    path: "<repo:api>/src/auth.ts",
    cwd: "<external>/other",
    pattern: "token",
  });
});

test("strips terminal control sequences from report text", () => {
  const value = `safe ${String.fromCharCode(0x1b)}]52;c;clipboard${String.fromCharCode(0x07)} text ${String.fromCharCode(0x1b)}[31mred${String.fromCharCode(0x1b)}[0m`;
  const sanitized = sanitizeDisplayText(value);

  assert.doesNotMatch(sanitized, /clipboard|\[31m|\[0m/);
  assert.match(sanitized, /safe  text red/);
});

test("renders a self-contained escaped HTML report", () => {
  const session = {
    ...prepared("personal"),
    tagline: "Fix <script>alert(1)</script>",
    summary: "Completed & verified the change.",
    outcome: "success",
    outcomeConfidence: "high",
    outcomeReason: "Tests passed.",
    category: "personal",
    categoryConfidence: "high",
    categoryReason: "Repository override.",
  } as ReviewedSession;
  const html = renderHtmlReport({
    generatedAt: new Date("2026-03-28T12:00:00Z").getTime(),
    cutoff: new Date("2026-03-21T12:00:00Z").getTime(),
    days: 7,
    sessions: [session],
    generationCost: 0.01,
    skippedFiles: 0,
  });

  assert.match(html, /^<!doctype html>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /Completed &amp; verified/);
  assert.match(html, /Report generation cost/);
});

test("sorts reviewed sessions by descending cost", () => {
  const sessions = [
    { ...prepared("work"), id: "low", tagline: "Low", cost: 0.25, modified: 3 },
    { ...prepared("work"), id: "high", tagline: "High", cost: 4, modified: 1 },
    { ...prepared("work"), id: "middle", tagline: "Middle", cost: 1, modified: 2 },
  ] as ReviewedSession[];

  assert.deepEqual(
    sortSessionsByCost(sessions).map((session) => session.id),
    ["high", "middle", "low"],
  );
  assert.equal(sessions[0]?.id, "low");
});

test("aggregates cost and decided success rates by category", () => {
  const sessions = [
    { ...prepared("work"), category: "work", outcome: "success", cost: 2 },
    { ...prepared("work"), id: "session-2", category: "work", outcome: "failure", cost: 1 },
    {
      ...prepared("personal"),
      id: "session-3",
      category: "personal",
      outcome: "unclear",
      cost: 0.5,
    },
  ] as ReviewedSession[];

  const stats = categoryStats(sessions);
  assert.deepEqual(stats[0], {
    category: "work",
    count: 2,
    cost: 3,
    success: 1,
    failure: 1,
    unclear: 0,
  });
  assert.equal(stats[1]?.unclear, 1);
});
