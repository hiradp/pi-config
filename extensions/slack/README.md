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
3. Register exactly this redirect URI:

   ```text
   http://localhost:3118/callback
   ```

4. Add only these user scopes:

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

5. Make the public, non-secret client ID available only for the initial login. To keep the value out of shell history and tracked configuration, prompt for it in `zsh` and pass it only to that Pi process:

   ```sh
   read -rs "SLACK_MCP_CLIENT_ID?Slack client ID: "
   printf '\n'
   SLACK_MCP_CLIENT_ID="$SLACK_MCP_CLIENT_ID" pi --no-session
   unset SLACK_MCP_CLIENT_ID
   ```

   For `fish`:

   ```fish
   read --silent --prompt-str 'Slack client ID: ' SLACK_MCP_CLIENT_ID
   echo
   env SLACK_MCP_CLIENT_ID="$SLACK_MCP_CLIENT_ID" pi --no-session
   set --erase SLACK_MCP_CLIENT_ID
   ```

   Run `/slack-login` in that Pi process. Validated credentials include the client ID and are stored together in the OS keyring. Later normal `pi` invocations use that keyring-bound client ID and do not require the environment variable. Supplying the variable again acts as an explicit client-ID pin; a mismatch invalidates the stored credentials.

For a directory-published app, pin the expected identity as appropriate:

```sh
export SLACK_MCP_EXPECTED_TEAM_ID='T0123456789'
export SLACK_MCP_EXPECTED_ENTERPRISE_ID='E0123456789'
```

The extension does not accept or store a client secret. Slack's OAuth metadata currently advertises `client_secret_post`, but Slack separately supports public PKCE desktop clients. If Slack rejects the public-client exchange, verify the app's PKCE configuration instead of adding a secret to this repository.

## Commands

- `/slack-login` starts a browser-based PKCE flow. It works only in TUI mode while Pi is idle and refuses to replace existing credentials.
- `/slack-status` shows the verified team/user identity, expiration, and exact effective scopes without showing tokens.
- `/slack-logout` closes the MCP session and removes credentials from the OS credential store. It does **not** revoke the Slack grant or uninstall the app.
- `/slack-discover` displays sanitized live MCP tool names, annotations, and input schemas for development review. It is a user command and is never available to the model.

Credentials are stored only in the operating system credential store through `@napi-rs/keyring`. There is no plaintext fallback.

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

## Troubleshooting

- **Not authenticated:** provide `SLACK_MCP_CLIENT_ID` to that process and run `/slack-login` directly in the TUI. A model tool can never open a browser. After login, normal invocations read the client ID from the keyring-backed credentials.
- **Public PKCE client rejected:** confirm PKCE is enabled and the callback URI is an exact match. Do not add a client secret.
- **Scope validation failed:** remove extra user scopes from the app, then run `/slack-logout` and `/slack-login`.
- **Authentication expires after about an hour:** Slack MCP may return an expiring access token without a refresh token. Run `/slack-login` again; the extension will not invent a refresh credential.
- **Approved tool unavailable or incompatible:** run `/slack-discover`, compare the live schema with `tools.ts`, and review Slack's change before updating the contract.
- **Credential store unavailable:** fix access to the OS keyring. The extension will not fall back to a file.
