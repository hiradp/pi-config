---
description: Review the current implementation plan independently with Sol and Kimi K3
argument-hint: "[additional instructions]"
---

Run one read-only review pass over the latest complete implementation plan in this conversation.

Additional instructions: ${@:-none}

1. Identify the plan, the original requirements it is meant to satisfy, and any findings from the preceding plan-review pass. If the target plan is missing or ambiguous, ask for clarification instead of reviewing the wrong artifact.
2. Use one `subagent` call in parallel mode to invoke `plan-reviewer` twice:
   - model `openai-codex/gpt-5.6-sol`
   - model `fireworks/accounts/fireworks/models/kimi-k3`
3. Give each isolated reviewer the complete plan, original requirements, relevant repository or scope context, these additional instructions, and prior findings when present. Ask both reviewers to perform a full independent plan review. Do not tell either reviewer about the other's output.
4. After both return, verify their alleged findings against the plan and repository before reporting them. Deduplicate overlapping findings and discard ungrounded claims. Preserve meaningful disagreements as questions rather than forcing consensus.
5. Report confirmed findings first, ordered by severity, and identify which model or models raised each one. Then report questions, prior-finding dispositions, testing gaps, and review coverage when applicable. If nothing remains after verification, say `No confirmed findings.`

Do not edit the plan or any repository files. Stop after presenting the synthesized review so feedback can be addressed in the original session.
