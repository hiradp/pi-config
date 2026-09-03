# Guardrails redesign plan

## Decision

Do a targeted rewrite, not a ground-up replacement.

Keep the extension lifecycle, policy interface, configuration loader, confirmation UI, last-known-good behavior, Git/Kubernetes policy concepts, and test harness. Replace shell-based filesystem enforcement and broad semantic-review selection with an OS sandbox and structured external-effect classification.

## Goals

- Make filesystem and process containment an operating-system boundary rather than a partial shell-parser promise.
- Preserve normal repository editing, testing, commits, pushes, and read-only infrastructure inspection.
- Run semantic review only for actual external mutations.
- Fail closed when safety configuration or sandbox initialization is invalid.
- Reduce model-review latency, confirmation fatigue, prompt tokens, and session-state growth.
- Report semantic-review usage, cost, and latency.

## Non-goals

- Implement a complete POSIX shell interpreter.
- Treat project trust as a runtime sandbox.
- Let repository-owned configuration weaken user-owned guardrails.
- Rely on semantic classification to override deterministic blocks.

## Target decision flow

```text
tool call
  -> normalize structured action
  -> deterministic policies
       -> direct write/edit path checks
       -> blocked executable checks
       -> Git default-branch/ref checks
       -> Kubernetes command allowlist
  -> classify external effect
       -> read-only: allow
       -> known mutation: semantic review
       -> unknown/opaque: user confirmation
  -> execute bash inside OS sandbox
```

## Phase 1: reduce cost and close deterministic gaps

This phase does not change command execution.

### 1. Classify GitHub operations

Replace the bare `gh` semantic scope with deterministic operation categories.

Auto-allow recognized reads, including:

- `gh pr view`, `list`, `checks`, `diff`, and `status`
- `gh issue view` and `list`
- `gh search ...`
- `gh run view`, `list`, and `watch`
- `gh repo view`
- `gh api` using GET or HEAD without mutation fields

Review recognized mutations, including:

- PR create, edit, merge, close, reopen, ready, review, and comment
- issue create, edit, close, reopen, and comment
- workflow dispatch
- run cancel, rerun, and delete
- release create, edit, upload, and delete
- repository create, edit, rename, archive, delete, and fork
- non-GET GitHub API calls

Treat GraphQL and unrecognized API forms as unknown and require confirmation.

Classify every shell segment. Permit a compound command automatically only when every segment is a recognized read or benign local transformation. Pipes to tools such as `jq` should not turn a read into a semantic review.

### 2. Fix Git default-branch checks

Handle:

- `--repo value` and `--repo=value`
- command-local aliases such as `git -c alias.x=push x`
- commit-producing operations such as merge, revert, cherry-pick, am, and continuation commands
- explicit and implicit refspecs

Prefer canonical absolute repository paths for exemptions. Do not treat the presence of any matching remote URL as proof that a repository is trusted.

### 3. Make configuration strict

- Reject unknown keys instead of merely recording diagnostics.
- Trim configured strings before storing them.
- Reject duplicate/ambiguous executable aliases.
- Show configuration diagnostics at session start.
- Continue using the last-known-good configuration after a failed reload.
- Without a last-known-good configuration, block side effects.

### 4. Change sensitive-file review

Until semantic review receives a bounded redacted diff, sensitive CI changes must always require user confirmation. A path-only model review must never return an automatic allow.

Sensitive paths include:

- `.github/workflows/**`
- `.circleci/**`
- `.gitlab-ci.yml`
- other future deployment or credential-bearing configuration

### 5. Track semantic usage

Record per review:

- model
- input, output, cache, and reasoning usage when available
- calculated cost
- elapsed time
- decision
- sanitized action summary

Expose aggregate totals through `/guardrails status` and bounded detail through `/guardrails reviews`.

Persist compact individual records or counters rather than rewriting the complete recent-history ring on every event.

### Phase 1 acceptance criteria

- Read-only GitHub commands work in ordinary pipes and read-only chains without a model call.
- Known GitHub mutations still receive semantic review.
- `git push --repo origin main` is blocked from a feature branch.
- Unknown configuration keys make a new configuration invalid.
- Sensitive CI edits cannot be auto-allowed without content evidence.
- Semantic review cost and latency appear in guardrail status.

## Phase 2: add OS-level sandboxing

Use `@anthropic-ai/sandbox-runtime` through Pi's `BashOperations` interface. Override the built-in `bash` tool and route `user_bash` through the same operations.

### Required integration behavior

- Load sandbox policy only from trusted user-owned configuration.
- Do not merge project-local sandbox settings that can expand access.
- Fail closed if sandbox initialization fails.
- Apply restrictions to the complete child process tree.
- Forward cancellation, timeout, stdout, and stderr consistently with Pi's built-in bash tool.
- Reset sandbox resources during `session_shutdown`.
- Attach a unique command ID to violation records.

### Initial filesystem policy

- Allow writes to the current workspace and `/tmp`.
- Deny writes to guardrail settings and extension sources even when the current workspace contains them.
- Deny writes outside explicitly allowed roots.
- Deny reads of SSH, cloud, GPG, and other credential directories unless a workflow explicitly requires narrowly scoped access.
- Keep `allowAppleEvents` disabled.
- Keep weaker nested/network isolation disabled.
- Do not allow broad Unix sockets such as the Docker socket by default.

Workspace `.git` needs special treatment because normal Git operations write there. Start by allowing ordinary repository Git behavior while retaining direct path checks. Consider a separate brokered Git mutation path if stronger `.git` isolation is required.

### Initial network policy

Start with the domains required by normal development, then narrow from observed failures. Domain allowlisting does not authorize mutations: semantic external-effect policies still govern pushes, publications, deployments, and API writes.

### Sandbox failure behavior

Never copy the demonstration fallback that silently runs the command unsandboxed. Failure should produce an error similar to:

```text
Sandbox initialization failed; refusing unsandboxed command execution.
```

### Phase 2 acceptance criteria

The following must be blocked by the OS boundary rather than parser recognition:

- nested `sh -c` writes to protected locations
- writes performed by Python, Node, Ruby, or other interpreters
- recursive deletion through root globs such as `rm -rf /*`
- symlink-based writes outside the workspace
- writes to guardrail settings or sources
- unauthorized network destinations

Normal repository reads, writes, tests, and approved external operations must continue to work.

## Phase 3: remove obsolete parser complexity

After sandboxing is stable:

- Remove shell-based filesystem mutation-target inference.
- Consolidate command handling into one lexer/classifier used by all command policies.
- Use the classifier only for command identity, Git/Kubernetes validation, and external-effect routing.
- Treat dynamic or unsupported syntax as unknown rather than allowed.
- Remove duplicate state/config copy helpers and obsolete compatibility loaders.
- Shorten injected prompt guidance to a compact behavioral summary.
- Update documentation so deterministic policy, semantic intent review, confirmation, and sandbox guarantees are clearly separated.

## Suggested resulting layout

```text
extensions/guardrails/
  index.ts
  config.ts
  policy.ts
  actions.ts
  shell-classifier.ts
  sandbox.ts
  audit.ts
  semantic-review.ts
  policies/
    filesystem.ts
    blocked-commands.ts
    git.ts
    kubernetes.ts
    external-effects.ts
```

## Test strategy

### Deterministic unit tests

Cover:

- nested shell interpreters and wrappers
- command substitution, globs, brace expansion, and redirection variants
- every recognized GitHub read and mutation
- compound read-only pipelines
- Git refspec and option variants
- Kubernetes aliases and global options
- strict configuration parsing
- semantic evidence redaction and usage accounting

### Sandbox integration tests

Run harmless probes in temporary directories and verify:

- allowed workspace writes succeed
- denied external writes fail
- symlink escapes fail
- child and grandchild processes remain restricted
- network allow/deny rules apply
- initialization failure blocks execution
- cancellation and timeout terminate the complete process group

### Pi integration tests

Verify both agent `bash` calls and user `!` commands use sandbox operations. Verify custom extension tools remain outside the sandbox unless explicitly routed, and document that limitation.

## Rollout

1. Implement Phase 1 and compare semantic-review counts, confirmation rate, false blocks, and latency against the current baseline.
2. Add sandbox support behind a user-owned opt-in setting and run normal development workflows.
3. Change the default to enabled after the compatibility suite is stable.
4. Remove obsolete shell filesystem inference only after sandbox enforcement is proven.
5. Retain an emergency, time-limited interactive maintenance mechanism, but never silently fall back to unsandboxed execution.

## Baseline to compare against

At the time of planning:

- 1,342 recorded semantic reviews across 108 sessions
- approximately 1.42 hours of measured semantic-review latency
- mean reviewer latency around 3.9 seconds and p95 around 6.4 seconds
- 408 confirmations and 71 blocks
- approximately 5.55 MiB of persisted guardrail state
- roughly 1,002 characters, or about 251 tokens, of injected guardrail guidance per main-model request

The main Phase 1 success metric is an 80% or greater reduction in semantic calls for read-only GitHub work without weakening mutation review.

## Open decisions

- Is the intended threat model accidental agent mistakes, adversarial prompt injection, or both?
- Should workspace reads be restricted, or only writes outside the workspace?
- Which credentials, sockets, and network domains are required for routine workflows?
- Should approved Git mutations run through a separate unsandboxed broker to permit `.git` writes while protecting Git configuration and hooks?
- Should sensitive-file review remain human-only or receive a bounded redacted diff?
- Should user-entered `!` commands be sandboxed identically to agent commands, or have a separately configurable policy?

## Relevant documentation

- Pi security: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/security.md`
- Pi containerization: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/containerization.md`
- Pi extensions: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- Pi sandbox example: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/sandbox/index.ts`
- Anthropic Sandbox Runtime: <https://github.com/anthropic-experimental/sandbox-runtime>
- Anthropic package: <https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime>
