import assert from "node:assert/strict";
import { rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { captureReviewSnapshot, type RunGitLike } from "../diff-annotator/git.ts";
import { parseReviewSnapshot } from "../diff-annotator/parser.ts";
import { createRepo, git, gitCommit, realGit } from "./diff-annotator-helpers.ts";

type ExecOptions = { cwd?: string; timeout?: number; signal?: AbortSignal };
type GitResult = Awaited<ReturnType<RunGitLike["exec"]>>;

const ok = (stdout: string): GitResult => ({ code: 0, stdout, stderr: "", killed: false });

// Answers every command the capture issues for a repository with one modified
// tracked file; `intercept` injects a failure mode for a single call.
function fakeRepoRunner(
  intercept: (args: string[], options?: ExecOptions) => GitResult | undefined,
): RunGitLike {
  return {
    async exec(_command, args, options) {
      const injected = intercept(args, options);
      if (injected) return injected;
      if (args[0] === "rev-parse" && args.includes("--show-toplevel")) return ok("/repo\n");
      if (args[0] === "rev-parse") return ok("abc123\n");
      if (args[0] === "diff" && args.includes("--name-status")) return ok("M\0f\0");
      if (args[0] === "diff") {
        return ok(
          [
            "diff --git a/f b/f",
            "index 1111111..2222222 100644",
            "--- a/f",
            "+++ b/f",
            "@@ -1 +1 @@",
            "-one",
            "+two",
            "",
          ].join("\n"),
        );
      }
      return ok("");
    },
  };
}

function bulkText(seed: string): string {
  return `${Array.from({ length: 6000 }, (_, index) => `${seed} line ${index} ${"x".repeat(40)}`).join("\n")}\n`;
}

test("a diff that hits the timeout fails instead of passing partial output", async () => {
  const runner = fakeRepoRunner((args) =>
    args[0] === "diff" && !args.includes("--name-status")
      ? {
          code: 0,
          stdout:
            "diff --git a/f b/f\nindex 1111111..2222222 100644\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-one\n",
          stderr: "",
          killed: true,
        }
      : undefined,
  );

  await assert.rejects(captureReviewSnapshot(runner, "/repo"), /timed out/);
});

test("every git call carries a timeout and the caller's abort signal", async () => {
  const controller = new AbortController();
  const calls: { args: string[]; options?: ExecOptions }[] = [];
  const runner = fakeRepoRunner((args, options) => {
    calls.push({ args, options });
    return undefined;
  });

  await captureReviewSnapshot(runner, "/repo", { signal: controller.signal });

  assert.ok(calls.length >= 4, "capture issues several git commands");
  for (const call of calls) {
    const label = `git ${call.args.join(" ")}`;
    assert.ok((call.options?.timeout ?? 0) > 0, `${label} has a timeout`);
    assert.equal(call.options?.signal, controller.signal, `${label} receives the abort signal`);
  }
});

test("an aborted capture reports the cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const runner = fakeRepoRunner((_args, options) =>
    options?.signal?.aborted ? { code: 0, stdout: "", stderr: "", killed: true } : undefined,
  );

  await assert.rejects(
    captureReviewSnapshot(runner, "/repo", { signal: controller.signal }),
    /cancel/i,
  );
});

test("only git's binary marker classifies a patch as binary", async (t) => {
  const directory = await createRepo(t, "binary-marker");
  await writeFile(join(directory, "note.txt"), "Binary files a and b differ\n");
  await writeFile(join(directory, "blob.dat"), Buffer.from([0, 1, 2, 3, 0, 255]));
  await git(directory, "add", ".");
  await gitCommit(directory);
  await writeFile(join(directory, "note.txt"), "Binary files a and b differ\nmore\n");
  await writeFile(join(directory, "blob.dat"), Buffer.from([0, 9, 8, 7, 0, 254]));

  const captured = await captureReviewSnapshot(realGit, directory);
  const note = captured.files.find((file) => file.displayPath === "note.txt");
  const blob = captured.files.find((file) => file.displayPath === "blob.dat");
  assert.equal(note?.kind, "text");
  assert.equal(note?.reviewable, true, "text that mentions the marker stays reviewable");
  assert.equal(blob?.kind, "binary", "git's own marker is still recognised");
});

test("a file removed from the index keeps both its deletion and its untracked copy", async (t) => {
  const directory = await createRepo(t, "rm-cached");
  await writeFile(join(directory, "cfg.env"), "secret\n");
  await git(directory, "add", "cfg.env");
  await gitCommit(directory);
  await git(directory, "rm", "--cached", "cfg.env");

  const captured = await captureReviewSnapshot(realGit, directory);
  const deleted = captured.files.find((file) => file.status === "deleted");
  const added = captured.files.find((file) => file.status === "added");
  assert.equal(deleted?.displayPath, "cfg.env");
  assert.equal(added?.displayPath, "cfg.env");
  assert.match(deleted?.patch ?? "", /^-secret$/m, "the deletion keeps its own body");
  assert.match(added?.patch ?? "", /^\+secret$/m, "the untracked copy keeps its own body");
  assert.equal(deleted?.reviewable, true);
  assert.equal(added?.reviewable, true);
});

test("a type change keeps both of its patch sections", async (t) => {
  const directory = await createRepo(t, "typechange");
  await writeFile(join(directory, "x"), "content\n");
  await writeFile(join(directory, "target"), "t\n");
  await git(directory, "add", ".");
  await gitCommit(directory);
  await rm(join(directory, "x"));
  await symlink("target", join(directory, "x"));

  const captured = await captureReviewSnapshot(realGit, directory);
  const file = captured.files.find((candidate) => candidate.displayPath === "x");
  assert.equal(file?.status, "modified");
  assert.match(file?.patch ?? "", /^-content$/m, "the removed file body is kept");
  assert.match(file?.patch ?? "", /^\+target$/m, "the new symlink body is kept");
});

test("patches over the size cap are excluded from review but still fingerprinted", async (t) => {
  const directory = await createRepo(t, "too-large");
  await writeFile(join(directory, "big.txt"), "start\n");
  await git(directory, "add", ".");
  await gitCommit(directory);
  await writeFile(join(directory, "big.txt"), bulkText("first"));

  const first = await captureReviewSnapshot(realGit, directory);
  const file = first.files.find((candidate) => candidate.displayPath === "big.txt");
  assert.equal(file?.kind, "too-large");
  assert.equal(file?.reviewable, false);
  assert.ok(!file?.patch.includes("@@"), "hunk bodies are dropped from the snapshot");
  assert.equal(first.skippedCount, 1);

  const parsed = parseReviewSnapshot(first);
  assert.equal(parsed.files[0]?.hunks.length, 0, "nothing is parsed for the oversized patch");
  assert.ok(
    parsed.lines.some((line) => line.kind === "meta" && line.text.includes("larger than")),
    "the reason is shown in place of the diff",
  );
  assert.ok(!parsed.lines.some((line) => line.kind === "addition"), "no commentable lines");

  await writeFile(join(directory, "big.txt"), bulkText("second"));
  const second = await captureReviewSnapshot(realGit, directory);
  assert.notEqual(
    first.fingerprint,
    second.fingerprint,
    "content changes still change the fingerprint",
  );
});

test("untracked files past the total budget are omitted without being read", async (t) => {
  const directory = await createRepo(t, "budget");
  const filler = `${"y".repeat(63)}\n`.repeat(4000);
  for (const name of ["a1.txt", "a2.txt", "a3.txt", "a4.txt", "a5.txt"]) {
    await writeFile(join(directory, name), filler);
  }
  const last = join(directory, "zz-last.txt");
  const stamp = new Date("2024-01-01T00:00:00Z");
  await writeFile(last, "version one\n");
  await utimes(last, stamp, stamp);

  const first = await captureReviewSnapshot(realGit, directory);
  assert.equal(first.truncated, true);
  const omitted = first.files.find((file) => file.displayPath === "zz-last.txt");
  assert.equal(omitted?.kind, "too-large");
  assert.match(omitted?.note ?? "", /exceeded 1MB/);
  assert.ok(first.skippedCount >= 1);
  assert.ok(
    first.files.some((file) => file.displayPath === "a1.txt" && file.reviewable),
    "files within the budget stay reviewable",
  );

  // Same size and mtime but different content: a file that was never read
  // cannot influence the fingerprint.
  await writeFile(last, "version two\n");
  await utimes(last, stamp, stamp);
  const second = await captureReviewSnapshot(realGit, directory);
  assert.equal(
    first.fingerprint,
    second.fingerprint,
    "omitted files are fingerprinted from stat metadata only",
  );
});

test("repositories without commits work with the sha256 object format", async (t) => {
  const directory = await createRepo(t, "sha256", ["--object-format=sha256"]);
  await writeFile(join(directory, "staged.txt"), "staged\n");
  await git(directory, "add", "staged.txt");

  const captured = await captureReviewSnapshot(realGit, directory);
  const parsed = parseReviewSnapshot(captured);
  const staged = parsed.files.find((file) => file.displayPath === "staged.txt");
  assert.equal(staged?.reviewable, true);
  assert.ok(
    staged?.hunks[0]?.lines.some((line) => line.kind === "addition" && line.text === "staged"),
  );
});

test("untracked files keep a bare carriage return inside its line", async (t) => {
  const directory = await createRepo(t, "bare-cr");
  await writeFile(join(directory, "cr.txt"), "one\rtwo\nthree\r\n");

  const captured = await captureReviewSnapshot(realGit, directory);
  const parsed = parseReviewSnapshot(captured);
  const hunk = parsed.files[0]?.hunks[0];
  assert.equal(hunk?.header, "@@ -0,0 +1,2 @@");
  const additions = hunk?.lines.filter((line) => line.kind === "addition") ?? [];
  assert.deepEqual(
    additions.map((line) => line.newLine),
    [1, 2],
  );
  assert.match(additions[0]?.text ?? "", /^one.+two$/, "the bare CR stays inside the first line");
  assert.equal(additions[1]?.text, "three", "the CRLF ending is not shown");
});
