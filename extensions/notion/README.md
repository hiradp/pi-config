# Notion

Read-only access to Notion through two model tools:

- `notion_search` searches every accessible workspace, or one workspace when a `spaceId` is given, and lists matching pages and databases with their URLs.
- `notion_read` converts a page to Markdown, or returns the first view of a database as a Markdown table. It accepts a Notion URL, a 32-character ID, or a dashed UUID.

Both tools only call Notion's read endpoints (`getSpaces`, `search`, `syncRecordValues`, `loadPageChunk`, `queryCollection`). Nothing is created, edited, or deleted. Notion content is treated as untrusted: terminal control sequences are stripped before text reaches the model or the screen.

## Authentication

`NOTION_TOKEN`, when set, is sent as the `token_v2` cookie. Use the decoded form (`v02:...`); the percent-encoded form shown by browser developer tools (`v02%3A...`) is accepted and decoded.

Otherwise, on macOS, the extension reads the logged-in Notion desktop app's `token_v2` cookie. It copies the app's Chromium cookie database, because Notion.app keeps the live file locked, reads the encrypted value with the `sqlite3` command bundled with macOS, and decrypts it with the "Notion Safe Storage" password from the macOS Keychain. The Keychain lookup may prompt for permission. It runs asynchronously, times out after 60 seconds, and Ctrl-C cancels it.

The token is cached for the Pi process. After a `401` the extension extracts it once more, so logging in again in Notion.app takes effect without restarting Pi.

## Limits

- Search returns at most 20 results per workspace.
- Database reads return at most the first 100 rows of the first view.
- Page reads load at most 10 chunks of 200 blocks, make at most 10 additional requests of 100 missing referenced blocks, and render nested blocks up to 5 levels deep. Content beyond these limits is marked as omitted.
- Synced blocks render their source content when Notion includes it in the page and are marked unavailable otherwise. User mentions render as `@` followed by the user ID.
- Requests time out after 20 seconds.
- Tool output is truncated at 2000 lines or 50KB, with a notice.
