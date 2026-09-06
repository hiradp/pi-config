import { VERSION, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { StartupLoadout } from "./loadout-resources.ts";
import { loadoutLines, LoadoutView } from "./loadout.ts";

const SLIME = "\x1b[38;2;182;255;0m";
const PURPLE = "\x1b[38;2;148;56;201m";
const RESET_FG = "\x1b[39m";
const cut = (text: string) => `${PURPLE}${text}${SLIME}`;

const LOGO = [
  "    ____  ___    ____  ____  ____  ______",
  String.raw`   / ${cut("_")}  \/   |  / __ \/ __ )/ ${cut("_")}  \/_  __/`,
  String.raw`  / /_/ / /| | / / / / __ // / / / / /`,
  String.raw` / _, _/ ___ |/ /_/ / /${cut("_")}  / /_/ / / /`,
  String.raw`/_/ |_/_/  |_/_____/_____/\____/ /_/`,
] as const;
const LOGO_WIDTH = Math.max(...LOGO.map((line) => visibleWidth(line)));

function center(text: string, width: number): string {
  const fitted = truncateToWidth(text, width, "");
  const left = Math.floor((width - visibleWidth(fitted)) / 2);
  return `${" ".repeat(left)}${fitted}`;
}

function lettering(theme: Theme, text: string): string {
  return theme.bold(`${SLIME}${text}${RESET_FG}`);
}

export function metalHeaderLines(theme: Theme, width: number, version = VERSION): string[] {
  const availableWidth = Math.max(0, Math.floor(width));
  if (availableWidth === 0) return [];
  if (availableWidth < 26) {
    return [center(lettering(theme, "RADBOT"), availableWidth)];
  }

  const subtitle = center(theme.fg("dim", `pi v${version}`), availableWidth);
  if (availableWidth < LOGO_WIDTH) {
    return ["", center(lettering(theme, "R A D B O T"), availableWidth), subtitle, ""];
  }

  // Center the artwork as one block, preserving the stencil's slant.
  const left = " ".repeat(Math.floor((availableWidth - LOGO_WIDTH) / 2));
  return ["", ...LOGO.map((line) => `${left}${lettering(theme, line)}`), "", subtitle, ""];
}

export default function (pi: ExtensionAPI) {
  let currentLoadout: StartupLoadout | undefined;

  pi.registerCommand("loadout", {
    description: "Show loaded context, skills, prompts, extensions, and themes",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return;
      const sections = currentLoadout?.capture() ?? [];
      if (sections.length === 0) {
        ctx.ui.notify(
          "No startup inventory available. Keep quietStartup disabled to populate /loadout.",
          "info",
        );
        return;
      }
      await ctx.ui.custom<void>(
        (tui, theme, _keys, done) => {
          const view = new LoadoutView(
            sections,
            theme,
            () => Math.max(3, Math.floor(tui.terminal.rows * 0.8)),
            () => done(),
          );
          return {
            render: (width) => view.render(width),
            invalidate: () => view.invalidate(),
            handleInput: (data) => {
              view.handleInput(data);
              tui.requestRender();
            },
          };
        },
        { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%" } },
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader((tui, theme) => {
      let currentTheme = theme;
      const header = {
        render: (width: number) => [
          ...metalHeaderLines(currentTheme, width),
          ...loadoutLines(currentTheme, width, loadout.capture()),
        ],
        invalidate() {
          currentTheme = ctx.ui.theme;
        },
        dispose() {
          loadout.dispose();
          if (currentLoadout === loadout) currentLoadout = undefined;
        },
      };
      const loadout = new StartupLoadout(tui, header);
      currentLoadout = loadout;
      return header;
    });
  });
}
