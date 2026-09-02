import assert from "node:assert/strict";
import { test } from "node:test";
import { canLookupPullRequest, classifyPullRequest } from "../ui/status-footer.ts";

function open(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: "OPEN",
    isDraft: false,
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    statusCheckRollup: [],
    latestReviews: [],
    ...overrides,
  };
}

test("classifies merged and closed pull requests", () => {
  assert.equal(classifyPullRequest({ state: "MERGED" }), "merged");
  assert.equal(classifyPullRequest(open({ mergedAt: "2026-03-18T00:00:00Z" })), "merged");
  assert.equal(classifyPullRequest({ state: "CLOSED" }), "other");
  assert.equal(classifyPullRequest({}), "other");
});

test("flags failed checks and requested changes ahead of anything pending", () => {
  assert.equal(
    classifyPullRequest(open({ statusCheckRollup: [{ conclusion: "FAILURE" }] })),
    "failed",
  );
  assert.equal(classifyPullRequest(open({ statusCheckRollup: [{ state: "ERROR" }] })), "failed");
  assert.equal(classifyPullRequest(open({ reviewDecision: "CHANGES_REQUESTED" })), "failed");
  assert.equal(
    classifyPullRequest(
      open({
        statusCheckRollup: [{ status: "IN_PROGRESS" }, { conclusion: "TIMED_OUT" }],
        reviewDecision: "REVIEW_REQUIRED",
      }),
    ),
    "failed",
  );
});

test("treats running checks and review activity as pending", () => {
  assert.equal(classifyPullRequest(open({ statusCheckRollup: [{ status: "QUEUED" }] })), "pending");
  assert.equal(classifyPullRequest(open({ statusCheckRollup: [{ state: "PENDING" }] })), "pending");
  assert.equal(classifyPullRequest(open({ reviewDecision: "REVIEW_REQUIRED" })), "pending");
  assert.equal(classifyPullRequest(open({ latestReviews: [{ state: "COMMENTED" }] })), "pending");
  assert.equal(
    classifyPullRequest(
      open({
        statusCheckRollup: [null, "bogus", { conclusion: "SUCCESS", status: "COMPLETED" }],
        latestReviews: [{ state: "APPROVED" }],
      }),
    ),
    "ready",
  );
});

test("marks clean non-draft pull requests ready and everything else other", () => {
  assert.equal(classifyPullRequest(open()), "ready");
  assert.equal(classifyPullRequest(open({ isDraft: true })), "other");
  assert.equal(classifyPullRequest(open({ mergeStateStatus: "BLOCKED" })), "other");
  assert.equal(
    classifyPullRequest(
      open({ reviewDecision: "APPROVED", statusCheckRollup: [{ conclusion: "SUCCESS" }] }),
    ),
    "ready",
  );
});

test("skips pull request lookups without a real branch", () => {
  assert.equal(canLookupPullRequest("fix/ui-usage"), true);
  assert.equal(canLookupPullRequest("detached"), false);
  assert.equal(canLookupPullRequest(""), false);
  assert.equal(canLookupPullRequest(null), false);
});
