/**
 * Working Message - shows a random phrase and elapsed time in Pi's working row.
 *
 * One phrase is selected per request and remains stable while a themed shimmer
 * moves across it. Elapsed time runs from before_agent_start until agent_settled.
 */

import { performance } from "node:perf_hooks";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

const SHIMMER_INTERVAL_MS = 100;
const SHIMMER_WIDTH = 3;

const WORKING_PHRASES = [
  "Appeasing the linter",
  "Bribing the compiler",
  "Consulting the forbidden docs",
  "Cooking forbidden spaghetti",
  "Disturbing the void",
  "Doing suspiciously legal things",
  "Gaslighting the type checker",
  "Herding cursed semicolons",
  "Making it weird",
  "Negotiating with entropy",
  "Overthinking professionally",
  "Poking the machine spirit",
  "Polishing the haunted cache",
  "Questioning my life choices",
  "Rearranging the bits",
  "Reticulating splines",
  "Shaking the dependency tree",
  "Stealing fire from the cloud",
  "Summoning tiny demons",
  "Turning coffee into tokens",
  "Untangling eldritch noodles",
  "Violating causality",
  "Waking the ancient APIs",
] as const;

function randomWorkingPhrase(): string {
  return WORKING_PHRASES[Math.floor(Math.random() * WORKING_PHRASES.length)] ?? "Working";
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds.toString().padStart(2, "0")}s`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
}

function shimmer(text: string, theme: Theme, tick: number): string {
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

export default function (pi: ExtensionAPI) {
  let requestStartedAt: number | null = null;
  let workingPhrase: string | null = null;
  let shimmerTick = 0;
  let workingTimer: ReturnType<typeof setInterval> | undefined;

  const stopWorkingTimer = () => {
    if (workingTimer !== undefined) clearInterval(workingTimer);
    workingTimer = undefined;
    requestStartedAt = null;
    workingPhrase = null;
    shimmerTick = 0;
  };

  pi.on("before_agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (requestStartedAt === null) {
      requestStartedAt = performance.now();
      workingPhrase = randomWorkingPhrase();
      shimmerTick = 0;
    }

    const updateWorkingMessage = () => {
      if (requestStartedAt === null || workingPhrase === null) return;
      const message = shimmer(`${workingPhrase}...`, ctx.ui.theme, shimmerTick++);
      const elapsed = ctx.ui.theme.fg(
        "dim",
        ` ${formatDuration(performance.now() - requestStartedAt)}`,
      );
      ctx.ui.setWorkingMessage(message + elapsed);
    };

    updateWorkingMessage();
    if (workingTimer === undefined) {
      workingTimer = setInterval(updateWorkingMessage, SHIMMER_INTERVAL_MS);
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    stopWorkingTimer();
    if (ctx.mode === "tui") ctx.ui.setWorkingMessage();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopWorkingTimer();
    if (ctx.mode === "tui") ctx.ui.setWorkingMessage();
  });
}
