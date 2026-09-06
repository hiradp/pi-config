import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import type { LoadoutSection } from "./loadout-resources.ts";

export function loadoutLines(theme: Theme, width: number, sections: LoadoutSection[]): string[] {
  if (width <= 0 || sections.length === 0) return [];
  const center = (text: string) => {
    const fitted = truncateToWidth(text, width, "");
    return " ".repeat(Math.floor((width - visibleWidth(fitted)) / 2)) + fitted;
  };
  if (width < 20) return [center(theme.fg("dim", "/loadout")), ""];

  const counts = sections
    .filter((section) => section.name !== "Themes")
    .map((section) => {
      const name = section.name.toLowerCase();
      const label = section.count === 1 ? name.replace(/s$/u, "") : name;
      return `\x1b[38;2;148;56;201m${section.count}\x1b[39m${theme.fg("dim", ` ${label}`)}`;
    })
    .join(theme.fg("dim", " · "));
  const hint = theme.fg("dim", "/loadout");
  return [...(counts ? wrapTextWithAnsi(counts, width).map(center) : []), center(hint), ""];
}

export class LoadoutView implements Component {
  private offset = 0;
  private maxOffset = 0;
  private pageSize = 1;

  private sections: LoadoutSection[];
  private theme: Theme;
  private height: () => number;
  private close: () => void;

  constructor(sections: LoadoutSection[], theme: Theme, height: () => number, close: () => void) {
    this.sections = sections;
    this.theme = theme;
    this.height = height;
    this.close = close;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const lines = this.sections.flatMap((section) => [
      this.theme.fg("muted", section.name.toLowerCase()),
      ...wrapTextWithAnsi(this.theme.fg("dim", section.body), width),
      "",
    ]);
    this.pageSize = Math.max(1, this.height() - 2);
    this.maxOffset = Math.max(0, lines.length - this.pageSize);
    this.offset = Math.min(this.offset, this.maxOffset);
    const hint = this.maxOffset > 0 ? "↑↓ scroll · esc close" : "esc close";
    return [
      this.theme.fg("muted", "loadout"),
      ...lines.slice(this.offset, this.offset + this.pageSize),
      this.theme.fg("dim", hint),
    ].map((line) => truncateToWidth(line, width, ""));
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "ctrl+c")) {
      this.close();
    } else if (matchesKey(data, "up")) {
      this.offset = Math.max(0, this.offset - 1);
    } else if (matchesKey(data, "down")) {
      this.offset = Math.min(this.maxOffset, this.offset + 1);
    } else if (matchesKey(data, "pageUp")) {
      this.offset = Math.max(0, this.offset - this.pageSize);
    } else if (matchesKey(data, "pageDown")) {
      this.offset = Math.min(this.maxOffset, this.offset + this.pageSize);
    } else if (matchesKey(data, "home")) {
      this.offset = 0;
    } else if (matchesKey(data, "end")) {
      this.offset = this.maxOffset;
    }
  }

  invalidate(): void {}
}
