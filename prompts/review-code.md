---
description: Review a code change independently for correctness and simplicity
argument-hint: "[target or additional instructions]"
---

Run exactly one read-only review pass over ${@:-the current working-tree change}. This template authorizes one `subagent` call for this user request and no follow-up reviewer calls.

1. Establish the exact review target, original intent, repository instructions, and any findings from the preceding code-review pass. Record the immutable PR head or branch `HEAD`; when reviewing uncommitted work, also identify the staged, unstaged, and relevant untracked state included in the pass. Default to that complete working-tree change when no other target is given.
2. Use one `subagent` call in parallel mode to invoke `code-reviewer` twice:
   - model `openai-codex/gpt-5.6-sol`, with primary focus `correctness/completeness`
   - model `fireworks/accounts/fireworks/models/kimi-k3`, with primary focus `simplicity`
3. Start each delegated task with `Review authorization: /review-code` and its exact `Primary focus:` value. Give each isolated reviewer the target, original intent and requirements, relevant scope context, and prior findings when present. Do not tell either reviewer about the other's output. For rollout-, version-skew-, feature-flag-, or configuration-sensitive targets, ask for proportionate coverage of reachable old/new component and configuration combinations during partial rollout, rollback and flag-disable behavior, and malformed, missing, mixed-provider, or other schema-admitted configurations; do not impose a generic exhaustive matrix on unrelated reviews.
4. Confirm that both children returned usable review output. Treat an unknown agent, `Unsupported task:`, failed, aborted, length-limited, or missing child result as a failed review pass. If either pass failed, identify the failed pass and stop without retrying, synthesizing findings, or saying `No confirmed findings.`
5. After both succeed, verify every alleged finding against the current code and review target. Deduplicate overlapping findings, discard ungrounded claims and style preferences, and preserve meaningful disagreements as questions.
6. Report confirmed findings first, ordered by severity, and identify which model or models raised each one. Then report questions, prior-finding dispositions, testing gaps, and review coverage when applicable. In review coverage, record the reviewed revision or working-tree state, confirm that both independent passes returned usable output, and state whether confirmed findings remain. If nothing remains after verification, say `No confirmed findings.`

Do not modify code, Git state, or external systems. Stop after presenting the synthesized review so feedback can be addressed in the original session. Do not automatically re-review fixes; another pass requires a new, explicit user request.
