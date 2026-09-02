import type { Theme } from "@earendil-works/pi-coding-agent";

export const SHIMMER_INTERVAL_MS = 100;
const SHIMMER_WIDTH = 3;

export function shimmerText(text: string, theme: Theme, tick: number): string {
  const chars = [...text];
  const center = (tick % (chars.length + SHIMMER_WIDTH * 2)) - SHIMMER_WIDTH;

  return chars
    .map((char, index) => {
      const distance = Math.abs(index - center);
      if (distance < 0.75) return theme.fg("text", char);
      if (distance < 1.75) return theme.fg("accent", char);
      if (distance < 2.75) return theme.fg("muted", char);
      return theme.fg("dim", char);
    })
    .join("");
}
