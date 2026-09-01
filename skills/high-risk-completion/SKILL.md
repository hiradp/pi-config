---
name: high-risk-completion
description: Required when implementing, preparing a PR, or reporting completion for production-sensitive changes where a defect could cause an outage, data loss, security exposure, unsafe rollout, or major compatibility break. Gates complete, review-ready, mergeable, and safe claims on a current successful independent review.
---

# High-Risk Completion

Use this skill to separate implementation progress from evidence that a production-sensitive change is ready.

## Classify the change

Treat a change as high risk when a credible defect could cause a P0 or P1 outcome, especially when it affects:

- data durability, replication, backup, restore, or recovery;
- authentication, authorization, credentials, or trust boundaries;
- deployments, releases, feature-flag activation, rollout ordering, rollback, or version skew;
- schemas, migrations, protocols, APIs, CRDs, or persisted configuration compatibility;
- controllers, operators, infrastructure, or distributed-system state transitions.

Do not classify a change as high risk merely because it is in a production repository. Documentation, test-only changes, and bounded local tooling normally do not require this gate unless they directly control production behavior.

## Require current review evidence

A qualifying independent review must:

1. Be explicitly requested by the user through `/review-code`; an implementation or PR request does not authorize reviewer subagents.
2. Complete both required review passes with usable output under the subagent-routing rules.
3. Cover the final implementation, including its exact PR head or branch `HEAD` and any reviewed working-tree changes.
4. Leave no unresolved confirmed findings. A finding may be fixed, rejected after grounded verification, or explicitly accepted by the user with the remaining risk disclosed. A code change made after review makes that review stale and requires a new explicit review request.

Tests, CI, linters, snapshots, self-review in the implementation context, and GitHub's conflict-free `mergeable` state do not substitute for independent review.

If review has not been requested, stop after implementation and checks. Tell the user that independent review remains and that `/review-code` is the next step. Do not invoke it autonomously.

If review dispatch is incomplete or unusable, fail closed under the subagent-routing skill. If review finds defects, report them and stop. Fixing findings does not authorize re-review; ask the user to invoke `/review-code` again after fixes.

## Use precise readiness language

Use the narrowest status supported by evidence:

- Before review: `Implementation and checks completed; independent review pending.`
- Failed or partial review: `Implementation completed; independent review incomplete.`
- Findings remain: `Independent review completed; confirmed findings remain.`
- Fixes changed reviewed code: `Findings addressed; independent re-review pending.`
- Current successful review with no unresolved findings: the change may be described as `reviewed` or `ready for human review`.

Do not call a high-risk change `complete`, `review-ready`, `mergeable`, `safe to merge`, or `safe to deploy` before the gate passes. Even after the gate passes, distinguish code-review readiness from deployment readiness and disclose required rollout, operational, or environment validation.

## Pull requests

When the user requests a PR for an unreviewed high-risk change without specifying draft or ready status, create a draft and report that independent review is pending. Do not mark a draft ready until the gate passes.

If the user explicitly requests a ready PR before the gate passes, explain the missing review and ask whether to publish it as a draft or intentionally bypass the readiness gate. An override does not authorize claiming the change was reviewed, merge-ready, or safe.

## Final response

Report separately:

- implementation status;
- deterministic checks and their results;
- independent-review status and reviewed revision;
- unresolved findings or stale review state;
- PR status, if applicable;
- rollout or operational validation that still remains.
