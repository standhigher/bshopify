import { spawn, type ChildProcess } from "node:child_process";
import { basename } from "node:path";
import {
  recoverGitIndexLockAtPath,
  recoverGitIndexLockAtPathSync,
  resolveGitIndexLockPath,
} from "./git-index-lock";

const watchdogPollMs = 250;
const watchdogReleaseMs = 300;
const exitRecoverRetries = 20;
const exitRecoverRetryMs = 100;

/**
 * Recovers leftover `index.lock` around a dev/deploy session.
 *
 * - Start: drop a stale lock from a previous crashed `git add`.
 * - Exit / interrupt: drop the lock after our git child has died.
 * - Crash (`process.exit`, uncaught exception, SIGKILL): a detached
 *   watchdog waits for this pid to disappear, then drops the lock if
 *   nothing else holds it.
 */
export async function withGitIndexLockGuard<T>(
  cwd: string,
  work: () => Promise<T>,
): Promise<T> {
  const lockPath = await resolveGitIndexLockPath(cwd);

  if (lockPath !== undefined) {
    await recoverGitIndexLockAtPath(lockPath);
  }

  const stopWatchdog = startGitIndexLockWatchdog(lockPath, process.pid);
  const onExit = (): void => {
    if (lockPath !== undefined) {
      recoverGitIndexLockAtPathSync(lockPath);
    }
  };

  process.on("exit", onExit);

  try {
    return await work();
  } finally {
    process.off("exit", onExit);

    try {
      if (lockPath !== undefined) {
        await recoverGitIndexLockAtPath(lockPath, {
          retries: exitRecoverRetries,
          retryMs: exitRecoverRetryMs,
        });
      }
    } catch {
      // Lock recovery must not skip stopping the watchdog or fail the command.
    } finally {
      stopWatchdog();
    }
  }
}

export function startGitIndexLockWatchdog(
  lockPath: string | undefined,
  parentPid: number,
): () => void {
  if (lockPath === undefined || basename(lockPath) !== "index.lock") {
    return () => undefined;
  }

  let child: ChildProcess;

  try {
    child = spawn(process.execPath, ["-e", watchdogSource], {
      detached: true,
      env: {
        BSHOPIFY_GIT_LOCK_WATCHDOG_LOCK: lockPath,
        BSHOPIFY_GIT_LOCK_WATCHDOG_PARENT: String(parentPid),
        BSHOPIFY_GIT_LOCK_WATCHDOG_POLL_MS: String(watchdogPollMs),
        BSHOPIFY_GIT_LOCK_WATCHDOG_RELEASE_MS: String(watchdogReleaseMs),
        PATH: process.env.PATH,
      },
      stdio: "ignore",
    });
    child.unref();
  } catch {
    return () => undefined;
  }

  return () => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone after a clean session exit.
    }
  };
}

const watchdogSource = `
const { execFileSync } = require("node:child_process");
const { rmSync, statSync } = require("node:fs");
const { basename } = require("node:path");

const lockPath = process.env.BSHOPIFY_GIT_LOCK_WATCHDOG_LOCK;
const parentPid = Number(process.env.BSHOPIFY_GIT_LOCK_WATCHDOG_PARENT);
const pollMs = Number(process.env.BSHOPIFY_GIT_LOCK_WATCHDOG_POLL_MS || 250);
const releaseMs = Number(process.env.BSHOPIFY_GIT_LOCK_WATCHDOG_RELEASE_MS || 300);

if (typeof lockPath !== "string" || basename(lockPath) !== "index.lock" || !Number.isInteger(parentPid) || parentPid <= 0) {
  process.exit(0);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code !== "ESRCH");
  }
}

function exists() {
  try {
    statSync(lockPath);
    return true;
  } catch (error) {
    return !(error && error.code === "ENOENT");
  }
}

function held() {
  for (const command of ["/usr/sbin/lsof", "lsof"]) {
    try {
      const stdout = execFileSync(command, ["-t", lockPath], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      });
      return String(stdout).trim().length > 0;
    } catch (error) {
      if (error && error.status === 1) {
        return false;
      }
    }
  }
  return true;
}

function recover() {
  if (!exists() || held()) {
    return;
  }
  rmSync(lockPath, { force: true });
}

const timer = setInterval(() => {
  if (alive(parentPid)) {
    return;
  }
  clearInterval(timer);
  setTimeout(() => {
    recover();
    process.exit(0);
  }, releaseMs);
}, pollMs);
`;
