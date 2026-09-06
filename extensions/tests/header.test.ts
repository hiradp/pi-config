import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { metalHeaderLines } from "../ui/header.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

test("metal header stays within the terminal width", () => {
  for (const version of ["test", "long-version".repeat(10)]) {
    for (let width = 0; width <= 120; width++) {
      for (const line of metalHeaderLines(theme, width, version)) {
        assert.ok(visibleWidth(line) <= width, `line exceeded ${width} columns: ${line}`);
      }
    }
  }
});

test("metal header adapts its identity to available space", () => {
  assert.match(metalHeaderLines(theme, 80, "test").join("\n"), /pi vtest/);
  assert.deepEqual(metalHeaderLines(theme, 12, "test").map(stripVTControlCharacters), ["     Pi"]);
});

test("full metal header centers the unboxed artwork without straightening its slant", () => {
  for (const width of [14, 15, 40, 80, 81, 120]) {
    const lines = metalHeaderLines(theme, width, "test").map(stripVTControlCharacters);
    const logo = lines.slice(1, 6);
    const left = Math.min(...logo.map((line) => line.search(/\S/u)));
    const right = width - Math.max(...logo.map((line) => visibleWidth(line)));

    assert.ok(Math.abs(left - right) <= 1, `artwork is not centered at width ${width}`);
    assert.deepEqual(
      logo.map((line) => line.search(/\S/u) - left),
      [4, 3, 2, 1, 0],
    );
    assert.doesNotMatch(lines.join("\n"), /[╓║╟╙─◆]/u);
    assert.equal(lines[7], `${" ".repeat(Math.floor((width - 8) / 2))}pi vtest`);
  }
});
