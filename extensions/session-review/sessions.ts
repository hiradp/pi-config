import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type SessionEntry,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type {
  ClassificationConfig,
  LoadedSession,
  PreparedSession,
  RepositoryInfo,
  SessionCategory,
} from "./types.ts";

const DEFAULT_CONFIG: ClassificationConfig = { work: [], personal: [] };
const MAX_EVIDENCE_CHARACTERS = 20_000;
const MAX_MESSAGE_CHARACTERS = 1_600;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseReviewDays(args: string): number {
  const value = args.trim().toLowerCase();
  if (!value) return 7;
  const match = value.match(/^(\d+)\s*(?:d|days?)?$/);
  if (!match) throw new Error("Usage: /session-review [1-90d]");
  const days = Number(match[1]);
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new Error("Review period must be between 1 and 90 days");
  }
  return days;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
  return value.map((item) => item.trim()).filter(Boolean);
}

export async function loadClassificationConfig(): Promise<ClassificationConfig> {
  try {
    const parsed = JSON.parse(
      await readFile(new URL("./config.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    const work = stringArray(parsed.work);
    const personal = stringArray(parsed.personal);
    if (!work || !personal) throw new Error("work and personal must be string arrays");
    return { work, personal };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_CONFIG;
    throw new Error(`Invalid session review config: ${errorMessage(error)}`);
  }
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  limit: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  results.length = values.length;
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await worker(values[index]!);
    }
  });
  await Promise.all(runners);
  return results;
}

export function isSessionEntry(value: unknown): value is SessionEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.type !== "string" ||
    typeof entry.id !== "string" ||
    (entry.parentId !== null && typeof entry.parentId !== "string") ||
    typeof entry.timestamp !== "string"
  ) {
    return false;
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return typeof entry.summary === "string";
  }
  if (entry.type !== "message") return true;
  if (typeof entry.message !== "object" || entry.message === null) return false;
  const message = entry.message as Record<string, unknown>;
  if (typeof message.role !== "string") return false;
  const validBlocks = (content: unknown): boolean =>
    Array.isArray(content) &&
    content.every((block) => {
      if (
        typeof block !== "object" ||
        block === null ||
        typeof (block as { type?: unknown }).type !== "string"
      ) {
        return false;
      }
      const typed = block as Record<string, unknown>;
      if (typed.type !== "toolCall") return true;
      return (
        typeof typed.id === "string" &&
        typeof typed.name === "string" &&
        typeof typed.arguments === "object" &&
        typed.arguments !== null
      );
    });
  if (message.role === "assistant") return validBlocks(message.content);
  if (message.role === "toolResult") {
    return typeof message.toolName === "string" && validBlocks(message.content);
  }
  return true;
}

export function parseSessionFile(content: string): SessionEntry[] | null {
  const lines = content.split("\n").filter((line) => line.trim());
  if (lines.length === 0) return null;
  let headerSeen = false;
  const entries: SessionEntry[] = [];
  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return null;
    }
    if (!headerSeen) {
      if (
        typeof value !== "object" ||
        value === null ||
        (value as { type?: unknown }).type !== "session" ||
        typeof (value as { id?: unknown }).id !== "string"
      ) {
        return null;
      }
      headerSeen = true;
      continue;
    }
    if (!isSessionEntry(value)) return null;
    entries.push(value);
  }
  return entries;
}

export async function loadSessionCorpus(signal?: AbortSignal): Promise<{
  sessions: LoadedSession[];
  skippedFiles: number;
}> {
  const infos = await SessionManager.listAll();
  signal?.throwIfAborted();
  let skippedFiles = 0;
  const loaded = await mapConcurrent(infos, 8, async (info): Promise<LoadedSession | null> => {
    signal?.throwIfAborted();
    try {
      const content = signal
        ? await readFile(info.path, { encoding: "utf8", signal })
        : await readFile(info.path, "utf8");
      const entries = parseSessionFile(content);
      if (!entries) {
        skippedFiles++;
        return null;
      }
      return { info, entries };
    } catch (error) {
      if (signal?.aborted) throw error;
      skippedFiles++;
      return null;
    }
  });
  return {
    sessions: loaded.filter((session): session is LoadedSession => session !== null),
    skippedFiles,
  };
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function usageCost(usage: Usage | undefined): number {
  if (!usage) return 0;
  const itemized =
    finiteNonNegative(usage.cost?.input) +
    finiteNonNegative(usage.cost?.output) +
    finiteNonNegative(usage.cost?.cacheRead) +
    finiteNonNegative(usage.cost?.cacheWrite);
  return finiteNonNegative(usage.cost?.total) || itemized;
}

function usageRecord(entry: SessionEntry): { cost: number; fingerprint: string } | null {
  let usage: Usage | undefined;
  let payload: unknown;

  if (entry.type === "message" && entry.message.role === "assistant") {
    usage = entry.message.usage;
    payload = ["assistant", entry.timestamp, entry.message];
  } else if (entry.type === "message" && entry.message.role === "toolResult") {
    usage = entry.message.usage;
    payload = ["tool", entry.timestamp, entry.message];
  } else if (entry.type === "compaction" || entry.type === "branch_summary") {
    usage = entry.usage;
    payload = [entry.type, entry.timestamp, entry.summary, entry.usage];
  } else {
    return null;
  }

  if (!usage) return null;
  return {
    cost: usageCost(usage),
    fingerprint: createHash("sha256").update(JSON.stringify(payload)).digest("base64url"),
  };
}

export function attributeSessionCosts(sessions: readonly LoadedSession[]): Map<string, number> {
  const costs = new Map<string, number>();
  const seen = new Set<string>();
  const ordered = [...sessions].sort(
    (a, b) =>
      a.info.created.getTime() - b.info.created.getTime() || a.info.path.localeCompare(b.info.path),
  );

  for (const session of ordered) {
    let cost = 0;
    for (const entry of session.entries) {
      const record = usageRecord(entry);
      if (!record || seen.has(record.fingerprint)) continue;
      seen.add(record.fingerprint);
      cost += record.cost;
    }
    costs.set(session.info.path, cost);
  }
  return costs;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

export function redactSessionText(value: string): string {
  const redacted = value
    .replace(/^(\s*(?:set-cookie|cookie)\s*:\s*).+$/gim, "$1<redacted>")
    .replace(
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,
      "<redacted-private-key>",
    )
    .replace(
      /(\b(?:authorization|proxy-authorization)\b\s*[:=]\s*)(?:[A-Za-z][A-Za-z0-9_-]*\s+)?[^\s,;}]+/gi,
      "$1<redacted>",
    )
    .replace(
      /((?:["'])?[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|AUTH)[A-Za-z0-9_]*(?:["'])?\s*[:=]\s*)(["'])[^"'\r\n]*\2/gi,
      "$1$2<redacted>$2",
    )
    .replace(
      /((?:["'])?[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|AUTH)[A-Za-z0-9_]*(?:["'])?\s*[:=]\s*)([^\s;&|]+)/gi,
      "$1<redacted>",
    )
    .replace(
      /(\s--?(?:token|secret|password|passwd|api-key|private-key|authorization)(?:=|\s+))([^\s;&|]+)/gi,
      "$1<redacted>",
    )
    .replace(
      /(["']?(?:authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd)["']?\s*[:=]\s*)(["'])[^"'\r\n]*\2/gi,
      "$1$2<redacted>$2",
    )
    .replace(
      /(\b(?:authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd)\b\s*[:=]\s*)(?:Bearer\s+)?[^\s,;}]+/gi,
      "$1<redacted>",
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[opusr]_[A-Za-z0-9_-]{12,}|glpat-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
      "<redacted-token>",
    )
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "<redacted-access-key>")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<redacted-jwt>")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1<redacted>@");
  const home = process.env.HOME;
  return home ? redacted.replaceAll(home, "~") : redacted;
}

function clip(value: string, maxCharacters = MAX_MESSAGE_CHARACTERS): string {
  const normalized = redactSessionText(value).replace(/\s+\n/g, "\n").trim();
  if (normalized.length <= maxCharacters) return normalized;
  return `${normalized.slice(0, maxCharacters - 1)}…`;
}

function compactEvidence(value: string): string {
  if (value.length <= MAX_EVIDENCE_CHARACTERS) return value;
  const headLength = 6_000;
  const tailLength = MAX_EVIDENCE_CHARACTERS - headLength - 42;
  return `${value.slice(0, headLength)}\n\n[older evidence omitted]\n\n${value.slice(-tailLength)}`;
}

function toolPathCandidates(entries: readonly SessionEntry[], cwd: string): string[] {
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    for (const block of entry.message.content) {
      if (block.type !== "toolCall" || typeof block.arguments !== "object" || !block.arguments)
        continue;
      const args = block.arguments as Record<string, unknown>;
      for (const key of ["path", "cwd"]) {
        const raw = args[key];
        if (typeof raw !== "string" || !raw.trim() || raw.includes("\0") || raw.includes("://")) {
          continue;
        }
        let candidate = raw.trim().replace(/^@/, "");
        if (candidate.startsWith("~/"))
          candidate = join(process.env.HOME ?? cwd, candidate.slice(2));
        paths.push(isAbsolute(candidate) ? normalize(candidate) : resolve(cwd, candidate));
      }
    }
  }
  return paths;
}

async function gitRoot(candidate: string): Promise<string | null> {
  let current = resolve(candidate);
  while (true) {
    try {
      await access(join(current, ".git"));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

export async function discoverRepositories(
  info: SessionInfo,
  entries: readonly SessionEntry[],
  signal?: AbortSignal,
): Promise<RepositoryInfo[]> {
  const cwd = info.cwd || dirname(info.path);
  const candidates = [cwd, ...toolPathCandidates(entries, cwd)];
  const roots = new Set<string>();
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    const root = await gitRoot(candidate);
    if (root) roots.add(root);
  }

  if (roots.size === 0) roots.add(resolve(cwd));
  return [...roots].map((path) => ({ name: basename(path) || path, path }));
}

function overrideMatches(repository: RepositoryInfo, pattern: string): boolean {
  const value = pattern.trim();
  if (!value) return false;
  if (!value.includes("/") && !value.includes("\\")) {
    return repository.name.toLowerCase() === value.toLowerCase();
  }
  const target = normalize(repository.path);
  const prefix = normalize(value);
  return target === prefix || target.startsWith(prefix.endsWith(sep) ? prefix : `${prefix}${sep}`);
}

export function repositoryCategoryOverride(
  repositories: readonly RepositoryInfo[],
  config: ClassificationConfig,
): Exclude<SessionCategory, "unclear"> | undefined {
  const work = repositories.some((repo) =>
    config.work.some((pattern) => overrideMatches(repo, pattern)),
  );
  const personal = repositories.some((repo) =>
    config.personal.some((pattern) => overrideMatches(repo, pattern)),
  );
  if (work === personal) return undefined;
  return work ? "work" : "personal";
}

function safeToolPath(value: string, cwd: string, repositories: readonly RepositoryInfo[]): string {
  let candidate = value.trim().replace(/^@/, "");
  if (candidate.startsWith("~/")) candidate = join(process.env.HOME ?? cwd, candidate.slice(2));
  const absolute = isAbsolute(candidate) ? normalize(candidate) : resolve(cwd, candidate);
  const ordered = [...repositories].sort((a, b) => b.path.length - a.path.length);
  for (const repository of ordered) {
    const root = normalize(repository.path);
    if (absolute === root) return `<repo:${repository.name}>`;
    if (absolute.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) {
      return `<repo:${repository.name}>/${relative(root, absolute)}`;
    }
  }
  return `<external>/${basename(absolute) || "path"}`;
}

export function safeToolArguments(
  value: unknown,
  cwd: string,
  repositories: readonly RepositoryInfo[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if ((key === "path" || key === "cwd") && typeof item === "string") {
        return [key, safeToolPath(item, cwd, repositories)];
      }
      if (key === "paths" && Array.isArray(item)) {
        return [
          key,
          item.map((path) =>
            typeof path === "string" ? safeToolPath(path, cwd, repositories) : path,
          ),
        ];
      }
      return [key, item];
    }),
  );
}

function evidenceForSession(
  session: LoadedSession,
  repositories: readonly RepositoryInfo[],
  categoryOverride: PreparedSession["categoryOverride"],
): string {
  const lines = [
    `Session name: ${clip(session.info.name ?? "(unnamed)", 300)}`,
    `Repositories: ${repositories.map((repo) => repo.name).join(", ")}`,
    `Category override: ${categoryOverride ?? "none"}`,
  ];

  for (const entry of session.entries) {
    if (entry.type === "compaction") {
      lines.push(`COMPACTION SUMMARY: ${clip(entry.summary, 2_500)}`);
      continue;
    }
    if (entry.type === "branch_summary") {
      lines.push(`BRANCH SUMMARY: ${clip(entry.summary, 2_000)}`);
      continue;
    }
    if (entry.type !== "message") continue;

    if (entry.message.role === "user") {
      const text = clip(contentText(entry.message.content));
      if (text) lines.push(`USER: ${text}`);
      continue;
    }

    if (entry.message.role === "assistant") {
      const text = clip(contentText(entry.message.content));
      if (text) lines.push(`ASSISTANT: ${text}`);
      for (const block of entry.message.content) {
        if (block.type !== "toolCall") continue;
        const args = safeToolArguments(
          block.arguments,
          session.info.cwd || dirname(session.info.path),
          repositories,
        );
        lines.push(`TOOL CALL ${block.name}: ${clip(JSON.stringify(args), 1_200)}`);
      }
      continue;
    }

    if (entry.message.role === "toolResult") {
      if (entry.message.toolName !== "bash" && !entry.message.isError && !entry.message.usage)
        continue;
      const text = clip(contentText(entry.message.content), 1_200);
      if (text) {
        lines.push(
          `TOOL RESULT ${entry.message.toolName}${entry.message.isError ? " (error)" : ""}: ${text}`,
        );
      }
    }
  }

  return compactEvidence(lines.join("\n\n"));
}

export async function prepareRecentSessions(
  corpus: readonly LoadedSession[],
  days: number,
  now: Date,
  config: ClassificationConfig,
  signal?: AbortSignal,
): Promise<{ sessions: PreparedSession[]; cutoff: number }> {
  const generatedAt = now.getTime();
  const cutoff = generatedAt - days * 24 * 60 * 60 * 1_000;
  const costs = attributeSessionCosts(corpus);
  const recent = corpus
    .filter((session) => {
      const modified = session.info.modified.getTime();
      return modified >= cutoff && modified <= generatedAt;
    })
    .sort((a, b) => b.info.modified.getTime() - a.info.modified.getTime());

  const sessions = await mapConcurrent(recent, 4, async (session): Promise<PreparedSession> => {
    signal?.throwIfAborted();
    const repositories = await discoverRepositories(session.info, session.entries, signal);
    const categoryOverride = repositoryCategoryOverride(repositories, config);
    return {
      id: session.info.id,
      path: session.info.path,
      ...(session.info.name ? { name: session.info.name } : {}),
      firstMessage: clip(session.info.firstMessage, 1_000),
      created: session.info.created.getTime(),
      modified: session.info.modified.getTime(),
      repositories,
      evidence: evidenceForSession(session, repositories, categoryOverride),
      cost: costs.get(session.info.path) ?? 0,
      ...(categoryOverride ? { categoryOverride } : {}),
    };
  });

  return { sessions, cutoff };
}
