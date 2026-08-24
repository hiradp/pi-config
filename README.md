# Pi Config

[![CI](https://github.com/hiradp/pi-config/actions/workflows/ci.yml/badge.svg)](https://github.com/hiradp/pi-config/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Personal configuration, extensions, and skills for [Pi](https://pi.dev).

## What's included

### Extensions

- **Claude Code** — delegates prompts to the official Claude Code CLI with configurable model and effort, defaulting to Opus at high effort. Delegation is inactive by default; `/claude-tool on` arms it for one invocation.
- **[Guardrails](extensions/guardrails/README.md)** — deterministic safety policies for agent tools and user shell commands, with optional scoped semantic review. Includes `/guardrails status`, `/guardrails config`, `/guardrails reload`, `/guardrails denials`, `/guardrails reviews`, `/guardrails reset`, and interactive maintenance mode.
- **Notion** — read-only `notion_search` and `notion_read` tools for finding and reading pages and databases. See [`extensions/notion/`](extensions/notion/).
- **Response annotator** — `/annotate-response [app]` opens the latest assistant response in the configured external editor or a named app such as Zed or MarkEdit, then loads the annotated text into Pi's chat editor.
- **[Session review](extensions/session-review/README.md)** — `/session-review [days]` summarizes recent sessions with repositories, deduplicated cost, outcome, and work/personal classification.
- **[Slack](extensions/slack/README.md)** — fixed, read-only MCP tools: `slack_search`, `slack_read_channel`, `slack_read_thread`, and `slack_search_users`. Includes `/slack-login`, `/slack-status`, `/slack-logout`, and `/slack-discover`.
- **[Subagent](extensions/subagent/README.md)** — runs isolated, model-selectable agents individually, in parallel, or as a chain. Includes plan and code review passes using Sol and Kimi K3.
- **Usage** — `/usage` shows token usage, cost, and recent trends from Pi sessions.
- **Working message** — displays live request progress, token counts, and thinking time, then records a compact completion entry.
- **Footer** — custom status footer with model, context, cost, quota, and pull-request information where available.

### Skills

- **commit** — inspect, organize, and create focused local Git commits.
- **create-pr** — prepare or publish a focused GitHub pull request when explicitly requested.
- **deslop** — remove unnecessary AI-generated comments and section headers from code changes.
- **review** — perform read-only reviews of diffs, branches, pull requests, files, and design documents.

## Development

```bash
pnpm install
pnpm check
pnpm format
```

## License

MIT. See [`LICENSE`](LICENSE). Vendored components retain their own copyright notices.
