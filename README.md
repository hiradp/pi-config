# Pi Config

[![CI](https://github.com/hiradp/pi-config/actions/workflows/ci.yml/badge.svg)](https://github.com/hiradp/pi-config/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Personal configuration, extensions, and skills for [Pi](https://pi.dev).

## Notion

`extensions/notion.ts` provides read-only `notion_search` and `notion_read` tools. It uses a
`token_v2` session supplied through `NOTION_TOKEN`; on macOS it can otherwise read the logged-in
Notion.app session from the Keychain and cookie database. The extension only calls Notion's private
read endpoints. Its approach is inspired by
[Matt Robenolt's Notion extension](https://github.com/mattrobenolt/pi-configs/tree/main/packages/notion).

## Development

```bash
pnpm install
pnpm check
pnpm format
```

## License

MIT. See [`LICENSE`](LICENSE). Vendored components retain their own copyright notices.
