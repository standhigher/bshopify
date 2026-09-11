import { execFile, execFileSync } from "node:child_process";
import { rmSync, statSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { isNodeError } from "#/utils/node";

const execFileAsync = promisify(execFile);

const gitCommandTimeoutMs = 30_000;
const lsofTimeoutMs = 2_000;
const lsofCommands = ["/usr/sbin/lsof", "lsof"] as const;

type LsofLockState = "in-use" | "not-in-use" | "unknown";

export interface RecoverGitIndexLockOptions {
  retries?: number;
  retryMs?: number;
}

/**
 * Removes `index.lock` only when lsof confirms nothing holds it.
 *
 * Our `git add` (index refresh) and a killed clean-filter process leave
 * that file behind. Live lock contention is left alone so a concurrent
 * `git add` / `git switch` is not interrupted.
 */
export async function recoverStaleGitIndexLock(
  cwd: string,
  options: RecoverGitIndexLockOptions = {},
): Promise<void> {
  const lockPath = await resolveGitIndexLockPath(cwd);

  if (lockPath === undefined) {
    return;
  }

  await recoverGitIndexLockAtPath(lockPath, options);
}

export async function recoverGitIndexLockAtPath(
  lockPath: string,
  options: RecoverGitIndexLockOptions = {},
): Promise<void> {
  const retries = options.retries ?? 0;
  const retryMs = options.retryMs ?? 100;

  for (let attempt = 0; attempt <= retries; attempt++) {
    await recoverGitIndexLockAtPathOnce(lockPath);

    if (!(await gitIndexLockExists(lockPath))) {
      return;
    }

    if (attempt < retries) {
      await sleep(retryMs);
    }
  }
}

export function recoverGitIndexLockAtPathSync(lockPath: string): void {
  if (!gitIndexLockExistsSync(lockPath)) {
    return;
  }

  if (isGitIndexLockInUseSync(lockPath)) {
    return;
  }

  rmSync(lockPath, { force: true });
}

export async function resolveGitIndexLockPath(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "rev-parse", "--git-path", "index.lock"],
      {
        encoding: "utf8",
        timeout: gitCommandTimeoutMs,
      },
    );
    return toAbsoluteGitPath(cwd, stdout.trim());
  } catch {
    return undefined;
  }
}

async function recoverGitIndexLockAtPathOnce(lockPath: string): Promise<void> {
  if (!(await gitIndexLockExists(lockPath))) {
    return;
  }

  if (await isGitIndexLockInUse(lockPath)) {
    return;
  }

  await rm(lockPath, { force: true });
}

async function gitIndexLockExists(lockPath: string): Promise<boolean> {
  try {
    await stat(lockPath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function gitIndexLockExistsSync(lockPath: string): boolean {
  try {
    statSync(lockPath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function isGitIndexLockInUse(lockPath: string): Promise<boolean> {
  return (await probeLsof(lockPath)) !== "not-in-use";
}

function isGitIndexLockInUseSync(lockPath: string): boolean {
  return probeLsofSync(lockPath) !== "not-in-use";
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
      if (isExitCode(error, 1)) {
        return "not-in-use";
      }
    }
  }

  return "unknown";
}

function probeLsofSync(lockPath: string): LsofLockState {
  for (const command of lsofCommands) {
    try {
      const stdout = execFileSync(command, ["-t", lockPath], {
        encoding: "utf8",
        timeout: lsofTimeoutMs,
      });
      return stdout.trim().length > 0 ? "in-use" : "not-in-use";
    } catch (error) {
      if (isExitCode(error, 1)) {
        return "not-in-use";
      }
    }
  }

  return "unknown";
}

function toAbsoluteGitPath(cwd: string, gitPath: string): string | undefined {
  if (gitPath.length === 0) {
    return undefined;
  }

  return isAbsolute(gitPath) ? gitPath : join(cwd, gitPath);
}

function isExitCode(error: unknown, code: number): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const record = error as { code?: unknown; status?: unknown };
  // execFile uses `code`; execFileSync uses `status`.
  return record.code === code || record.status === code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
