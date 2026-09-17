# Subagent

This customized extension is based on Pi's official [subagent example](https://github.com/earendil-works/pi-mono/tree/main/packages/coding-agent/examples/extensions/subagent) and is maintained against Pi version 0.85.1.

It adds a `subagent` tool that can run user-defined agents in isolated Pi processes, either individually, in parallel, or as a chain. Each invocation may select a model; selection precedence is invocation, agent definition, then the dispatching session. Usage from child model calls is included in parent-session accounting, and any failed child marks the complete tool result as failed while preserving its diagnostics.

A child counts as completed only when it exits 0 with a final `stop` response that has text and does not begin with `Unsupported task:`. Anything else, including unparseable output lines and the per-child wall-clock limit (45 minutes by default, `timeoutMs` to override), is reported as failed with a reason. On session shutdown every live child process group is terminated.

Dispatching `code-reviewer` or `plan-reviewer` requires the current user message to contain the authorization line that `/review-code` or `/review-plan` emits, and each such message covers one `subagent` call. The model cannot write a user message, so running the template is the gate.

Children never receive the `subagent` or `claude` tools, and they carry a `PI_SUBAGENT_DEPTH` environment marker that makes the tool refuse nested dispatch, so delegation is at most one level deep.

Project-local agents (`agentScope: "project"` or `"both"`) run only when Pi's project trust is active and the user confirms them in the UI; a headless session refuses them, and a project agent never replaces a user agent of the same name.

While children are active, the tool renders a dashboard with queued/running/completed/failed states, each child's responsibility, total elapsed time, turns, output tokens, cost, and model. Calls may provide a short `label`; otherwise the task text identifies the responsibility.

## Live visibility

No extra command is needed. The compact dashboard shows the current operation and its duration separately from total runtime: waiting for or receiving a model response, running tools, compacting, retrying, or finishing. It also shows time since the last child JSON event. Multiple simultaneous tools are tracked independently; one finishing does not make the others look idle.

Each child has its own collapsible card inside the tool output. In **fullscreen mode**, click a card's header to expand or collapse only that child. The normal tool-detail keybinding (**Ctrl+O** by default) expands or collapses all cards, including in regular terminal mode where Pi does not receive mouse clicks.

Cards follow the global expansion setting initially. Individual choices survive streaming updates, terminal resizing, and completion; changing the global expansion setting resets those choices. Cards stay in dispatch order, even when several children use the same agent. Clicking inside an output body does not toggle the group, and scrolling/drag selection is left to Pi. Failures remain visible even in collapsed cards. Expansion choices are temporary UI state, not saved across reloads.

Expand a running child's card to see:

- The actual assigned task, including substituted input in a chain.
- The five most recently completed tools and up to five active tools, with durations and outcomes. Additional active tools are counted.
- Text output tails from those tools, where the tool supplies partial output.
- The latest assistant text, including text still streaming. Reasoning content is not displayed.

Each output/text preview keeps at most six lines and 4096 characters; long lines are clipped to terminal width. These are tails, not full logs. Tool output can contain sensitive information, just as it can in the main session. Terminal control sequences are removed before display. When a child finishes, its open card shows the full final answer as Markdown, tool calls, and usage instead of live previews. It does not automatically collapse, and other cards keep their state.

After 90 seconds of silence, the dashboard says **No events received for ...**, not that the child is stuck. A quiet command or provider can legitimately produce no events. The clock refreshes once a second, and event-driven updates are throttled to avoid repainting on every token. These timers stop when the child exits. Streaming previews do not contribute to token/cost accounting; finalized usage remains authoritative.

This changes visibility only: it adds no steering, per-child cancellation, automatic retries, or inactivity termination. The existing dispatch, review authorization, wall-clock timeout, and process-cleanup rules are unchanged.

## Local agents

- [`worker`](../../agents/worker.md) implements focused delegated tasks with the dispatching session's model and default tools, minus `subagent` and `claude`. It shares the selected working directory with the parent and sibling agents, so parallel workers should receive non-overlapping scopes.
- [`plan-reviewer`](../../agents/plan-reviewer.md) verifies implementation plans against their requirements and repository using read-only file tools.
- [`code-reviewer`](../../agents/code-reviewer.md) follows the review skill with either a `correctness/completeness` or `simplicity` focus. Its prompt restricts Bash to read-only inspection, but that restriction is behavioral rather than an OS sandbox.
- `/review-plan` dispatches independent plan reviews to Sol and Kimi K3.
- `/review-code` dispatches Sol for correctness/completeness and Kimi K3 for simplicity.

Both prompt templates leave synthesis and changes in the original session. Re-run the template after addressing accepted feedback until no confirmed findings remain; each run authorizes exactly one more pass.
