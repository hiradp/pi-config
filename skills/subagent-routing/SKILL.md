---
name: subagent-routing
description: Required whenever considering or invoking the subagent tool. The configured user agents are only worker, plan-reviewer, and code-reviewer; never invent agent names. Routes exploration and implementation to worker, plan review through /review-plan, and code review through /review-code.
---

# Subagent Routing

Load and follow this skill before every `subagent` invocation.

## Agent catalog

Only these user agents are configured:

- `worker` — focused exploration, investigation, implementation, or other delegated work. State explicitly when its task must remain read-only.
- `plan-reviewer` — only a review pass explicitly authorized by `/review-plan` and containing the complete plan, requirements, and repository context.
- `code-reviewer` — only a code-review pass explicitly authorized by `/review-code` and containing the required `Review authorization:` and `Primary focus:` lines.

Do not invent specialized names such as `explorer`, `investigator`, `implementation-reviewer`, `security-reviewer`, or `footgun-reviewer`. Express the specialty in the task given to `worker`, or use the authorized review template.

## Routing rules

1. Use `worker` for exploration, investigation, implementation, and focused delegated analysis.
2. Use `plan-reviewer` only when the `/review-plan` template authorizes the invocation. Do not use it for routine plan creation or self-checking.
3. Use `code-reviewer` only when the `/review-code` template authorizes the invocation. Do not use it for routine post-change self-review.
4. Default to `agentScope: "user"`. Use project agents only when the user explicitly requests them and their exact names have been discovered.
5. Never set `confirmProjectAgents: false`. Preserve the confirmation for project-local agents.
6. An unknown-agent or `Unsupported task:` result means no delegation occurred. Do not describe it as a successful review or completed work.
7. After a failed dispatch, use only an exact name listed by the tool. Never retry with another guessed name.

Parallel tasks may invoke `worker` more than once when their scopes are independent and non-overlapping.
