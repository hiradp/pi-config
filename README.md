# Pi Config

[![CI](https://github.com/hiradp/pi-config/actions/workflows/ci.yml/badge.svg)](https://github.com/hiradp/pi-config/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Personal configuration, extensions, and skills for [Pi](https://pi.dev).

## Porter

`extensions/porter/` adds a `porter` tool for explicitly authorized Git shipping work. Porter
runs in an isolated `openai-codex/gpt-5.6-luna:high` session with only `read` and `bash`; it can
inspect, check, commit, and, when the user requested it, push and open a pull request. It cannot
edit files and keeps the guardrails extension enabled.

## Notion

`extensions/notion.ts` provides read-only `notion_search` and `notion_read` tools. It uses a
`token_v2` session supplied through `NOTION_TOKEN`; on macOS it can otherwise read the logged-in
Notion.app session from the Keychain and cookie database. The extension only calls Notion's private
read endpoints. Its approach is inspired by
[Matt Robenolt's Notion extension](https://github.com/mattrobenolt/pi-configs/tree/main/packages/notion).

## Slack

`extensions/slack/` provides fixed read-only tools backed by Slack's official hosted MCP server.
It uses public-client PKCE OAuth and stores credentials only in the operating system keyring. See
[`extensions/slack/README.md`](extensions/slack/README.md) for Slack app setup, scopes, privacy, and
session-retention guidance.

## Development

```bash
pnpm install
pnpm check
pnpm format
```

## License

MIT. See [`LICENSE`](LICENSE). Vendored components retain their own copyright notices.
