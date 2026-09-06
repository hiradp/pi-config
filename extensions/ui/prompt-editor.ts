import {
  CustomEditor,
  type ExtensionAPI,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { uiPalette } from "./palette.ts";

export class RadEditor extends CustomEditor {
  private getTheme: () => Theme;

  constructor(tui: TUI, theme: EditorTheme, keys: KeybindingsManager, getTheme: () => Theme) {
    super(tui, theme, keys);
    this.getTheme = getTheme;
  }

  override render(width: number): string[] {
    if (width <= 0) return [];
    const palette = uiPalette(this.getTheme());
    // Pi's word wrapper needs room for a wide glyph; smaller layouts recurse.
    const minWidth = Math.max(3, this.getPaddingX() * 2 + 2);
    if (width < minWidth) return [palette.fg("muted", truncateToWidth("›", width, ""))];
    const gutter = width >= minWidth + 2 ? 2 : 0;
    const borderColor = this.borderColor;
    let lines: string[];
    try {
      // Pi updates borderColor with thinking/bash state. Keep the frame quiet;
      // the footer carries thinking level and the prompt marker carries bash mode.
      this.borderColor = (text) => palette.fg("border", text);
      lines = super.render(width - gutter);
    } finally {
      this.borderColor = borderColor;
    }

    let inEditor = true;
    const marker = palette.fg(this.getText().startsWith("!") ? "warning" : "prompt", "›");
    return lines.map((line, index) => {
      const border = line.startsWith(palette.ansi.border);
      if (border && index > 0) inEditor = false;
      if (border) return gutter ? ` ${line} ` : truncateToWidth(line, width, "");
      const prefix = gutter ? (index === 1 ? ` ${marker}` : "  ") : "";
      const content = inEditor ? palette.fg("text", line) : line;
      return truncateToWidth(prefix + content, width, "");
    });
  }
}

export default function promptEditor(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setEditorComponent(
      (tui, theme, keys) => new RadEditor(tui, theme, keys, () => ctx.ui.theme),
    );
  });
}
