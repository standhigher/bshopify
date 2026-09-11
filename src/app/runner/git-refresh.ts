import { execFile } from "node:child_process";
import { isAbsolute, relative } from "node:path";
import { promisify } from "node:util";
import { recoverStaleGitIndexLock } from "./git-index-lock";
import { currentInterruptSignal } from "./interrupt";

const execFileAsync = promisify(execFile);

const gitCommandTimeoutMs = 30_000;
const gitIndexLockRetryMs = 200;
const gitIndexLockRetryDeadlineMs = 5_000;
const gitIndexLockReleaseRetries = 20;
const gitIndexLockReleaseRetryMs = 100;

/**
 * Refreshes the git index stat cache for files whose cleaned working tree
 * already matches the index, so editors do not show injection-only changes.
 *
 * Used in two places:
 *
 * 1. After injection, while `app dev` / `app deploy` is running. `git add`
 *    runs the clean filter, stores the placeholder blob (nothing injected
 *    is staged) and records the stat of the *injected* file. Git's stat
 *    fast path then treats the worktree as unmodified, so Source Control
 *    stays clean for the rest of the session. Real user edits still show:
 *    the clean filter keeps them, `git diff` is no longer empty, and those
 *    files are skipped.
 *
 * 2. After restore. The same `git add` during a live injection poisons the
 *    stat cache: git records the injected size, then the placeholder bytes
 *    are written back. The file equals the index blob, yet git's stat fast
 *    path (read-cache.c `ie_modified`) treats a size change as "modified"
 *    WITHOUT comparing content — a phantom change with an empty diff.
 *
 * The only reconciliation is a real `git add`, which re-runs the clean
 * filter, sees the blob is unchanged (so nothing new is staged) and refreshes
 * the stat cache. Files with real user edits are left untouched: bshopify
 * never stages user work. Everything is best-effort and never fails the
 * surrounding dev/deploy/clear flow.
 *
 * `git add` takes `index.lock`. Stale locks are recovered first, including
 * when there are no files to refresh (exit / crash leftover). Live lock
 * contention is retried for a few seconds. A timed-out or interrupted
 * `git add` is not retried: the hung process is killed, then the lock is
 * recovered once the fd is gone.
 */
export async function refreshGitIndexForRestoredFiles(
  cwd: string,
  restoredPaths: string[],
): Promise<void> {
  try {
    await recoverStaleGitIndexLock(cwd);

    if (restoredPaths.length === 0) {
      return;
    }

    const refreshable = await findRefreshableFiles(cwd, [...new Set(restoredPaths)]);

    if (refreshable.length > 0) {
      await addFilesToRefreshIndex(cwd, refreshable);
    }
  } catch {
    // Best effort: a git state refresh problem must not break the command.
  } finally {
    await recoverStaleGitIndexLock(cwd, {
      retries: gitIndexLockReleaseRetries,
      retryMs: gitIndexLockReleaseRetryMs,
    }).catch(() => undefined);
  }
}

async function addFilesToRefreshIndex(cwd: string, files: string[]): Promise<void> {
  const deadline = Date.now() + gitIndexLockRetryDeadlineMs;

  while (true) {
    await recoverStaleGitIndexLock(cwd);

    try {
      await execGit(cwd, ["add", "--", ...files]);
      return;
    } catch (error) {
      if (isGitCommandTimeout(error) || isAbortError(error)) {
        warnGitIndexRefreshSkipped();
        return;
      }

      if (!isGitIndexLockError(error)) {
        throw error;
      }

      if (Date.now() >= deadline) {
        warnGitIndexRefreshSkipped();
        return;
      }

      await sleep(gitIndexLockRetryMs);
    }
  }
}

async function findRefreshableFiles(cwd: string, paths: string[]): Promise<string[]> {
  const repoRelative = paths
    .map((path) => toRepoRelativePath(cwd, path))
    .filter((path): path is string => path !== undefined);

  if (repoRelative.length === 0) {
    return [];
  }

  // Only tracked files: `git add` on an untracked file would stage it.
  const tracked = await listNulPaths(cwd, ["ls-files", "-z", "--", ...repoRelative]);

  if (tracked.length === 0) {
    return [];
  }

  // Only files with no real change versus the index: `git add` must never
  // stage user work, so files carrying an actual diff are skipped. One
  // `git diff` for the whole set avoids N extra git processes (and N more
  // chances to collide on index.lock).
  const changed = new Set(await listNulPaths(cwd, ["diff", "-z", "--name-only", "--", ...tracked]));
  return tracked.filter((path) => !changed.has(path));
}

async function listNulPaths(cwd: string, args: string[]): Promise<string[]> {
  const { stdout } = await execGit(cwd, args);
  return stdout.split("\0").filter((path) => path.length > 0);
}

async function execGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const signal = currentInterruptSignal();
  const { stdout, stderr } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: gitCommandTimeoutMs,
    ...(signal === undefined ? {} : { signal }),
  });

  return { stderr, stdout };
}

function isGitIndexLockError(error: unknown): boolean {
  return gitErrorText(error).includes("index.lock");
}

function isGitCommandTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const record = error as { killed?: unknown; signal?: unknown };
  return record.killed === true || record.signal === "SIGTERM" || record.signal === "SIGKILL";
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const record = error as { code?: unknown; name?: unknown };
  return record.code === "ABORT_ERR" || record.name === "AbortError";
}

function gitErrorText(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "";
  }

  const record = error as { message?: unknown; stderr?: unknown };
  return `${String(record.stderr ?? "")}\n${String(record.message ?? "")}`;
}

function warnGitIndexRefreshSkipped(): void {
  console.warn(
    "Could not refresh the git index. Injection-only changes may still appear in Source Control.",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toRepoRelativePath(cwd: string, path: string): string | undefined {
  if (!isAbsolute(path)) {
    return path;
  }

  const rel = relative(cwd, path);

  if (rel === "" || isAbsolute(rel) || rel.startsWith("..")) {
    return undefined;
  }

  return rel;
}
