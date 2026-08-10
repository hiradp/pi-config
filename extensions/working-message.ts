/**
 * Working Message - shows a random phrase and elapsed time in Pi's working row.
 *
 * The phrase rotates every 20 seconds while a themed shimmer moves across it.
 * Elapsed time runs from before_agent_start until agent_settled. Completed
 * durations are stored in the session and rendered beneath each response.
 */

import { performance } from "node:perf_hooks";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const SHIMMER_INTERVAL_MS = 100;
const SHIMMER_WIDTH = 3;
const WORKING_PHRASE_INTERVAL_MS = 20_000;
const WORKING_MESSAGE_ENTRY = "working-message";

interface WorkingMessageEntryData {
  phrase: string;
  durationMs: number;
}

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

function randomWorkingPhrase(previousPhrase?: string): string {
  const index = Math.floor(Math.random() * WORKING_PHRASES.length);
  const phrase = WORKING_PHRASES[index] ?? "Working";
  if (phrase !== previousPhrase) return phrase;

  return WORKING_PHRASES[(index + 1) % WORKING_PHRASES.length] ?? "Working";
}

export function formatDuration(milliseconds: number): string {
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
  let nextPhraseChangeAt: number | null = null;
  let workingPhrase: string | null = null;
  let shimmerTick = 0;
  let workingTimer: ReturnType<typeof setInterval> | undefined;

  pi.registerEntryRenderer<WorkingMessageEntryData>(
    WORKING_MESSAGE_ENTRY,
    (entry, _options, theme) => {
      if (!entry.data) return;

      const elapsed = formatDuration(entry.data.durationMs);
      const check = theme.fg("success", "✓");
      const message = theme.fg("dim", `${entry.data.phrase}... ${elapsed}`);
      return new Text(`${check} ${message}`, 0, 0);
    },
  );

  const stopWorkingTimer = () => {
    if (workingTimer !== undefined) clearInterval(workingTimer);
    workingTimer = undefined;
    requestStartedAt = null;
    nextPhraseChangeAt = null;
    workingPhrase = null;
    shimmerTick = 0;
  };

  pi.on("before_agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (requestStartedAt === null) {
      requestStartedAt = performance.now();
      nextPhraseChangeAt = requestStartedAt + WORKING_PHRASE_INTERVAL_MS;
      workingPhrase = randomWorkingPhrase();
      shimmerTick = 0;
    }

    const updateWorkingMessage = () => {
      if (requestStartedAt === null || workingPhrase === null) return;

      const now = performance.now();
      if (nextPhraseChangeAt !== null && now >= nextPhraseChangeAt) {
        workingPhrase = randomWorkingPhrase(workingPhrase);
        nextPhraseChangeAt = now + WORKING_PHRASE_INTERVAL_MS;
        shimmerTick = 0;
      }

      const message = shimmer(`${workingPhrase}...`, ctx.ui.theme, shimmerTick++);
      const elapsed = ctx.ui.theme.fg("dim", ` ${formatDuration(now - requestStartedAt)}`);
      ctx.ui.setWorkingMessage(message + elapsed);
    };

    updateWorkingMessage();
    if (workingTimer === undefined) {
      workingTimer = setInterval(updateWorkingMessage, SHIMMER_INTERVAL_MS);
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    const completed =
      requestStartedAt !== null && workingPhrase !== null
        ? { phrase: workingPhrase, durationMs: performance.now() - requestStartedAt }
        : null;

    stopWorkingTimer();
    if (ctx.mode !== "tui") return;

    ctx.ui.setWorkingMessage();
    if (completed) pi.appendEntry<WorkingMessageEntryData>(WORKING_MESSAGE_ENTRY, completed);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopWorkingTimer();
    if (ctx.mode === "tui") ctx.ui.setWorkingMessage();
  });
}
