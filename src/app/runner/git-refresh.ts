import { execFile } from "node:child_process";
import { isAbsolute, relative } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
 */
export async function refreshGitIndexForRestoredFiles(
  cwd: string,
  restoredPaths: string[],
): Promise<void> {
  if (restoredPaths.length === 0) {
    return;
  }

  try {
    const refreshable = await findRefreshableFiles(cwd, [...new Set(restoredPaths)]);

    if (refreshable.length > 0) {
      await execFileAsync("git", ["-C", cwd, "add", "--", ...refreshable]);
    }
  } catch {
    // Best effort: a git state refresh problem must not break the command.
  }
}

async function findRefreshableFiles(cwd: string, paths: string[]): Promise<string[]> {
  const refreshable: string[] = [];

  for (const path of paths) {
    const repoRelative = toRepoRelativePath(cwd, path);

    if (repoRelative === undefined) {
      continue;
    }

    // Only tracked files: `git add` on an untracked file would stage it.
    try {
      await execFileAsync("git", ["-C", cwd, "ls-files", "--error-unmatch", "--", repoRelative]);
    } catch {
      continue;
    }

    // Only files with no real change versus the index: `git add` must never
    // stage user work, so files carrying an actual diff are skipped.
    try {
      await execFileAsync("git", ["-C", cwd, "diff", "--quiet", "--", repoRelative]);
    } catch {
      continue;
    }

    refreshable.push(repoRelative);
  }

  return refreshable;
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
