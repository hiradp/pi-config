import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { metalHeaderLines } from "../ui/header.ts";

function headerTheme(name = "dark"): Theme {
  return {
    name,
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
}

const theme = headerTheme();

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

test("metal header uses olive in light themes without changing the dark neon or artwork", () => {
  const neon = "\x1b[38;2;182;255;0m";
  const olive = "\x1b[38;2;83;105;0m";
  const purple = "\x1b[38;2;148;56;201m";

  for (const width of [12, 80]) {
    const dark = metalHeaderLines(theme, width, "test").join("\n");
    assert.ok(dark.includes(neon));
    for (const name of ["light", "rustic-light"]) {
      const light = metalHeaderLines(headerTheme(name), width, "test").join("\n");
      assert.ok(light.includes(olive));
      assert.ok(!light.includes(neon));
      assert.equal(stripVTControlCharacters(light), stripVTControlCharacters(dark));
      if (width === 80) assert.ok(light.includes(`${purple}_${olive}`));
    }
  }
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
