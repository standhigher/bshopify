import { execFile } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { isNodeError } from "#/utils/node";

const execFileAsync = promisify(execFile);

const gitCommandTimeoutMs = 30_000;
const gitIndexLockRetryMs = 200;
const gitIndexLockRetryDeadlineMs = 5_000;
const lsofTimeoutMs = 2_000;
const lsofCommands = ["/usr/sbin/lsof", "lsof"] as const;

type LsofLockState = "in-use" | "not-in-use" | "unknown";

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
 * `git add` takes `index.lock`. Editors (and a killed filter process) often
 * leave that file behind, which is why injections stay in Source Control and
 * a manual `git add` then errors with "index.lock: File exists". Stale locks
 * are removed only when lsof confirms there is no holder. Live lock
 * contention is retried for a few seconds. A timed-out `git add` is not
 * retried: the hung process is cleaned up once, then refresh gives up.
 */
export async function refreshGitIndexForRestoredFiles(
  cwd: string,
  restoredPaths: string[],
): Promise<void> {
  if (restoredPaths.length === 0) {
    return;
  }

  try {
    await recoverStaleGitIndexLock(cwd);
    const refreshable = await findRefreshableFiles(cwd, [...new Set(restoredPaths)]);

    if (refreshable.length > 0) {
      await addFilesToRefreshIndex(cwd, refreshable);
    }
  } catch {
    // Best effort: a git state refresh problem must not break the command.
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
      if (isGitCommandTimeout(error)) {
        await recoverStaleGitIndexLock(cwd);
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
  const { stdout, stderr } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: gitCommandTimeoutMs,
  });

  return { stderr, stdout };
}

async function recoverStaleGitIndexLock(cwd: string): Promise<void> {
  const lockPath = await resolveGitIndexLockPath(cwd);

  if (lockPath === undefined) {
    return;
  }

  try {
    await stat(lockPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  if (await isGitIndexLockInUse(lockPath)) {
    return;
  }

  await rm(lockPath, { force: true });
}

async function resolveGitIndexLockPath(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execGit(cwd, ["rev-parse", "--git-path", "index.lock"]);
    const gitPath = stdout.trim();

    if (gitPath.length === 0) {
      return undefined;
    }

    return isAbsolute(gitPath) ? gitPath : join(cwd, gitPath);
  } catch {
    return undefined;
  }
}

async function isGitIndexLockInUse(lockPath: string): Promise<boolean> {
  return (await probeLsof(lockPath)) !== "not-in-use";
}

async function probeLsof(lockPath: string): Promise<LsofLockState> {
  for (const command of lsofCommands) {
    try {
      const { stdout } = await execFileAsync(command, ["-t", lockPath], {
        encoding: "utf8",
        timeout: lsofTimeoutMs,
      });
      return stdout.trim().length > 0 ? "in-use" : "not-in-use";
    } catch (error) {
      // lsof exits 1 when no process has the file open.
      if (isExitCode(error, 1)) {
        return "not-in-use";
      }
    }
  }

  // lsof missing or failed: do not delete the lock. A live `git add` can
  // leave a 0-byte lock while clean filters run.
  return "unknown";
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

function isExitCode(error: unknown, code: number): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
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
