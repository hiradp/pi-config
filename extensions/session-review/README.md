# Session review

`/session-review [days]` reviews Pi sessions active in a trailing window and opens the result as a self-contained HTML file in the default browser. The window is the last `days` × 24 hours ending now, not calendar days; dates in the report are shown in local time. The default is seven days; `7d`, `14d`, and `30d` are accepted shortcuts. If the browser cannot be opened, the command reports the file path and falls back to the terminal view.

For each session it shows:

- a short tagline
- repositories inferred from the session working directory and file-tool paths
- a summary capped at 100 words
- recorded cost, excluding usage copied into forks and clones, with sessions sorted highest-cost first
- success, failure, or unclear outcome with confidence
- work, personal, or unclear classification with confidence

The command reads sessions locally the way Pi does: a line it cannot parse, such as one another Pi process is still writing, is skipped and counted in the report rather than hiding the session. It redacts common credential forms, removes absolute home paths, then asks for confirmation before sending bounded excerpts to the active model. The model calls used to produce the report have their own cost, displayed separately from historical session costs. Cancelling after a request is dispatched may still incur provider charges, even when the provider does not return final usage.

## Redaction

Redaction catches `Cookie`, `Set-Cookie`, and `Authorization` headers, PEM private keys, JWTs, credentials embedded in URLs, well-known token prefixes (`sk-`, `ghp_`, `glpat-`, `xox`, AWS access keys), and values assigned to keys or flags named `token`, `secret`, `password`, `passwd`, `api-key`, `access-token`, `refresh-token`, `authorization`, or `x-api-key`, plus any key containing `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `API_KEY`, `PRIVATE_KEY`, or `AUTH`. Values under other names, such as `DB_PASS=`, are sent as they appear.

## Repository overrides

Edit [`config.json`](config.json) to classify known repositories without asking the model:

```json
{
  "work": ["company-api", "/Users/me/Code/company"],
  "personal": ["dotfiles", "~/Code/personal"]
}
```

A bare value matches a repository name. A path matches that repository or repositories beneath that directory; `~` expands to the home directory. If work and personal rules both match, the model classifies the session instead.
