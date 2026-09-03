import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { metalHeaderLines } from "../ui/header.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

test("metal header stays within the terminal width", () => {
  for (let width = 0; width <= 100; width++) {
    for (const line of metalHeaderLines(theme, width, "test")) {
      assert.ok(visibleWidth(line) <= width, `line exceeded ${width} columns: ${line}`);
    }
  }
});

test("metal header adapts its identity to available space", () => {
  assert.match(metalHeaderLines(theme, 80, "test").join("\n"), /PI vtest/);
  assert.match(metalHeaderLines(theme, 40, "test").join("\n"), /R A D B O T/);
  assert.match(metalHeaderLines(theme, 12, "test").join("\n"), /^RADBOT \/\/ PI/);
});

test("full metal header is left aligned and keeps the logo on one axis", () => {
  const lines = metalHeaderLines(theme, 120, "test");
  const framedLines = lines.filter(Boolean);
  assert.ok(framedLines.every((line) => /^[╓║╟╙]/u.test(line)));

  const logoLines = framedLines.slice(1, 7);
  assert.deepEqual(
    logoLines.map((line) => line.search(/[█╚]/u)),
    [6, 6, 6, 6, 6, 6],
  );
});
