import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { uiPalette } from "../ui/palette.ts";
import { renderStatusFooter, type FooterSnapshot } from "../ui/status-footer.ts";

const palette = uiPalette({ name: "dark" } as Theme);
const snapshot: FooterSnapshot = {
  directory: "pi-config",
  branch: "main",
  git: {
    dir: "pi-config",
    ahead: 2,
    behind: 1,
    added: 12,
    deleted: 3,
    untracked: 4,
    untrackedTruncated: false,
  },
  pullRequest: { branch: "main", number: 42, status: "ready" },
  modelName: "Claude Sonnet 4.6",
  thinkingLevel: "high",
  contextPercent: 24,
  contextWindow: 200_000,
  quotaWindows: [
    { label: "5h", usedPercent: 25 },
    { label: "wk", usedPercent: 60 },
  ],
  costs: { total: 1.25, main: 1.25, subagents: 0, hasSubagents: false },
};

const plain = (lines: string[]) => lines.map(stripVTControlCharacters);

test("normal widths separate project/model from context/quota/cost in two inset rows", () => {
  const rendered = renderStatusFooter(80, snapshot, palette);
  const rows = plain(rendered);

  assert.equal(rows.length, 2);
  assert.match(rows[0], /^ pi-config @ main \+12 -3 \?4 #42 ↑2 ↓1\s+Claude Sonnet 4\.6 · high $/);
  assert.match(rows[1], /^ context 30% \/ 200k\s+5h 25% · wk 60% · \$1\.250 $/);
  assert.ok(rendered[0].includes(palette.fg("lavender", "main")));
  assert.ok(rendered[0].includes(palette.fg("lavender", "Claude Sonnet 4.6")));
  assert.ok(rendered[0].includes(palette.fg("added", "+12")));
  assert.ok(rendered[0].includes(palette.fg("deleted", "-3")));
});

test("narrow rows wrap logical groups instead of losing model, thinking, quotas or cost", () => {
  const rows = plain(
    renderStatusFooter(40, { ...snapshot, sessionName: "Optional session title" }, palette),
  );
  const text = rows.join("\n");

  assert.ok(rows.length > 2);
  assert.ok(rows.every((row) => visibleWidth(row) <= 40));
  for (const group of [
    "pi-config @ main",
    "+12 -3",
    "#42",
    "↑2 ↓1",
    "Claude Sonnet 4.6 · high",
    "ctx 30% / 200k",
    "5h 25%",
    "wk 60%",
    "$1.250",
  ]) {
    assert.ok(text.includes(group), `Missing logical group: ${group}`);
  }
  assert.doesNotMatch(text, /Optional session title/);
});

test("session names and delegated breakdown use spare room but never displace total cost", () => {
  const data = {
    ...snapshot,
    sessionName: "Explore footer layout",
    costs: { total: 3.75, main: 1.25, subagents: 2.5, hasSubagents: true },
  };

  const wide = plain(renderStatusFooter(140, data, palette));
  const narrow = plain(renderStatusFooter(40, data, palette)).join("\n");

  assert.equal(wide.length, 2);
  assert.match(wide[0], /Explore footer layout/);
  assert.match(wide[1], /\$3\.750 total · \$1\.250 main · \$2\.500 agents/);
  assert.match(narrow, /\$3\.750/);
  assert.doesNotMatch(narrow, /main ·|agents|Explore footer layout/);
});

test("context keeps the headroom scale while normal telemetry stays muted until its thresholds", () => {
  const cases = [
    { real: 39, displayed: "49%", contextRole: "muted", quota: 69, quotaRole: "muted" },
    { real: 40, displayed: "50%", contextRole: "warning", quota: 70, quotaRole: "warning" },
    { real: 63, displayed: "79%", contextRole: "warning", quota: 94, quotaRole: "warning" },
    { real: 64, displayed: "80%", contextRole: "error", quota: 95, quotaRole: "error" },
    { real: 80, displayed: "100%", contextRole: "error", quota: 100, quotaRole: "error" },
  ] as const;

  for (const item of cases) {
    const rows = renderStatusFooter(
      100,
      {
        ...snapshot,
        contextPercent: item.real,
        quotaWindows: [{ label: "5h", usedPercent: item.quota }],
      },
      palette,
    );

    assert.ok(
      rows[1].includes(
        palette.fg("muted", "context ") + palette.fg(item.contextRole, item.displayed),
      ),
      `Context at ${item.real}% real`,
    );
    assert.ok(
      rows[1].includes(palette.fg("muted", "5h ") + palette.fg(item.quotaRole, `${item.quota}%`)),
      `Quota at ${item.quota}%`,
    );
  }
});

test("long Unicode identities stay within terminal bounds, including zero and tiny widths", () => {
  const data = {
    ...snapshot,
    directory: "作業⎇responsive-footer/packages",
    branch: "feature/long-responsive-footer-branch",
    modelName: "Claude Sonnet 4.6 Extended Thinking",
    sessionName: "🔵 Explore footer layout",
  };

  for (const width of [0, 1, 2, 8, 20, 40, 59, 60, 80, 120]) {
    const rows = renderStatusFooter(width, data, palette);

    assert.ok(rows.length >= 2);
    assert.ok(
      rows.every((row) => visibleWidth(row) <= width),
      `Overflow at width ${width}`,
    );
    if (width >= 40) {
      const text = plain(rows).join("\n");
      assert.match(text, /Claude Sonnet 4\.6/);
      assert.match(text, /high/);
      assert.match(text, /\$1\.250/);
    }
  }
});
