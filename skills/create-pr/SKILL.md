---
name: create-pr
description: Create or prepare a GitHub pull request from the current repository and branch. Use when the user asks to open, create, draft, or prepare a PR or its description.
---

# Create PR

Create one focused pull request from the current repository while preserving the user's scope, voice, and safety constraints.

## Intent and authorization

- Treat an explicit request to **open** or **create** a PR as authorization for a normal push of the current task's non-default feature branch, if needed, followed by one `gh pr create`. Guardrails and repository rules still apply.
- A request to **prepare** or **draft a description** is local-only unless the user explicitly asks to publish it.
- Honor read-only constraints such as "don't post", "review only", or "don't push".
- PR creation does **not** authorize force-pushing, merging, closing or reopening PRs, commenting, editing unrelated PRs, changing branch protection, deploying, or publishing releases.
- Work only in the current repository unless the user explicitly names another repository.
- Ask before acting when the repository, head branch, base branch, task scope, or ownership of uncommitted changes is genuinely ambiguous.

## Inspect before mutation

1. Read the repository instructions and locate its PR template. Prefer the repository's template and preserve its section order.
2. Inspect the complete local state:
   - current branch and upstream
   - remotes and repository identity
   - `git status --short`
   - commits and diff relative to the intended base
3. Check whether the current branch already has a PR. This is read-only preparation. If one exists, report it instead of creating a duplicate; do not edit it unless requested.
4. Determine the base branch deliberately:
   - use a base explicitly named by the user;
   - for a stacked change, use the actual parent branch or PR;
   - otherwise use the repository's normal default branch.
5. Verify that `base...HEAD` contains only the intended change. Do not rebase, merge, switch branches, or retarget an existing PR merely to make creation convenient.
6. Account for every uncommitted change. When the user requested an end-to-end implementation followed by a PR, task-scoped commits are allowed. For a standalone "open a PR" request, do not silently absorb unrelated or unexplained changes.
7. Run the repository's required checks, plus proportionate checks for the changed area. Never claim a check passed unless it was run successfully.

## High-risk readiness

Load and follow the `high-risk-completion` skill when a defect in the change could cause an outage, data loss, security exposure, unsafe rollout, or major compatibility break.

- An implementation or PR request does not authorize `/review-code` or reviewer subagents.
- A high-risk change without a current successful independent review is not review-ready or merge-ready, even when checks pass and GitHub reports it as conflict-free.
- When the user requests a PR without specifying draft or ready status, publish an unreviewed high-risk change as a draft and report that independent review is pending.
- If the user explicitly requests a ready PR before review, explain the missing gate and ask whether to publish a draft or intentionally bypass it.
- Do not mark an existing draft ready until the gate passes or the user explicitly confirms an override.

## Title and description

- Inspect recent repository PR titles when necessary to match local conventions.
- Use a concise, specific title in the repository's established style.
- Keep the body terse, informal, and human. Avoid marketing language, generic filler, and unnecessary narration.
- Follow the PR template rather than inventing a competing format.
- Explain the reason for the change and the meaningful implementation details.
- Do not add a testing section for routine unit or integration tests, linters, type checks, builds, or other validation expected to run in CI.
- If the repository template requires a testing section, preserve it. When only routine validation was performed, write `CI.` and never enumerate routine commands or checks.
- Add testing details only when a novel, manual, or environment-specific check gives reviewers information that CI does not. Describe the behavior and result briefly; do not paste commands, flags, counts, timings, or terminal output.
- Disclose a failing or intentionally skipped required check only when it creates review or merge risk; do not add boilerplate such as "full test suite not run."
- Do not invent a security section. If the repository template asks for security impact and there is none, answer only `None.` without justification or reassurance. If there is a material security impact, state it and any mitigation concisely.
- Mention risk, rollout, compatibility, or follow-up work only when relevant.
- Do not mention AI assistance unless the user explicitly asks.
- Do not include unrelated changes just to make the PR appear more complete.

If no template exists, use this minimal structure:

```markdown
## What

<why this is needed and what changed>
```

Add another section only when it contains relevant, non-routine information.

## Publish safely

1. Ensure the task changes are committed and the working tree state is understood.
2. Push only the current non-default feature branch with a normal push. Never use `--force` or `--force-with-lease` unless the user separately and explicitly requests it and guardrails allow it.
3. Keep external mutations in separate commands. Do not chain a push, PR creation, comments, edits, or other GitHub mutations together.
4. Create exactly one PR with the selected head, base, title, body, and draft status. Use a temporary body file when it avoids quoting errors.
5. Create a draft PR only when requested, when the user explicitly establishes draft-first workflow, or when the `high-risk-completion` gate requires an unreviewed change to remain draft.
6. Do not add labels, reviewers, assignees, comments, or project metadata unless requested.
7. Verify the result with a read-only PR lookup and inspect local status. Verification is a follow-up check, not a second attempt to create or mutate the PR.

If GitHub is unavailable or verification fails, preserve the local state, avoid repeated mutation attempts, and report what succeeded, what remains uncertain, and the exact safe next step.

When an explicitly authorized publication was delegated, a worker may be unable to display a confirmation requested by the semantic guardrail. Treat that as an interaction-context blocker, not as a failed code review or evidence that `/review-code` is required. After verifying the worker's branch, commit, diff, checks, and clean state, resume the same push and PR creation from the interactive parent so the guardrail can request confirmation there. Do not bypass the guardrail, repeat the denied command in the worker, or change a required draft into a ready PR.

## Final response

Report concisely:

- PR title and URL, or the local description path if publication was not authorized
- base and head branches
- draft or ready status
- commits or files included at a high level
- checks run and their results
- independent-review status for a high-risk change, including the reviewed revision when applicable
- any remaining local changes, failures, or follow-up actions
