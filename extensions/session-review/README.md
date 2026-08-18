# Session review

`/session-review [days]` reviews Pi sessions active during a trailing local-time window and opens the result as a self-contained HTML file in the default browser. The default is seven days; `7d`, `14d`, and `30d` are accepted shortcuts. If the browser cannot be opened, the command reports the file path and falls back to the terminal view.

For each session it shows:

- a short tagline
- repositories inferred from the session working directory and file-tool paths
- a summary capped at 100 words
- recorded cost, excluding usage copied into forks and clones, with sessions sorted highest-cost first
- success, failure, or unclear outcome with confidence
- work, personal, or unclear classification with confidence

The command reads sessions locally, redacts common credential forms, removes absolute home paths, then asks for confirmation before sending bounded excerpts to the active model. The model calls used to produce the report have their own cost, displayed separately from historical session costs. Cancelling after a request is dispatched may still incur provider charges, even when the provider does not return final usage.

## Repository overrides

Edit [`config.json`](config.json) to classify known repositories without asking the model:

```json
{
  "work": ["company-api", "/Users/me/Code/company"],
  "personal": ["dotfiles", "/Users/me/Code/personal"]
}
```

A bare value matches a repository name. A path matches that repository or repositories beneath that directory. If work and personal rules both match, the model classifies the session instead.
