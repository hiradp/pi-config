---
description: Review a code change independently for correctness and simplicity
argument-hint: "[target or additional instructions]"
---

Run exactly one read-only review pass over ${@:-the current working-tree change}. This template authorizes one `subagent` call for this user request and no follow-up reviewer calls.

1. Establish the exact review target, original intent, repository instructions, and any findings from the preceding code-review pass. Default to staged, unstaged, and relevant untracked changes when no other target is given.
2. Use one `subagent` call in parallel mode to invoke `code-reviewer` twice:
   - model `openai-codex/gpt-5.6-sol`, with primary focus `correctness/completeness`
   - model `fireworks/accounts/fireworks/models/kimi-k3`, with primary focus `simplicity`
3. Start each delegated task with `Review authorization: /review-code` and its exact `Primary focus:` value. Give each isolated reviewer the target, original intent and requirements, relevant scope context, and prior findings when present. Do not tell either reviewer about the other's output.
4. After both return, verify every alleged finding against the current code and review target. Deduplicate overlapping findings, discard ungrounded claims and style preferences, and preserve meaningful disagreements as questions.
5. Report confirmed findings first, ordered by severity, and identify which model or models raised each one. Then report questions, prior-finding dispositions, testing gaps, and review coverage when applicable. If nothing remains after verification, say `No confirmed findings.`

Do not modify code, Git state, or external systems. Stop after presenting the synthesized review so feedback can be addressed in the original session. Do not automatically re-review fixes; another pass requires a new, explicit user request.
