import { execFile } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { isNodeError } from "#/utils/node";

const execFileAsync = promisify(execFile);

const gitCommandTimeoutMs = 30_000;
const lsofTimeoutMs = 2_000;
const lsofCommands = ["/usr/sbin/lsof", "lsof"] as const;

type LsofLockState = "in-use" | "not-in-use" | "unknown";

/**
 * Removes `index.lock` only when lsof confirms nothing holds it.
 *
 * Editors and a killed filter process often leave that file behind, which
 * is why injections stay in Source Control and a manual `git add` then
 * errors with "index.lock: File exists". Live lock contention is left
 * alone so a concurrent `git add` is not interrupted.
 */
export async function recoverStaleGitIndexLock(cwd: string): Promise<void> {
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
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "rev-parse", "--git-path", "index.lock"],
      {
        encoding: "utf8",
        timeout: gitCommandTimeoutMs,
      },
    );
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

function isExitCode(error: unknown, code: number): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
