import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import type { RunGitLike } from "../diff-annotator/git.ts";
import { parseReviewSnapshot, type ParsedReview } from "../diff-annotator/parser.ts";
import type { DiffStyleTheme } from "../diff-annotator/render.ts";
import { DiffReviewerComponent } from "../diff-annotator/reviewer.ts";
import type { ReviewComment, ReviewFile, ReviewSnapshot } from "../diff-annotator/types.ts";

const execFileAsync = promisify(execFile);

// Temporary repositories must not inherit the developer's Git configuration
// (commit signing, diff and colour settings), so only the repository-local
// configuration applies.
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

export const realGit: RunGitLike = {
  async exec(command, args, options) {
    try {
      const result = await execFileAsync(command, args, {
        cwd: options?.cwd,
        timeout: options?.timeout,
        signal: options?.signal,
        env: gitEnv,
        maxBuffer: 64 * 1024 * 1024,
      });
      return { code: 0, stdout: result.stdout, stderr: result.stderr, killed: false };
    } catch (error) {
      const failed = error as {
        code?: unknown;
        killed?: boolean;
        stdout?: string;
        stderr?: string;
      };
      return {
        code: typeof failed.code === "number" ? failed.code : 1,
        stdout: failed.stdout ?? "",
        stderr: failed.stderr ?? String(error),
        killed: failed.killed === true,
      };
    }
  },
};

export async function git(directory: string, ...args: string[]): Promise<string> {
  const result = await realGit.exec("git", args, { cwd: directory });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

export async function createRepo(
  t: TestContext,
  prefix: string,
  initArgs: string[] = [],
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `pi-diff-annotator-${prefix}-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await git(directory, "init", ...initArgs);
  return directory;
}

export async function gitCommit(directory: string, message = "init"): Promise<void> {
  await git(
    directory,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=t@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    message,
  );
}

export function baseFilePatch(path = "src/example.ts"): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,3 +1,4 @@",
    " const one = 1;",
    "-const two = 2;",
    "+const two = 3;",
    "+const three = 4;",
    " const end = true;",
    "\\ No newline at end of file",
    "",
  ].join("\n");
}

export function testTheme(): DiffStyleTheme {
  return {
    fg: (_color, text) => `[fg]${text}[/]`,
    bg: (_color, text) => `[bg]${text}[/]`,
  };
}

export function textFile(
  path: string,
  patch: string,
  overrides: Partial<ReviewFile> = {},
): ReviewFile {
  return {
    id: `modified:${path}:${path}`,
    oldPath: path,
    newPath: path,
    displayPath: path,
    status: "modified",
    kind: "text",
    reviewable: true,
    patch,
    hunks: [],
    ...overrides,
  };
}

export function snapshot(patch = baseFilePatch()): ReviewSnapshot {
  return {
    repoRoot: "/repo",
    baseRevision: "HEAD",
    head: "abc123",
    fingerprint: "abcdef1234567890",
    files: [textFile("src/example.ts", patch)],
    skippedCount: 0,
    truncated: false,
  };
}

export function parse(patch?: string): ParsedReview {
  return parseReviewSnapshot(snapshot(patch));
}

export function makeComponent(
  parsedFiles: ReviewFile[],
  parsedLines: ParsedReview,
  comments: ReviewComment[],
  onDone: (value: unknown) => void,
  snapshotOverrides: Partial<ReviewSnapshot> = {},
): DiffReviewerComponent {
  const fakeTui = {
    terminal: { columns: 100, rows: 20 },
    requestRender() {},
  };
  const fakeTheme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  return new DiffReviewerComponent(fakeTui as never, fakeTheme as never, {} as never, onDone, {
    snapshot: { ...snapshot(), files: parsedFiles, ...snapshotOverrides },
    parsed: parsedLines,
    height: 20,
    comments,
  });
}
