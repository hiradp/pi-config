# Subagent

This extension is vendored from Pi's official [subagent example](https://github.com/earendil-works/pi-mono/tree/main/packages/coding-agent/examples/extensions/subagent) at version 0.84.2.

It adds a `subagent` tool that can run user-defined agents in isolated Pi processes, either individually, in parallel, or as a chain. Each invocation may select a model; selection precedence is invocation, agent definition, then the dispatching session. Usage from child model calls is included in parent-session accounting, and any failed child marks the complete tool result as failed while preserving its diagnostics.

While children are active, the tool renders a stable dashboard with queued/running/completed/failed states, each child's latest action, elapsed time, turns, output tokens, cost, and model. Completed output stays collapsed until the tool-detail keybinding is used.

## Local agents

- [`worker`](../../agents/worker.md) implements focused delegated tasks with the dispatching session's model and default tools. It shares the selected working directory with the parent and sibling agents, so parallel workers should receive non-overlapping scopes.
- [`plan-reviewer`](../../agents/plan-reviewer.md) verifies implementation plans against their requirements and repository using read-only file tools.
- [`code-reviewer`](../../agents/code-reviewer.md) follows the review skill with either a `correctness/completeness` or `simplicity` focus. Its prompt restricts Bash to read-only inspection, but that restriction is behavioral rather than an OS sandbox.
- `/review-plan` dispatches independent plan reviews to Sol and Kimi K3.
- `/review-code` dispatches Sol for correctness/completeness and Kimi K3 for simplicity.

Both prompt templates leave synthesis and changes in the original session. Re-run a pass after addressing accepted feedback until no confirmed findings remain.
