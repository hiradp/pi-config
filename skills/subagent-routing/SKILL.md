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
3. Use `code-reviewer` only when the `/review-code` template authorizes the invocation. Every delegated reviewer task must begin with the literal line `Review authorization: /review-code`; never paraphrase it. Do not use it for routine post-change self-review.
4. Default to `agentScope: "user"`. Use project agents only when the user explicitly requests them and their exact names have been discovered.
5. Never set `confirmProjectAgents: false`. Preserve the confirmation for project-local agents.
6. Treat an unknown agent, `Unsupported task:`, failed, aborted, length-limited, or missing child result as a failed dispatch. Do not describe that scope as reviewed or completed.
7. If a parallel invocation partially fails, use only the successful children's output and identify every scope that was not completed. Never infer findings or completion for a failed child.
8. After a failed dispatch, use only an exact name listed by the tool. Never retry with another guessed name.
9. Do not claim `No confirmed findings`, successful review, or completed delegated work unless every required child returned usable output.

## Publication boundary

A worker may publish only when its delegated task contains a `Publication authorization:` line that states the user's authorization and identifies the repository plus the allowed branch or branch pattern. The bounded worker publication policy permits normal pushes to non-default `hiradp/*` branches, normal pushes to non-default branches in `hiradp`-owned repositories, draft PR creation, title/body updates to a PR whose head is the authorized branch, and conversion of that PR to draft.

When the user requests implementation followed by publication:

1. Carry the user's authorization into each applicable worker task with an explicit `Publication authorization:` line. Do not rely on phrases such as "if you publish" or "PR reorganization is acceptable."
2. Tell the worker the repository, intended base, and known branch or permitted `hiradp/*` pattern. State whether replacing an existing PR with a fresh draft is allowed.
3. Do not authorize force pushes, default-branch pushes, readying, merging, closing, reopening, comments, labels, reviewers, or unrelated PR mutations unless a separate policy and explicit user request permit the specific action.
4. If publication is blocked only because the worker has no confirmation UI, verify its reported revision and working-tree state, then resume the same authorized action from the interactive parent. Do not ask the user to repeat authorization.
5. Do not substitute `/review-code` for draft publication. Apply the high-risk readiness rules separately: an unreviewed high-risk PR may be published as a draft, but not presented as ready.

Parallel tasks may invoke `worker` more than once when their scopes are independent and non-overlapping.
