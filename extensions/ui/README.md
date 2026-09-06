# UI

The Pi header centers a slime-green stencil logo above a compact loadout summary. `/loadout` opens the full resource names in a scrollable overlay; Escape closes it. Loading errors and conflicts remain in the startup transcript.

The prompt uses a thin purple frame, a slime-green `›`, and readable text. Bash input changes the marker to amber; thinking level is shown in the footer rather than coloring the whole frame. Pi still handles editing, autocomplete, paste, and app shortcuts.

The footer groups project/git and model/thinking on its first row, with context usage and quota/cost on its second. Narrow terminals compact optional details and wrap groups rather than dropping the right side. Session names and delegated cost breakdowns appear when space permits. Context retains the existing headroom scale: 80% actual usage displays as 100%.

`palette.ts` defines the working-area colors separately from the rest of the theme, with dark and light variants (including `rustic-light`). Theme switching updates the prompt and footer without a reload.

Keep `quietStartup: false`: the summary reuses Pi's actual loaded-resource display, including CLI and package resources, rather than scanning configuration files or executing a second resource loader. It changes presentation only, not what Pi loads.

`loadout-resources.ts` is a compatibility adapter for Pi 0.84's startup component tree and `ExpandableText` getters. Only recognized inventory sections and their spacers are hidden. Unknown formats and diagnostics remain visible. The adapter restores the original components when the header is disposed, and the tests exercise the installed Pi inventory renderer to catch incompatible upgrades.
