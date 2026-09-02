import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { analyzeSessions } from "../session-review/analysis.ts";
import type { PreparedSession } from "../session-review/types.ts";

interface Call {
  ids: string[];
  maxTokens: number | undefined;
}

type Respond = (ids: string[], call: Call) => AssistantMessage | Promise<AssistantMessage>;

function session(id: string, evidenceLength = 100): PreparedSession {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    firstMessage: `First message of ${id}`,
    created: 1,
    modified: 2,
    repositories: [{ name: "repo", path: "/code/repo" }],
    evidence: "e".repeat(evidenceLength),
    cost: 1,
  };
}

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

function reply(
  text: string,
  cost: number,
  stopReason: AssistantMessage["stopReason"] = "stop",
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: usage(cost),
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function answer(ids: readonly string[], cost = 0.01): AssistantMessage {
  return reply(
    JSON.stringify({
      sessions: ids.map((id) => ({
        id,
        tagline: `Model tagline ${id}`,
        summary: `Model summary ${id}`,
        outcome: "success",
        outcomeConfidence: "high",
        outcomeReason: "Verified.",
        category: "work",
        categoryConfidence: "high",
        categoryReason: "Company repository.",
      })),
    }),
    cost,
  );
}

function model(maxTokens = 8_000): Model<Api> {
  return { id: "test-model", provider: "test", name: "Test", maxTokens } as unknown as Model<Api>;
}

function harness(respond: Respond) {
  const calls: Call[] = [];
  const ctx = {
    modelRegistry: {
      complete: async (_model: Model<Api>, context: Context, options?: { maxTokens?: number }) => {
        const content = context.messages[0]?.content as { text: string }[];
        const payload = JSON.parse(content[0]?.text ?? "{}") as { sessions: { id: string }[] };
        const call = {
          ids: payload.sessions.map((item) => item.id),
          maxTokens: options?.maxTokens,
        };
        calls.push(call);
        return respond(call.ids, call);
      },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, calls };
}

function closeTo(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`);
}

test("splits sessions into batches by count and evidence size", async () => {
  const many = Array.from({ length: 7 }, (_, index) => session(`s${index + 1}`));
  const byCount = harness((ids) => answer(ids));
  const counted = await analyzeSessions(many, model(), byCount.ctx);
  assert.deepEqual(
    byCount.calls.map((call) => call.ids),
    [["s1", "s2", "s3", "s4", "s5", "s6"], ["s7"]],
  );
  assert.deepEqual(
    counted.assessments.map((item) => item.tagline),
    many.map((item) => `Model tagline ${item.id}`),
  );
  closeTo(counted.generationCost, 0.02);
  assert.equal(counted.warning, undefined);

  const large = [session("big1", 40_000), session("big2", 40_000)];
  const bySize = harness((ids) => answer(ids));
  await analyzeSessions(large, model(), bySize.ctx);
  assert.deepEqual(
    bySize.calls.map((call) => call.ids),
    [["big1"], ["big2"]],
  );
});

test("retries a length-truncated batch in halves with the same token budget", async () => {
  const sessions = [session("a"), session("b")];
  const { ctx, calls } = harness((ids) =>
    ids.length > 1
      ? reply('{"sessions":[{"id":"a","tagline":"Model tag', 0.01, "length")
      : answer(ids, 0.02),
  );

  const result = await analyzeSessions(sessions, model(), ctx);

  assert.deepEqual(
    calls.map((call) => call.ids),
    [["a", "b"], ["a"], ["b"]],
  );
  assert.equal(calls[1]?.maxTokens, calls[0]?.maxTokens);
  assert.deepEqual(
    result.assessments.map((item) => item.tagline),
    ["Model tagline a", "Model tagline b"],
  );
  closeTo(result.generationCost, 0.05);
  assert.equal(result.warning, undefined);
});

test("raises the token limit for a single length-truncated session", async () => {
  const { ctx, calls } = harness((ids) =>
    calls.length === 1 ? reply("{", 0.01, "length") : answer(ids, 0.02),
  );

  const result = await analyzeSessions([session("solo")], model(), ctx);

  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.maxTokens, (calls[0]?.maxTokens ?? 0) * 2);
  assert.equal(result.assessments[0]?.tagline, "Model tagline solo");
  assert.equal(result.warning, undefined);
});

test("falls back for a persistently truncated batch and continues with the rest", async () => {
  const sessions = [session("stuck", 60_000), session("fine", 20_000)];
  const { ctx, calls } = harness((ids) =>
    ids[0] === "stuck" ? reply("{", 0.01, "length") : answer(ids, 0.02),
  );

  const result = await analyzeSessions(sessions, model(1_500), ctx);

  assert.deepEqual(
    calls.map((call) => call.ids),
    [["stuck"], ["fine"]],
  );
  assert.equal(result.assessments[0]?.id, "stuck");
  assert.equal(result.assessments[0]?.outcome, "unclear");
  assert.match(result.assessments[0]?.tagline ?? "", /First message of stuck/);
  assert.equal(result.assessments[1]?.tagline, "Model tagline fine");
  closeTo(result.generationCost, 0.03);
  assert.match(result.warning ?? "", /fell back for 1 session: .*truncated/);
});

test("falls back for an unreadable batch and continues with the rest", async () => {
  const sessions = [session("garbled", 60_000), session("fine", 20_000)];
  const { ctx } = harness((ids) =>
    ids[0] === "garbled" ? reply("no json here", 0.01) : answer(ids),
  );

  const result = await analyzeSessions(sessions, model(), ctx);

  assert.equal(result.assessments[0]?.outcome, "unclear");
  assert.equal(result.assessments[1]?.tagline, "Model tagline fine");
  assert.match(
    result.warning ?? "",
    /fell back for 1 session: review model returned no JSON object/,
  );
});

test("stops after a request error and falls back for the remaining sessions", async () => {
  const sessions = [session("first", 60_000), session("second", 20_000)];
  const { ctx, calls } = harness(() => reply("", 0.01, "error", "rate limited"));

  const result = await analyzeSessions(sessions, model(), ctx);

  assert.equal(calls.length, 1);
  assert.deepEqual(
    result.assessments.map((item) => item.outcome),
    ["unclear", "unclear"],
  );
  assert.match(result.warning ?? "", /Model analysis stopped: rate limited/);
});

test("returns the accumulated cost when cancelled between batches", async () => {
  const sessions = [session("done", 60_000), session("pending", 20_000)];
  const controller = new AbortController();
  const { ctx, calls } = harness((ids) => {
    controller.abort();
    return answer(ids, 0.03);
  });

  const result = await analyzeSessions(sessions, model(), ctx, controller.signal);

  assert.equal(calls.length, 1);
  closeTo(result.generationCost, 0.03);
  assert.equal(result.assessments[0]?.tagline, "Model tagline done");
  assert.equal(result.assessments[1]?.outcome, "unclear");
  assert.match(result.warning ?? "", /cancelled/);
});

test("keeps earlier cost when a cancelled request rejects", async () => {
  const sessions = [session("done", 60_000), session("aborted", 20_000)];
  const controller = new AbortController();
  const { ctx } = harness((ids) => {
    if (ids[0] === "done") return answer(ids, 0.02);
    controller.abort();
    throw new DOMException("The operation was aborted", "AbortError");
  });

  const result = await analyzeSessions(sessions, model(), ctx, controller.signal);

  closeTo(result.generationCost, 0.02);
  assert.equal(result.assessments[1]?.outcome, "unclear");
  assert.match(result.warning ?? "", /cancelled/);
});

test("resolves without requests when already cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  const { ctx, calls } = harness((ids) => answer(ids));

  const result = await analyzeSessions([session("never")], model(), ctx, controller.signal);

  assert.equal(calls.length, 0);
  assert.equal(result.generationCost, 0);
  assert.equal(result.assessments[0]?.outcome, "unclear");
  assert.match(result.warning ?? "", /cancelled/);
});
