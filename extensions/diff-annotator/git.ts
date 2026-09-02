import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readlink } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { ReviewChangeStatus, ReviewFile, ReviewFileKind, ReviewSnapshot } from "./types.ts";

const MAX_TOTAL_DIFF_BYTES = 1024 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 256 * 1024;
const MAX_PATCH_BYTES = 256 * 1024;
const GIT_TIMEOUT_MS = 15_000;

// Git's marker sits at column 0; content lines always carry a +, -, or space
// prefix, so text that merely mentions the phrase does not match.
const BINARY_PATCH_MARKER = /^Binary files .* differ$/m;

const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".avi",
  ".avif",
  ".bin",
  ".bmp",
  ".class",
  ".dll",
  ".dmg",
  ".dylib",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".lockb",
  ".map",
  ".mov",
  ".mp3",
  ".mp4",
  ".o",
  ".otf",
  ".pdf",
  ".png",
  ".pyc",
  ".so",
  ".sqlite",
  ".tar",
  ".ttf",
  ".wasm",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

export interface RunGitLike {
  exec(
    command: string,
    args: string[],
    options?: { cwd?: string; timeout?: number; signal?: AbortSignal },
  ): Promise<{ code: number; stdout: string; stderr: string; killed?: boolean }>;
}

export interface CaptureOptions {
  signal?: AbortSignal;
}

interface GitContext {
  runner: RunGitLike;
  signal?: AbortSignal;
}

// Pi's exec resolves a killed child with code 0 and whatever output had
// arrived, so timeouts and cancellation are only visible through `killed`.
async function runGit(
  git: GitContext,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await git.runner.exec("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    signal: git.signal,
  });
  if (result.killed) {
    throw new Error(
      git.signal?.aborted
        ? "Diff capture was cancelled"
        : `git ${args[0]} timed out after ${GIT_TIMEOUT_MS / 1000}s`,
    );
  }
  return result;
}

async function getRepoRoot(git: GitContext, cwd: string): Promise<string> {
  const result = await runGit(git, ["rev-parse", "--show-toplevel"], cwd);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Not inside a Git repository.");
  }
  return result.stdout.trim();
}

async function hasHead(git: GitContext, repoRoot: string): Promise<boolean> {
  const result = await runGit(git, ["rev-parse", "--verify", "HEAD"], repoRoot);
  return result.code === 0;
}

// The empty tree's id depends on the repository's object format, so ask Git
// for it rather than assuming the SHA-1 value.
async function emptyTreeRevision(git: GitContext, repoRoot: string): Promise<string> {
  const result = await runGit(git, ["hash-object", "-t", "tree", "/dev/null"], repoRoot);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "Failed to determine the empty tree id.");
  }
  return result.stdout.trim();
}

function splitNulSeparated(output: string): string[] {
  return output.split("\0").filter((entry) => entry.length > 0);
}

function statusFromCode(code: string): ReviewChangeStatus | null {
  switch (code[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "M":
    case "T":
      return "modified";
    default:
      return null;
  }
}

function pathExtension(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash ? path.slice(dot).toLowerCase() : "";
}

function isProbablyBinaryPath(path: string): boolean {
  return (
    BINARY_EXTENSIONS.has(pathExtension(path)) ||
    path.toLowerCase().endsWith(".min.js") ||
    path.toLowerCase().endsWith(".min.css")
  );
}

function isProbablyBinaryBuffer(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
}

interface RawFileRecord {
  status: ReviewChangeStatus;
  oldPath: string | null;
  newPath: string | null;
}

function displayPath(record: RawFileRecord): string {
  if (record.status === "renamed" && record.oldPath && record.newPath) {
    return `${record.oldPath} -> ${record.newPath}`;
  }
  return record.newPath ?? record.oldPath ?? "(unknown)";
}

function buildFileId(record: RawFileRecord): string {
  return `${record.status}:${record.oldPath ?? ""}:${record.newPath ?? ""}`;
}

async function getStatusRecords(
  git: GitContext,
  repoRoot: string,
  baseRevision: string,
): Promise<RawFileRecord[]> {
  const result = await runGit(
    git,
    ["diff", "--find-renames", "-M", "--name-status", "-z", baseRevision, "--"],
    repoRoot,
  );
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || "Failed to inspect Git working tree.",
    );
  }

  const entries = splitNulSeparated(result.stdout);
  const records: RawFileRecord[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const status = statusFromCode(entries[index] ?? "");
    if (!status) continue;

    if (status === "renamed") {
      const oldPath = entries[index + 1] ?? null;
      const newPath = entries[index + 2] ?? null;
      index += 2;
      if (oldPath && newPath) records.push({ status, oldPath, newPath });
      continue;
    }

    const path = entries[index + 1] ?? null;
    index += 1;
    if (!path) continue;
    records.push({
      status,
      oldPath: status === "added" ? null : path,
      newPath: status === "deleted" ? null : path,
    });
  }

  return records;
}

async function getUntrackedRecords(git: GitContext, repoRoot: string): Promise<RawFileRecord[]> {
  const result = await runGit(git, ["ls-files", "--others", "--exclude-standard", "-z"], repoRoot);
  if (result.code !== 0) return [];
  return splitNulSeparated(result.stdout).map((path) => ({
    status: "added" as const,
    oldPath: null,
    newPath: path,
  }));
}

// Mirrors Git's C-style path quoting (quote_c_style): control bytes, DEL,
// double quotes, and backslashes are escaped, and with core.quotePath=true
// (the default) non-ASCII UTF-8 bytes become octal escapes.
function quoteGitPathToken(path: string): string {
  const bytes = Buffer.from(path, "utf8");
  const needsQuote = bytes.some(
    (byte) => byte < 0x20 || byte >= 0x7f || byte === 0x22 || byte === 0x5c,
  );
  if (!needsQuote) return path;

  const named: Record<number, string> = {
    0x07: "\\a",
    0x08: "\\b",
    0x09: "\\t",
    0x0a: "\\n",
    0x0b: "\\v",
    0x0c: "\\f",
    0x0d: "\\r",
    0x22: '\\"',
    0x5c: "\\\\",
  };
  let quoted = '"';
  for (const byte of bytes) {
    const escaped = named[byte];
    if (escaped) quoted += escaped;
    else if (byte < 0x20 || byte >= 0x7f) quoted += `\\${byte.toString(8).padStart(3, "0")}`;
    else quoted += String.fromCharCode(byte);
  }
  return `${quoted}"`;
}

// Git's boundary line cannot be parsed generically: paths with spaces are not
// quoted (diff --git a/with space.txt b/with space.txt), while non-ASCII paths
// are C-quoted. Since the status records already carry exact paths, match
// boundary lines exactly against the expected forms of each record.
function expectedBoundaryLines(record: RawFileRecord): string[] {
  const oldPath = record.oldPath ?? record.newPath ?? "";
  const newPath = record.newPath ?? record.oldPath ?? "";
  const lines: string[] = [];
  for (const oldToken of new Set([`a/${oldPath}`, quoteGitPathToken(`a/${oldPath}`)])) {
    for (const newToken of new Set([`b/${newPath}`, quoteGitPathToken(`b/${newPath}`)])) {
      lines.push(`diff --git ${oldToken} ${newToken}`);
    }
  }
  return lines;
}

function splitPatchIntoFilePatches(
  patch: string,
  boundaryKeys: Map<string, string>,
): Map<string, string> {
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const patches = new Map<string, string[]>();
  let currentKey: string | null = null;
  let currentBody: string[] = [];

  // A type change (file to symlink, for instance) emits one section per side
  // under the same boundary line; keep every section.
  const commit = (): void => {
    if (currentKey !== null) {
      patches.set(currentKey, [...(patches.get(currentKey) ?? []), ...currentBody]);
    }
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      commit();
      currentKey = boundaryKeys.get(line) ?? null;
      currentBody = [line];
      continue;
    }
    if (currentKey === null) continue;
    currentBody.push(line);
  }
  commit();

  return new Map(
    [...patches.entries()].map(([key, linesForPatch]) => [key, `${linesForPatch.join("\n")}\n`]),
  );
}

// Patches are keyed by file id rather than path: a file removed from the
// index appears both as a deletion and as an untracked addition.
async function getTrackedPatches(
  git: GitContext,
  repoRoot: string,
  baseRevision: string,
  records: RawFileRecord[],
): Promise<Map<string, string>> {
  const patchMap = new Map<string, string>();
  if (records.length === 0) return patchMap;

  const args = [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--find-renames",
    "-M",
    baseRevision,
    "--",
  ];
  const result = await runGit(git, args, repoRoot);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Failed to read Git diff.");
  }

  const boundaryKeys = new Map<string, string>();
  for (const record of records) {
    for (const line of expectedBoundaryLines(record)) {
      boundaryKeys.set(line, buildFileId(record));
    }
  }

  const split = splitPatchIntoFilePatches(result.stdout, boundaryKeys);
  for (const record of records) {
    const key = buildFileId(record);
    patchMap.set(key, split.get(key) ?? "");
  }
  return patchMap;
}

function buildAddedPatch(path: string, contents: string, mode = "100644"): string {
  // Split on LF only, as Git does: a CR inside a line is content, and the
  // parser drops a trailing CR.
  const lines = contents.split("\n");
  const hasTrailingNewline = lines.at(-1) === "";
  const contentLines = hasTrailingNewline ? lines.slice(0, -1) : lines;
  const hunkLines = Math.max(1, contentLines.length);
  const patchLines = [
    `diff --git a/${path} b/${path}`,
    `new file mode ${mode}`,
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${hunkLines} @@`,
  ];

  if (contentLines.length === 0) {
    patchLines.push(" ", "\\ No newline at end of file");
  } else {
    patchLines.push(...contentLines.map((line) => `+${line}`));
    if (!hasTrailingNewline) patchLines.push("\\ No newline at end of file");
  }

  return `${patchLines.join("\n")}\n`;
}

function untrackedPlaceholderPatch(path: string): string {
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n`;
}

interface UntrackedPatchResult {
  patch: string;
  kind: ReviewFileKind;
  note?: string;
  digest?: string;
}

function digestBuffer(buffer: Buffer): string {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

async function statDigest(absolutePath: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(absolutePath, constants.O_RDONLY);
    const stat = await handle.stat();
    return `size:${stat.size}:mtime:${Math.round(stat.mtimeMs)}`;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function getUntrackedPatch(
  repoRoot: string,
  record: RawFileRecord,
): Promise<UntrackedPatchResult> {
  if (!record.newPath) {
    return { patch: "", kind: "error", note: "Missing file path" };
  }

  const absolutePath = resolve(repoRoot, record.newPath);
  if (relative(repoRoot, absolutePath).startsWith("..") || absolutePath === repoRoot) {
    return { patch: "", kind: "error", note: "Refusing to read path outside the repository" };
  }

  // O_NOFOLLOW plus handle-based stat/read keeps the file identity pinned from
  // open through read, so a swapped symlink cannot leak external contents.
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | noFollow);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      try {
        const target = await readlink(absolutePath);
        return {
          patch: buildAddedPatch(record.newPath, target, "120000"),
          kind: "text",
          digest: digestBuffer(Buffer.from(target, "utf8")),
        };
      } catch (linkError) {
        return {
          patch: untrackedPlaceholderPatch(record.newPath),
          kind: "error",
          note: linkError instanceof Error ? linkError.message : String(linkError),
        };
      }
    }
    return {
      patch: untrackedPlaceholderPatch(record.newPath),
      kind: "error",
      note: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return {
        patch: untrackedPlaceholderPatch(record.newPath),
        kind: "error",
        note: "Not a regular file",
        digest: `mode:${stat.mode}`,
      };
    }

    if (stat.size > MAX_UNTRACKED_FILE_BYTES) {
      return {
        patch: untrackedPlaceholderPatch(record.newPath),
        kind: "too-large",
        note: `File is larger than ${Math.floor(MAX_UNTRACKED_FILE_BYTES / 1024)}KB`,
        digest: `size:${stat.size}:mtime:${Math.round(stat.mtimeMs)}`,
      };
    }

    const buffer = await handle.readFile();
    const digest = digestBuffer(buffer);
    if (isProbablyBinaryPath(record.newPath) || isProbablyBinaryBuffer(buffer)) {
      return {
        patch: untrackedPlaceholderPatch(record.newPath),
        kind: "binary",
        note: "Binary file",
        digest,
      };
    }

    return {
      patch: buildAddedPatch(record.newPath, buffer.toString("utf8")),
      kind: "text",
      digest,
    };
  } catch (error) {
    return {
      patch: untrackedPlaceholderPatch(record.newPath),
      kind: "error",
      note: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

interface FilePatchDetail {
  patch: string;
  kind: ReviewFileKind;
  note?: string;
  digest?: string;
}

function fingerprintFor(
  head: string | null,
  baseRevision: string,
  records: RawFileRecord[],
  patches: Map<string, FilePatchDetail>,
): string {
  const hash = createHash("sha256");
  hash.update(`head:${head ?? "none"}\n`);
  hash.update(`base:${baseRevision}\n`);

  const ordered = [...records].sort((a, b) => buildFileId(a).localeCompare(buildFileId(b)));
  for (const record of ordered) {
    const patch = patches.get(buildFileId(record));
    hash.update(`${buildFileId(record)}\n${patch?.kind ?? "missing"}\n`);
    if (patch) hash.update(patch.patch);
    if (patch?.digest) hash.update(patch.digest);
    hash.update("\0");
  }

  return hash.digest("hex");
}

// Everything before the first hunk. The index line names the blob on each
// side, which keeps the fingerprint sensitive to content the review itself
// no longer carries.
function patchHeader(patch: string): string {
  const lines = patch.split("\n");
  const firstHunk = lines.findIndex((line) => line.startsWith("@@ -"));
  return firstHunk < 0 ? patch : `${lines.slice(0, firstHunk).join("\n")}\n`;
}

const OMITTED_NOTE = "Omitted because the complete review snapshot exceeded 1MB";

export async function captureReviewSnapshot(
  runner: RunGitLike,
  cwd: string,
  options: CaptureOptions = {},
): Promise<ReviewSnapshot> {
  const git: GitContext = { runner, signal: options.signal };
  const repoRoot = await getRepoRoot(git, cwd);
  const repositoryHasHead = await hasHead(git, repoRoot);
  const baseRevision = repositoryHasHead ? "HEAD" : await emptyTreeRevision(git, repoRoot);
  const head = repositoryHasHead
    ? (await runGit(git, ["rev-parse", "HEAD"], repoRoot)).stdout.trim()
    : null;

  const records = await getStatusRecords(git, repoRoot, baseRevision);
  const untrackedRecords = await getUntrackedRecords(git, repoRoot);
  const recordKeys = new Set(records.map(buildFileId));
  for (const record of untrackedRecords) {
    if (!recordKeys.has(buildFileId(record))) records.push(record);
  }

  const trackedRecords = records.filter((record) => record.oldPath !== null);
  const trackedPatches = await getTrackedPatches(git, repoRoot, baseRevision, trackedRecords);

  const details = new Map<string, FilePatchDetail>();
  let totalPatchBytes = 0;
  let truncated = false;

  for (const record of records) {
    const key = buildFileId(record);
    const untracked = record.oldPath === null && record.newPath !== null;
    let kind: ReviewFileKind = "text";
    let note: string | undefined;
    let patch = trackedPatches.get(key) ?? "";
    let digest: string | undefined;

    // The budget is checked before touching the file system, so an untracked
    // file past it is never opened, read, or hashed.
    if (totalPatchBytes <= MAX_TOTAL_DIFF_BYTES) {
      if (untracked) {
        const result = await getUntrackedPatch(repoRoot, record);
        patch = result.patch;
        kind = result.kind;
        note = result.note;
        digest = result.digest;
      } else if (
        BINARY_PATCH_MARKER.test(patch) ||
        isProbablyBinaryPath(record.newPath ?? record.oldPath ?? "")
      ) {
        // Keep the real patch: its index line carries the blob hashes, which the
        // fingerprint relies on to notice content changes.
        kind = "binary";
        note = "Binary file";
      } else if (Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES) {
        kind = "too-large";
        note = `Patch is larger than ${Math.floor(MAX_PATCH_BYTES / 1024)}KB`;
        patch = patchHeader(patch);
      }
      totalPatchBytes += Buffer.byteLength(patch, "utf8");
    }

    if (totalPatchBytes > MAX_TOTAL_DIFF_BYTES) {
      truncated = true;
      kind = "too-large";
      note = OMITTED_NOTE;
      patch = patchHeader(patch);
      if (!digest && untracked && record.newPath) {
        digest = await statDigest(resolve(repoRoot, record.newPath));
      }
    }

    details.set(key, { patch, kind, note, digest });
  }

  const files: ReviewFile[] = records.map((record) => {
    const detail = details.get(buildFileId(record)) ?? { patch: "", kind: "error" as const };
    return {
      id: buildFileId(record),
      oldPath: record.oldPath,
      newPath: record.newPath,
      displayPath: displayPath(record),
      status: record.status,
      kind: detail.kind,
      reviewable: detail.kind === "text" && detail.patch.length > 0,
      patch: detail.patch,
      hunks: [],
      note: detail.note,
    };
  });

  return {
    repoRoot,
    baseRevision,
    head,
    fingerprint: fingerprintFor(head, baseRevision, records, details),
    files,
    skippedCount: files.filter((file) => !file.reviewable).length,
    truncated,
  };
}
