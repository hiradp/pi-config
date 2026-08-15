/**
 * Working Message - shows a random phrase and elapsed time in Pi's working row.
 *
 * The phrase rotates every 20 seconds while a themed shimmer moves across it.
 * The working row shows elapsed time, received output tokens, and the duration
 * of the latest thinking block. Completed durations and the wall-clock time the
 * agent finished are stored in the session and rendered beneath each response.
 */

import { performance } from "node:perf_hooks";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const SHIMMER_INTERVAL_MS = 100;
const SHIMMER_WIDTH = 3;
const WORKING_PHRASE_INTERVAL_MS = 20_000;
const WORKING_MESSAGE_ENTRY = "working-message";

interface WorkingMessageEntryData {
  durationMs: number;
  completedAtMs?: number;
}

const WORKING_PHRASES = [
  "Appeasing the linter",
  "Arguing with the query planner",
  "Asking Bugbot to elaborate",
  "Asking the replicas who is primary",
  "Bribing the compiler",
  "Bribing the connection pool",
  "Chasing orphaned finalizers",
  "Consulting the forbidden docs",
  "Cooking forbidden spaghetti",
  "Deslopping the diff",
  "Disturbing the void",
  "Doing suspiciously legal things",
  "Electing a less cursed leader",
  "Exorcising idle transactions",
  "Following the feature flag maze",
  "Gaslighting the type checker",
  "Growing another worktree",
  "Herding cursed semicolons",
  "Making eventual consistency hurry up",
  "Making it weird",
  "Negotiating a peaceful switchover",
  "Negotiating with entropy",
  "Negotiating with the WAL",
  "Overthinking professionally",
  "Poking the machine spirit",
  "Polishing the haunted cache",
  "Preventing a tiny split brain",
  "Probing for signs of life",
  "Questioning my life choices",
  "Reading the overnight runes",
  "Rearranging the bits",
  "Reconciling the unreconcilable",
  "Reticulating splines",
  "Reviewing the reviewer’s review",
  "Shaking the dependency tree",
  "Stealing fire from the cloud",
  "Summoning tiny demons",
  "Teaching the operator restraint",
  "Turning coffee into tokens",
  "Untangling eldritch noodles",
  "Vacuuming the haunted tuples",
  "Violating causality",
  "Waiting for the cluster to agree",
  "Waking the ancient APIs",
  "Whispering to the scheduler",
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

export function formatTimeOfDay(epochMs: number): string {
  const date = new Date(epochMs);
  const hours = date.getHours();
  const suffix = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 || 12;
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${hour12}:${minutes} ${suffix}`;
}

export function formatTokenCount(tokens: number): string {
  const count = Math.max(0, tokens);
  if (count < 1_000) return Math.round(count).toString();
  if (count < 1_000_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function formatWorkingStats(
  durationMs: number,
  outputTokens: number,
  thoughtDurationMs: number | null,
): string {
  const stats = [formatDuration(durationMs)];
  if (outputTokens > 0) stats.push(`↓ ${formatTokenCount(outputTokens)} tokens`);
  if (thoughtDurationMs !== null && thoughtDurationMs >= 1_000) {
    stats.push(`thought for ${formatDuration(thoughtDurationMs)}`);
  }
  return `(${stats.join(" · ")})`;
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
  let completedOutputTokens = 0;
  let streamingOutputTokens = 0;
  let thoughtStartedAt: number | null = null;
  let lastThoughtDurationMs: number | null = null;
  let workingTimer: ReturnType<typeof setInterval> | undefined;

  pi.registerEntryRenderer<WorkingMessageEntryData>(
    WORKING_MESSAGE_ENTRY,
    (entry, _options, theme) => {
      if (!entry.data) return;

      const elapsed = formatDuration(entry.data.durationMs);
      const doneAt =
        entry.data.completedAtMs !== undefined
          ? ` at ${formatTimeOfDay(entry.data.completedAtMs)}`
          : "";
      const check = theme.fg("success", "✓");
      const message = theme.fg("dim", `Done in ${elapsed}${doneAt}`);
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
    completedOutputTokens = 0;
    streamingOutputTokens = 0;
    thoughtStartedAt = null;
    lastThoughtDurationMs = null;
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

      const message = shimmer(`${workingPhrase}…`, ctx.ui.theme, shimmerTick++);
      const stats = formatWorkingStats(
        now - requestStartedAt,
        completedOutputTokens + streamingOutputTokens,
        lastThoughtDurationMs,
      );
      ctx.ui.setWorkingMessage(`${message} ${ctx.ui.theme.fg("dim", stats)}`);
    };

    updateWorkingMessage();
    if (workingTimer === undefined) {
      workingTimer = setInterval(updateWorkingMessage, SHIMMER_INTERVAL_MS);
    }
  });

  pi.on("message_start", (event) => {
    if (requestStartedAt === null || event.message.role !== "assistant") return;
    streamingOutputTokens = event.message.usage.output;
  });

  pi.on("message_update", (event) => {
    if (requestStartedAt === null || event.message.role !== "assistant") return;

    streamingOutputTokens = event.message.usage.output;
    if (event.assistantMessageEvent.type === "thinking_start" && thoughtStartedAt === null) {
      thoughtStartedAt = performance.now();
      lastThoughtDurationMs = null;
    } else if (event.assistantMessageEvent.type === "thinking_end" && thoughtStartedAt !== null) {
      lastThoughtDurationMs = performance.now() - thoughtStartedAt;
      thoughtStartedAt = null;
    }
  });

  pi.on("message_end", (event) => {
    if (requestStartedAt === null || event.message.role !== "assistant") return;

    streamingOutputTokens = event.message.usage.output;
    completedOutputTokens += streamingOutputTokens;
    streamingOutputTokens = 0;

    if (thoughtStartedAt !== null) {
      lastThoughtDurationMs = performance.now() - thoughtStartedAt;
      thoughtStartedAt = null;
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    const durationMs = requestStartedAt !== null ? performance.now() - requestStartedAt : null;

    stopWorkingTimer();
    if (ctx.mode !== "tui") return;

    ctx.ui.setWorkingMessage();
    if (durationMs !== null) {
      pi.appendEntry<WorkingMessageEntryData>(WORKING_MESSAGE_ENTRY, {
        durationMs,
        completedAtMs: Date.now(),
      });
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopWorkingTimer();
    if (ctx.mode === "tui") ctx.ui.setWorkingMessage();
  });
}
