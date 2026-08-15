# Subagent

This extension is vendored from Pi's official [subagent example](https://github.com/earendil-works/pi-mono/tree/main/packages/coding-agent/examples/extensions/subagent) at version 0.84.2.

It adds a `subagent` tool that can run user-defined agents in isolated Pi processes, either individually, in parallel, or as a chain. Each invocation may select a model; selection precedence is invocation, agent definition, then the dispatching session. Usage from child model calls is included in parent-session accounting, and any failed child marks the complete tool result as failed while preserving its diagnostics.

## Local review workflows

- [`plan-reviewer`](../../agents/plan-reviewer.md) verifies implementation plans against their requirements and repository using read-only file tools.
- [`code-reviewer`](../../agents/code-reviewer.md) follows the review skill with either a `correctness/completeness` or `simplicity` focus. Its prompt restricts Bash to read-only inspection, but that restriction is behavioral rather than an OS sandbox.
- `/review-plan-pass` dispatches independent plan reviews to Sol and Kimi K3.
- `/review-code-pass` dispatches Sol for correctness/completeness and Kimi K3 for simplicity.

Both prompt templates leave synthesis and changes in the original session. Re-run a pass after addressing accepted feedback until no confirmed findings remain.
