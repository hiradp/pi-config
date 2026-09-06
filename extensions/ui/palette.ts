import type { Theme } from "@earendil-works/pi-coding-agent";

const DARK = {
  border: "59346B",
  prompt: "B6FF00",
  text: "DDD6DE",
  lavender: "A58BB5",
  muted: "817487",
  added: "8FAE72",
  deleted: "B7798B",
  warning: "D6AB61",
  error: "DB777F",
  thinkingLow: "817487",
  thinkingMedium: "967AA8",
  thinkingHigh: "B08BCC",
  thinkingMax: "CD9AEF",
};
const LIGHT: typeof DARK = {
  border: "AA8FB5",
  prompt: "536900",
  text: "463C49",
  lavender: "715681",
  muted: "756678",
  added: "536C35",
  deleted: "974D65",
  warning: "8D600F",
  error: "A63546",
  thinkingLow: "756678",
  thinkingMedium: "806091",
  thinkingHigh: "794692",
  thinkingMax: "6B248C",
};
export type UiColor = keyof typeof DARK;

export function uiPalette(theme: Theme) {
  const colors = /light/i.test(theme.name ?? "") ? LIGHT : DARK;
  const ansi = Object.fromEntries(
    Object.entries(colors).map(([key, hex]) => {
      const rgb = hex.match(/../g)!.map((part) => parseInt(part, 16));
      return [key, `\x1b[38;2;${rgb.join(";")}m`];
    }),
  ) as Record<UiColor, string>;
  return {
    ansi,
    fg: (color: UiColor, text: string) => {
      const start = ansi[color];
      return `${start}${text.replaceAll("\x1b[0m", `\x1b[0m${start}`).replaceAll("\x1b[39m", start)}\x1b[39m`;
    },
    thinking: (level: string) => {
      const color =
        level === "max" || level === "xhigh"
          ? "thinkingMax"
          : level === "high"
            ? "thinkingHigh"
            : level === "medium"
              ? "thinkingMedium"
              : "thinkingLow";
      return `${ansi[color]}${level}\x1b[39m`;
    },
  };
}
export type UiPalette = ReturnType<typeof uiPalette>;
