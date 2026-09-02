# Subagent

This customized extension is based on Pi's official [subagent example](https://github.com/earendil-works/pi-mono/tree/main/packages/coding-agent/examples/extensions/subagent) and is maintained against Pi version 0.84.4.

It adds a `subagent` tool that can run user-defined agents in isolated Pi processes, either individually, in parallel, or as a chain. Each invocation may select a model; selection precedence is invocation, agent definition, then the dispatching session. Usage from child model calls is included in parent-session accounting, and any failed child marks the complete tool result as failed while preserving its diagnostics.

A child counts as completed only when it exits 0 with a final `stop` response that has text and does not begin with `Unsupported task:`. Anything else, including unparseable output lines and the per-child wall-clock limit (45 minutes by default, `timeoutMs` to override), is reported as failed with a reason. On session shutdown every live child process group is terminated.

Dispatching `code-reviewer` or `plan-reviewer` requires the current user message to contain the authorization line that `/review-code` or `/review-plan` emits, and each such message covers one `subagent` call. The model cannot write a user message, so running the template is the gate.

Children never receive the `subagent` or `claude` tools, and they carry a `PI_SUBAGENT_DEPTH` environment marker that makes the tool refuse nested dispatch, so delegation is at most one level deep.

Project-local agents (`agentScope: "project"` or `"both"`) run only when Pi's project trust is active and the user confirms them in the UI; a headless session refuses them, and a project agent never replaces a user agent of the same name.

While children are active, the tool renders a stable dashboard with queued/running/completed/failed states, each child's responsibility, latest action, elapsed time, turns, output tokens, cost, and model. Calls may provide a short `label`; otherwise the task text identifies the responsibility. Running labels use the same shimmer as Pi's working message without adding a dashboard timer, so they reuse the working row's existing repaints. Completed output stays collapsed until the tool-detail keybinding is used.

## Local agents

- [`worker`](../../agents/worker.md) implements focused delegated tasks with the dispatching session's model and default tools, minus `subagent` and `claude`. It shares the selected working directory with the parent and sibling agents, so parallel workers should receive non-overlapping scopes.
- [`plan-reviewer`](../../agents/plan-reviewer.md) verifies implementation plans against their requirements and repository using read-only file tools.
- [`code-reviewer`](../../agents/code-reviewer.md) follows the review skill with either a `correctness/completeness` or `simplicity` focus. Its prompt restricts Bash to read-only inspection, but that restriction is behavioral rather than an OS sandbox.
- `/review-plan` dispatches independent plan reviews to Sol and Kimi K3.
- `/review-code` dispatches Sol for correctness/completeness and Kimi K3 for simplicity.

Both prompt templates leave synthesis and changes in the original session. Re-run the template after addressing accepted feedback until no confirmed findings remain; each run authorizes exactly one more pass.
