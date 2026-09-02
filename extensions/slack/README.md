# Read-only Slack MCP extension

This Pi extension connects only to Slack's hosted MCP endpoint at `https://mcp.slack.com/mcp`. It exposes four fixed model tools:

- `slack_search`
- `slack_read_channel`
- `slack_read_thread`
- `slack_search_users`

It does not expose generic MCP discovery/calling, file search, Slack writes, scripts, or model-triggered authentication.

## Slack app setup

Use a dedicated internal Slack app (or a directory-published app) that Slack permits to use MCP.

1. Enable **Slack Model Context Protocol (MCP) Server** in the app's Agents settings.
2. Enable PKCE. Slack treats a PKCE-enabled `localhost` redirect as a public desktop client.
3. Enable token rotation so Slack can issue refresh tokens for unattended renewal.
4. Register exactly this redirect URI:

   ```text
   http://localhost:3118/callback
   ```

5. Add only these user scopes:

   ```text
   search:read.public
   search:read.private
   search:read.im
   search:read.mpim
   search:read.users
   channels:history
   groups:history
   im:history
   mpim:history
   ```

6. Run `/slack-login`. On first use, Pi prompts for the public, non-secret client ID from the Slack app. It stores that ID separately from the OAuth credentials in the OS keyring, so token expiry, refresh failure, and `/slack-logout` do not forget the app configuration.

   `SLACK_MCP_CLIENT_ID` remains available as an optional explicit client-ID pin. A mismatch invalidates OAuth credentials from a different app.

For a directory-published app, pin the expected identity as appropriate:

```sh
export SLACK_MCP_EXPECTED_TEAM_ID='T0123456789'
export SLACK_MCP_EXPECTED_ENTERPRISE_ID='E0123456789'
```

The extension does not accept or store a client secret. Slack's OAuth metadata currently advertises `client_secret_post`, but Slack separately supports public PKCE desktop clients. If Slack rejects the public-client exchange, verify the app's PKCE configuration instead of adding a secret to this repository.

## Commands

- `/slack-login` starts a browser-based PKCE flow. It works only in TUI mode while Pi is idle and refuses to replace existing credentials. Only the Slack redirect carrying the login's state completes or aborts it; other requests to the callback port are answered and ignored.
- `/slack-status` shows the verified team/user identity, expiration, and exact effective scopes without showing tokens.
- `/slack-logout` closes the MCP session and removes OAuth credentials from the OS credential store. It retains the public client ID for future login and does **not** revoke the Slack grant or uninstall the app.
- `/slack-discover` displays sanitized live MCP tool names, annotations, and input schemas for development review. It is a user command and is never available to the model.

OAuth credentials and the public client ID are stored as separate entries in the operating system credential store through `@napi-rs/keyring`. There is no plaintext fallback.

## Read-only boundary

The OAuth grant must contain every configured scope and no additional scope, including no additional read scope. Initial and refreshed tokens must be Slack user tokens and must match any configured team or enterprise identity. If Slack's token response omits the team or user ID, login verifies the token through Slack's read-only `auth.test` endpoint before storing it.

The extension separately hardcodes the approved Slack MCP tool names and argument mappings. It checks the live tools for `readOnlyHint: true` and a compatible input schema before any model tool can run. Message search always sends `content_types: "messages"`. Unknown or changed tools fail closed.

Run `/slack-discover` after Slack changes its MCP server. Review schema changes before changing the hardcoded contracts in `tools.ts`.

## Privacy and retention

Slack results are sent to whichever model provider is selected in Pi. Normal Pi sessions also persist model-visible Slack output in session JSONL files. Use:

```sh
pi --no-session
```

when Slack content must not be retained in a Pi session. The extension has no separate Slack cache.

## Reliability

When Slack supplies a refresh token, the extension rotates credentials automatically before expiry. A transient metadata, network, rate-limit, or Slack service failure leaves the credentials intact so a later read can retry; that includes service errors Slack reports as HTTP 200 with `ok: false`. Only a known terminal OAuth error such as `invalid_refresh_token` or `token_revoked`, or a failed security validation, removes unusable credentials.

Several Pi processes (a second terminal, subagents) share the stored credentials, and Slack refresh tokens are single-use. A refresh therefore re-reads the store first and adopts tokens another process already rotated, and a process that loses a refresh race adopts the winner's tokens instead of deleting them.

No OAuth client can guarantee permanent unattended access. `/slack-login` is still required if Slack omits a refresh token, the grant is revoked, workspace policy requires reauthorization, or SSO demands user interaction. The separately stored client ID makes that a direct browser login instead of another environment-variable setup.

## Troubleshooting

- **Not authenticated:** run `/slack-login` directly in the TUI. Pi prompts for the public client ID only if it has never stored one. A model tool can never open a browser.
- **Public PKCE client rejected:** confirm PKCE is enabled and the callback URI is an exact match. Do not add a client secret.
- **Scope validation failed:** the error lists the missing and unexpected effective scopes. Align the app's user scopes with the required set, revoke or reinstall a stale Slack grant if needed, then run `/slack-logout` and `/slack-login`. Repeated entries in Slack's response are harmless because they do not change the effective permission set.
- **Authentication expires:** enable token rotation in the Slack app and run `/slack-login` again. If Slack still omits a refresh token, browser reauthorization cannot be automated safely.
- **Temporary refresh failure:** retry the Slack read later; transient failures no longer delete credentials.
- **Slack rejects the access token:** a token without a refresh token is kept after a rejected read. Retry; if it persists, run `/slack-logout` and `/slack-login`.
- **Approved tool unavailable or incompatible:** run `/slack-discover`, compare the live schema with `tools.ts`, and review Slack's change before updating the contract.
- **Credential store unavailable:** fix access to the OS keyring. The extension will not fall back to a file.
