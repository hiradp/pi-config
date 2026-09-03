---
description: Review recent Pi activity and identify the single most important next action
argument-hint: "[today|yesterday|24h|YYYY-MM-DD]"
---
Produce a read-only daily review of my Pi activity for ${@:-today}.

1. Read the relevant entries from `~/.pi/agent/sessions/**/*.jsonl`. Interpret `today`, `yesterday`, and explicit dates as local calendar periods; `24h` means the trailing 24 hours. Select entries by their timestamps rather than including an entire session because its file changed. Exclude this daily-review request itself.
2. Analyze locally before drawing conclusions. Capture session and prompt counts, cost when recorded, repositories and Forest workspaces touched, completed outcomes, unfinished work, repeated context reconstruction, and time spent on Pi or workflow tooling. Skip malformed or partially written lines.
3. Keep session evidence bounded. Inspect user and assistant text plus tool-call names, but do not emit full tool-result bodies. Redact credentials and avoid reproducing unrelated sensitive details.
4. If PlanetScale workspaces were touched, use `git forest list` and `git forest status` from `~/Code/planetscale`, then read only the relevant workspace `CONTEXT.md` files when they exist. Treat those files as handoffs rather than unquestioned truth. Do not query Slack, Notion, GitHub, Kubernetes, or other external systems.
5. Distinguish confirmed facts from inference. Optimize for delivery and closure, not activity volume. Do not recommend more Pi or git-forest work unless the evidence shows it directly blocks delivery.

Return concise Markdown with exactly these sections:

# Daily review — <local date or range>

## Shipped
Concrete completed or verified outcomes.

## Still in flight
Material unfinished work and rollout obligations.

## Focus
Session count, repositories/workspaces touched, notable context switching, and workflow-tooling share. Omit metrics that cannot be supported.

## Most important next action
Exactly one concrete action, with a short evidence-based reason.

## Do not work on
Exactly one likely distraction, or `Nothing identified` when the evidence does not support one.

Do not modify files or external systems. Stop after the report.
