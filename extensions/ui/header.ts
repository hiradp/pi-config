import {
  VERSION,
  type ExtensionAPI,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const LOGO = [
  "██████╗  █████╗ ██████╗ ██████╗  ██████╗ ████████╗",
  "██╔══██╗██╔══██╗██╔══██╗██╔══██╗██╔═══██╗╚══██╔══╝",
  "██████╔╝███████║██║  ██║██████╔╝██║   ██║   ██║",
  "██╔══██╗██╔══██║██║  ██║██╔══██╗██║   ██║   ██║",
  "██║  ██║██║  ██║██████╔╝██████╔╝╚██████╔╝   ██║",
  "╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ╚═════╝  ╚═════╝    ╚═╝",
] as const;

const LOGO_COLORS: ThemeColor[] = ["dim", "muted", "text", "accent", "muted", "dim"];
const LOGO_WIDTH = Math.max(...LOGO.map((line) => visibleWidth(line)));
const FULL_CONTENT_WIDTH = 58;
const FULL_FRAME_WIDTH = FULL_CONTENT_WIDTH + 4;

function center(text: string, width: number): string {
  const padding = Math.max(0, width - visibleWidth(text));
  const left = Math.floor(padding / 2);
  return `${" ".repeat(left)}${text}${" ".repeat(padding - left)}`;
}

function fit(lines: string[], width: number): string[] {
  return lines.map((line) => truncateToWidth(line, width, ""));
}

function fullHeader(theme: Theme, width: number, version: string): string[] {
  const edge = (text: string) => theme.fg("dim", text);
  const frame = (body: string) => `${edge("║")} ${body} ${edge("║")}`;
  const lines = [edge(`╓${"─".repeat(FULL_CONTENT_WIDTH + 2)}╖`)];

  for (const [index, logoLine] of LOGO.entries()) {
    const color = LOGO_COLORS[index] ?? "text";
    const normalizedLine = `${logoLine}${" ".repeat(LOGO_WIDTH - visibleWidth(logoLine))}`;
    const body = center(normalizedLine, FULL_CONTENT_WIDTH);
    lines.push(frame(theme.fg(color, index === 3 ? theme.bold(body) : body)));
  }

  lines.push(edge(`╟${"─".repeat(FULL_CONTENT_WIDTH + 2)}╢`));
  lines.push(frame(theme.fg("muted", center(`PI v${version}`, FULL_CONTENT_WIDTH))));
  lines.push(edge(`╙${"─".repeat(FULL_CONTENT_WIDTH + 2)}╜`));

  return ["", ...fit(lines, width), ""];
}

function compactHeader(theme: Theme, width: number, version: string): string[] {
  const frameWidth = Math.min(44, width);
  const contentWidth = frameWidth - 4;
  const edge = (text: string) => theme.fg("dim", text);
  const row = (text: string, color: ThemeColor, bold = false) => {
    const body = center(text, contentWidth);
    const styled = theme.fg(color, bold ? theme.bold(body) : body);
    return `${edge("║")} ${styled} ${edge("║")}`;
  };
  const lines = [
    edge(`╓${"─".repeat(contentWidth + 2)}╖`),
    row("◆ R A D B O T ◆", "accent", true),
    edge(`╟${"─".repeat(contentWidth + 2)}╢`),
    row(`PI v${version}`, "muted"),
    edge(`╙${"─".repeat(contentWidth + 2)}╜`),
  ];
  return ["", ...fit(lines, width), ""];
}

export function metalHeaderLines(theme: Theme, width: number, version = VERSION): string[] {
  const availableWidth = Math.max(0, Math.floor(width));
  if (availableWidth === 0) return [];
  if (availableWidth < 26) {
    return [
      truncateToWidth(
        theme.fg("accent", theme.bold(`RADBOT // PI v${version}`)),
        availableWidth,
        "",
      ),
    ];
  }
  if (availableWidth < FULL_FRAME_WIDTH) return compactHeader(theme, availableWidth, version);
  return fullHeader(theme, availableWidth, version);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader((_tui, theme) => ({
      render: (width) => metalHeaderLines(theme, width),
      invalidate() {},
    }));
  });
}
