import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { loadSessionCorpus, parseSessionFile, reviewCutoff } from "../session-review/sessions.ts";

const DAY = 24 * 60 * 60 * 1_000;

function header(id: string, at: string, version?: number): string {
  return JSON.stringify({
    type: "session",
    ...(version === undefined ? {} : { version }),
    id,
    timestamp: at,
    cwd: "/code/repo",
  });
}

function assistantMessage(at: string, text: string, cost: number) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    },
    stopReason: "stop",
    timestamp: new Date(at).getTime(),
  };
}

function userMessage(at: string, text: string) {
  return { role: "user", content: [{ type: "text", text }], timestamp: new Date(at).getTime() };
}

function entryLine(entry: Record<string, unknown>, id?: string, parentId: string | null = null) {
  return JSON.stringify(id === undefined ? entry : { ...entry, id, parentId });
}

const AT = "2026-08-30T10:00:00.000Z";

test("skips a partial trailing line instead of dropping the session", () => {
  const entry = entryLine({ type: "message", timestamp: AT, message: userMessage(AT, "Fix") }, "a");
  const partial = '{"type":"message","id":"b","parentId":"a","timestamp":"2026-08-30T10:0';

  const parsed = parseSessionFile(`${header("s", AT, 3)}\n${entry}\n${partial}`);

  assert.ok(parsed);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0]?.id, "a");
  assert.equal(parsed.skippedLines, 1);
});

test("migrates version 1 session files that lack entry ids", () => {
  const lines = [
    header("legacy", AT),
    "null",
    entryLine({ type: "message", timestamp: AT, message: userMessage(AT, "Fix the tests") }),
    entryLine({ type: "message", timestamp: AT, message: assistantMessage(AT, "Done.", 1.5) }),
  ];

  const parsed = parseSessionFile(`${lines.join("\n")}\n`);

  assert.ok(parsed);
  assert.equal(parsed.skippedLines, 1);
  assert.equal(parsed.entries.length, 2);
  const [first, second] = parsed.entries as SessionEntry[];
  assert.equal(typeof first?.id, "string");
  assert.equal(first?.parentId, null);
  assert.equal(second?.parentId, first?.id);
});

test("counts malformed and malformed-shape lines while keeping the rest", () => {
  const valid = entryLine({ type: "message", timestamp: AT, message: userMessage(AT, "Fix") }, "a");
  const badShape = entryLine(
    { type: "message", timestamp: AT, message: { role: "assistant", content: [null] } },
    "b",
    "a",
  );

  const parsed = parseSessionFile(`${header("s", AT, 3)}\n{not-json}\n${valid}\n${badShape}\n`);

  assert.ok(parsed);
  assert.deepEqual(
    parsed.entries.map((entry) => entry.id),
    ["a"],
  );
  assert.equal(parsed.skippedLines, 2);
  assert.equal(parseSessionFile("{not-json}\n"), null);
  assert.equal(parseSessionFile(`${valid}\n`), null);
});

test("computes the trailing window from now", () => {
  const now = new Date("2026-08-31T12:00:00Z");
  assert.equal(reviewCutoff(7, now), now.getTime() - 7 * DAY);
});

test("loads entries only for sessions in the window and still attributes copied usage", async (t) => {
  const sessionDir = await mkdtemp(join(tmpdir(), "pi-session-review-corpus-"));
  t.after(() => rm(sessionDir, { recursive: true, force: true }));

  const oldAt = "2026-07-01T10:00:00.000Z";
  const copied = {
    type: "message",
    timestamp: oldAt,
    message: assistantMessage(oldAt, "Done.", 1.5),
  };
  await writeFile(
    join(sessionDir, "old.jsonl"),
    `${[
      header("old", oldAt),
      entryLine({ type: "message", timestamp: oldAt, message: userMessage(oldAt, "Fix") }),
      entryLine(copied),
    ].join("\n")}\n`,
  );

  const recentAt = "2026-08-30T10:00:00.000Z";
  await writeFile(
    join(sessionDir, "fork.jsonl"),
    `${[
      header("fork", recentAt, 3),
      entryLine({ ...copied, id: "a", parentId: null }),
      entryLine(
        { type: "message", timestamp: recentAt, message: assistantMessage(recentAt, "More.", 0.5) },
        "b",
        "a",
      ),
    ].join("\n")}\n{"type":"message","id":"c","parentId":"b"`,
  );

  const now = new Date("2026-08-31T12:00:00Z");
  const corpus = await loadSessionCorpus({ days: 7, now, sessionDir });

  assert.equal(corpus.cutoff, now.getTime() - 7 * DAY);
  assert.equal(corpus.skippedFiles, 0);
  assert.equal(corpus.skippedLines, 1);
  assert.deepEqual(
    corpus.sessions.map((session) => session.info.id),
    ["fork"],
  );
  assert.equal(corpus.sessions[0]?.entries.length, 2);
  const costFor = (name: string) =>
    [...corpus.costs.entries()].find(([path]) => path.endsWith(name))?.[1];
  assert.equal(costFor("old.jsonl"), 1.5);
  assert.equal(costFor("fork.jsonl"), 0.5);
});

test("rejects an aborted corpus load", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    loadSessionCorpus({
      days: 7,
      now: new Date(),
      signal: controller.signal,
      sessionDir: "/nonexistent",
    }),
    (error: unknown) => (error as Error).name === "AbortError",
  );
});
