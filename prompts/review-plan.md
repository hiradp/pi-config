---
description: Review the current implementation plan independently with Sol and Kimi K3
argument-hint: "[additional instructions]"
---

Run exactly one read-only review pass over the latest complete implementation plan in this conversation. This template authorizes one `subagent` call for this user request and no follow-up reviewer calls.

Additional instructions: ${@:-none}

1. Identify the plan, the original requirements it is meant to satisfy, and any findings from the preceding plan-review pass. If the target plan is missing or ambiguous, ask for clarification instead of reviewing the wrong artifact.
2. Use one `subagent` call in parallel mode to invoke `plan-reviewer` twice:
   - model `openai-codex/gpt-5.6-sol`, label `Plan review · Sol`
   - model `fireworks/accounts/fireworks/models/kimi-k3`, label `Plan review · Kimi K3`
3. Start each delegated task with `Review authorization: /review-plan`. Give each isolated reviewer the complete plan, original requirements, relevant repository or scope context, these additional instructions, and prior findings when present. Ask both reviewers to perform a full independent plan review. Do not tell either reviewer about the other's output.
4. Confirm that both children returned usable review output. Treat an unknown agent, `Unsupported task:`, failed, aborted, length-limited, or missing child result as a failed review pass. If either pass failed, identify the failed pass and stop without retrying, synthesizing findings, or saying `No confirmed findings.`
5. After both succeed, verify their alleged findings against the plan and repository before reporting them. Deduplicate overlapping findings and discard ungrounded claims. Preserve meaningful disagreements as questions rather than forcing consensus.
6. Report confirmed findings first, ordered by severity, and identify which model or models raised each one. Then report questions, prior-finding dispositions, testing gaps, and review coverage when applicable. If nothing remains after verification, say `No confirmed findings.`

Do not edit the plan or any repository files. Stop after presenting the synthesized review so feedback can be addressed in the original session. Do not automatically re-review revisions; another pass requires a new, explicit user request.
