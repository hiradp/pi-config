# AGENTS.md

## What this repo is

Personal configuration for the Pi coding agent. The repository root contains the authored files that are Stowed into `~/.pi/agent` by the `home` CLI. Runtime files such as authentication, sessions, trust state, installed packages, and generated model data remain untracked in `~/.pi/agent`.

There is no application build. Extensions are TypeScript and use the local pnpm/Oxc/TypeScript toolchain.

## Common commands

```bash
pnpm install  # Install extension development dependencies
pnpm check    # Check formatting, linting, types, and extension tests
pnpm format   # Format tracked extensions with Oxfmt
```

## Layout

- `settings.json` and `keybindings.json` are the portable Pi configuration.
- `extensions/` contains authored extensions and their tests.
- `skills/` contains authored and vendored Pi skills.
- `package.json`, `pnpm-lock.yaml`, and the Oxc/TypeScript files support extension development.
- `.stow-local-ignore` keeps repository-only files out of `~/.pi/agent`.

The root `.gitignore` pins authored files. `extensions/herdr-agent-state.ts` is installed and overwritten by herdr, so it remains ignored. Do not commit authentication, sessions, trust state, `node_modules`, Pi-installed packages, generated model data, or other runtime files.

Pi writes `settings.json` in place, so the Stow symlink survives upgrades. Pi upgrades may change `lastChangelogVersion`; commit or discard that one-line churn as appropriate.

## Git workflow

Work directly on `main`; do not create a feature branch or pull request unless explicitly requested. When the user asks for a commit, commit the completed change to `main`.

Follow the commit skill's message rules. Conventional Commit prefixes are not required. Keep commits tight and single-purpose.
