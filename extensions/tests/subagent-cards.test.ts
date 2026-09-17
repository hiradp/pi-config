import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ExtensionAPI,
  initTheme,
  ToolExecutionComponent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  type TUI,
  type TuiMouseEvent,
  visibleWidth,
} from "@earendil-works/pi-tui";
import registerSubagent from "../subagent/index.ts";

function child(label: string, extra = {}) {
  return {
    agent: "worker",
    agentSource: "user",
    label,
    task: `${label} assignment`,
    startedAt: 1000,
    exitCode: -1,
    messages: [] as ReturnType<typeof answer>,
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    ...extra,
  };
}

function toolRow(mode = "parallel") {
  initTheme("dark", false);
  let tool: ToolDefinition | undefined;
  registerSubagent({
    on() {},
    registerTool(definition: ToolDefinition) {
      tool = definition;
    },
  } as unknown as ExtensionAPI);
  assert.ok(tool);
  const row = new ToolExecutionComponent(
    "subagent",
    "cards",
    {},
    { showImages: false },
    tool,
    { requestRender() {} } as unknown as TUI,
    process.cwd(),
  );
  return {
    row,
    update(results: unknown[], isPartial = true) {
      row.updateResult({ content: [], details: { mode, results }, isError: false }, isPartial);
    },
  };
}

function lines(row: ToolExecutionComponent, width = 110) {
  return row.render(width).map(stripTerminalSequences);
}

function pointer(
  row: ToolExecutionComponent,
  text: string,
  width = 110,
  extra: Partial<TuiMouseEvent> = {},
) {
  const rendered = lines(row, width);
  const y = rendered.findIndex((line) => line.includes(text));
  assert.ok(y >= 0, `Missing pointer target: ${text}`);
  return row.handleMouse({
    type: "click",
    button: "left",
    x: 5,
    y,
    screenX: 5,
    screenY: y,
    width,
    height: rendered.length,
    shift: false,
    alt: false,
    ctrl: false,
    ...extra,
  });
}

function answer(text: string) {
  return [{ role: "assistant", content: [{ type: "text", text }] }];
}

test("same-agent cards stay independent through streaming, resizing and completion", () => {
  const { row, update } = toolRow();
  let children = [child("Alpha"), child("Beta")];
  update(children);
  assert.doesNotMatch(lines(row).join("\n"), /assignment/);

  pointer(row, "Alpha");
  assert.match(lines(row).join("\n"), /Alpha assignment/);
  assert.doesNotMatch(lines(row).join("\n"), /Beta assignment/);

  children = children.map((c) => ({
    ...c,
    task: `${c.label} assignment with enough words to wrap across several lines in a narrow terminal.`,
    messages: answer(`${c.label} live text`),
  }));
  update(children);
  row.invalidate();
  assert.match(lines(row).join("\n"), /Alpha live text/);
  assert.doesNotMatch(lines(row).join("\n"), /Beta live text/);

  // Header hit targets must follow the expanded, wrapped content above them.
  pointer(row, "Beta", 38);
  assert.match(lines(row).join("\n"), /Alpha live text/);
  assert.match(lines(row).join("\n"), /Beta live text/);
  pointer(row, "Alpha", 38);
  assert.doesNotMatch(lines(row).join("\n"), /Alpha live text/);
  assert.match(lines(row).join("\n"), /Beta live text/);

  children = children.map((c) => ({
    ...c,
    exitCode: 0,
    completedAt: 2000,
    stopReason: "stop",
    messages: answer(
      `${c.label} final beginning\n\n${"middle paragraph\n\n".repeat(10)}${c.label} final end`,
    ),
  }));
  update(children, false);
  const finished = lines(row).join("\n");
  assert.doesNotMatch(finished, /Alpha final/);
  assert.match(finished, /Beta final beginning/);
  assert.match(finished, /Beta final end/);
  assert.ok(finished.indexOf("Alpha") < finished.indexOf("Beta"));

  pointer(row, "Beta");
  assert.doesNotMatch(lines(row).join("\n"), /Beta final/);
  pointer(row, "Alpha");
  assert.match(lines(row).join("\n"), /Alpha final beginning/);
  for (const width of [6, 20, 38, 110]) {
    assert.ok(lines(row, width).every((line) => visibleWidth(line) <= width));
  }
});

test("bulk expansion resets individual choices but body clicks and scrolling do not", () => {
  const { row, update } = toolRow();
  const children = [child("Alpha"), child("Beta")];
  update(children);
  pointer(row, "Beta");

  row.setExpanded(true);
  assert.match(lines(row).join("\n"), /Alpha assignment/);
  assert.match(lines(row).join("\n"), /Beta assignment/);
  pointer(row, "Alpha");
  update(children);
  assert.doesNotMatch(lines(row).join("\n"), /Alpha assignment/);
  assert.match(lines(row).join("\n"), /Beta assignment/);

  pointer(row, "Beta assignment");
  for (const type of ["press", "drag", "release", "wheel"] as const) {
    assert.equal(pointer(row, "Beta", 110, { type }), undefined);
  }
  assert.doesNotMatch(lines(row).join("\n"), /Alpha assignment/);
  assert.match(lines(row).join("\n"), /Beta assignment/);

  row.setExpanded(false);
  assert.doesNotMatch(lines(row).join("\n"), /assignment/);
  pointer(row, "Alpha");
  assert.match(lines(row).join("\n"), /Alpha assignment/);
  assert.doesNotMatch(lines(row).join("\n"), /Beta assignment/);
});

test("queued chain cards retain their choice when starting, while collapsed failures stay visible", () => {
  const { row, update } = toolRow("chain");
  const first = child("Alpha", { step: 1 });
  const second = child("Beta", { step: 2, startedAt: undefined, task: "Use {previous}" });
  update([first, second]);
  pointer(row, "Beta");
  assert.match(lines(row).join("\n"), /\(queued\)/);

  const finished = { ...first, exitCode: 0, completedAt: 2000, messages: answer("First answer") };
  const started = { ...second, startedAt: 2000, assignedTask: "Use the resolved first answer" };
  update([finished, started]);
  const running = lines(row).join("\n");
  assert.match(running, /Use the resolved first answer/);
  assert.doesNotMatch(running, /First answer|\{previous\}/);

  pointer(row, "Beta");
  update(
    [finished, { ...started, exitCode: 1, completedAt: 3000, errorMessage: "Command timed out" }],
    false,
  );
  const failed = lines(row).join("\n");
  assert.match(failed, /Error: Command timed out/);
  assert.doesNotMatch(failed, /Use the resolved first answer/);
});
