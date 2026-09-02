import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { countUntrackedFiles, createGitStatusPoller, type GitInfo } from "../ui/status-footer.ts";

const run = promisify(execFile);

async function repository(t: TestContext, files: number): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-status-footer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await run("git", ["init", "-q"], { cwd: directory });
  for (let index = 0; index < files; index++) {
    await writeFile(join(directory, `untracked-${index}.txt`), `${index}\n`, "utf8");
  }
  return directory;
}

function info(untracked: number): GitInfo {
  return {
    dir: "repo",
    ahead: 0,
    behind: 0,
    added: 0,
    deleted: 0,
    untracked,
    untrackedTruncated: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("counts untracked files by streaming and stops at the limit", async (t) => {
  const directory = await repository(t, 5);

  assert.deepEqual(await countUntrackedFiles(directory), { count: 5, truncated: false });
  assert.deepEqual(await countUntrackedFiles(directory, 5), { count: 5, truncated: false });
  assert.deepEqual(await countUntrackedFiles(directory, 3), { count: 3, truncated: true });
});

test("reports nothing outside a repository", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-status-footer-plain-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  assert.equal(await countUntrackedFiles(directory), null);
});

test("refreshes git on a timer without overlapping reads", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const reads: Array<ReturnType<typeof deferred<GitInfo | null>>> = [];
  const read = t.mock.fn((_cwd: string) => {
    const next = deferred<GitInfo | null>();
    reads.push(next);
    return next.promise;
  });
  let changes = 0;
  const poller = createGitStatusPoller({
    cwd: () => "/repo",
    read,
    intervalMs: 2000,
    onChange: () => changes++,
  });

  assert.equal(read.mock.calls.length, 1, "reads once immediately");
  assert.equal(poller.current(), null);
  poller.current();
  t.mock.timers.tick(6000);
  poller.refresh();
  assert.equal(read.mock.calls.length, 1, "nothing overlaps the read in flight");

  reads[0]!.resolve(info(1));
  await settle();
  assert.equal(changes, 1);
  assert.deepEqual(poller.current(), info(1));
  assert.equal(read.mock.calls.length, 2, "the refresh requested during the read runs afterwards");

  reads[1]!.resolve(info(1));
  await settle();
  assert.equal(changes, 1, "unchanged results do not request a render");

  t.mock.timers.tick(2000);
  assert.equal(read.mock.calls.length, 3);
  reads[2]!.resolve(info(2));
  await settle();
  assert.equal(changes, 2);
  assert.equal(poller.current()?.untracked, 2);

  poller.dispose();
  t.mock.timers.tick(10_000);
  assert.equal(read.mock.calls.length, 3, "disposed pollers stop reading");
});

test("invalidates stale state and discards a read already in flight", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const reads: Array<ReturnType<typeof deferred<GitInfo | null>>> = [];
  const poller = createGitStatusPoller({
    cwd: () => "/repo",
    read: () => {
      const next = deferred<GitInfo | null>();
      reads.push(next);
      return next.promise;
    },
    intervalMs: 2000,
    onChange() {},
  });

  reads[0]!.resolve(info(1));
  await settle();
  assert.deepEqual(poller.current(), info(1));

  poller.refresh();
  assert.equal(reads.length, 2);
  poller.invalidate();
  assert.equal(poller.current(), null);

  reads[1]!.resolve(info(2));
  await settle();
  assert.equal(poller.current(), null, "the invalidated read is ignored");
  assert.equal(reads.length, 3, "invalidation queues a fresh read");

  reads[2]!.resolve(info(3));
  await settle();
  assert.deepEqual(poller.current(), info(3));
  poller.dispose();
});

test("drops results that finish after disposal", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const pending = deferred<GitInfo | null>();
  let changes = 0;
  const poller = createGitStatusPoller({
    cwd: () => "/repo",
    read: () => pending.promise,
    intervalMs: 2000,
    onChange: () => changes++,
  });

  poller.dispose();
  pending.resolve(info(3));
  await settle();

  assert.equal(changes, 0);
  assert.equal(poller.current(), null);
});
