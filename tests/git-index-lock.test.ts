import { execFile, spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  startGitIndexLockWatchdog,
  withGitIndexLockGuard,
} from "../src/app/runner/git-index-lock-guard";
import { recoverGitIndexLockAtPathSync, recoverStaleGitIndexLock } from "../src/app/runner/git-index-lock";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createGitRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "bshopify-git-lock-"));
  tempDirs.push(cwd);
  await execFileAsync("git", ["init", "-q"], { cwd });
  return cwd;
}

async function expectMissing(path: string): Promise<void> {
  await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }

  throw new Error(`timed out after ${String(timeoutMs)}ms`);
}

describe("recoverStaleGitIndexLock", () => {
  it("removes a leftover index.lock that no process holds", async () => {
    const cwd = await createGitRepo();
    const lockPath = join(cwd, ".git", "index.lock");
    await writeFile(lockPath, "");

    await recoverStaleGitIndexLock(cwd);

    await expectMissing(lockPath);
  });

  it("leaves index.lock in place while a process has it open", async () => {
    const cwd = await createGitRepo();
    const lockPath = join(cwd, ".git", "index.lock");
    await writeFile(lockPath, "");
    const handle = await open(lockPath, "r+");

    try {
      await recoverStaleGitIndexLock(cwd);
      await expect(readFile(lockPath, "utf8")).resolves.toBe("");
    } finally {
      await handle.close();
    }
  });

  it("sync recover removes a leftover index.lock that no process holds", async () => {
    const cwd = await createGitRepo();
    const lockPath = join(cwd, ".git", "index.lock");
    await writeFile(lockPath, "");

    recoverGitIndexLockAtPathSync(lockPath);

    await expectMissing(lockPath);
  });
});

describe("withGitIndexLockGuard", () => {
  it("removes index.lock when the session function returns", async () => {
    const cwd = await createGitRepo();
    const lockPath = join(cwd, ".git", "index.lock");

    await withGitIndexLockGuard(cwd, async () => {
      await writeFile(lockPath, "");
    });

    await expectMissing(lockPath);
  });

  it("removes index.lock when the session function throws", async () => {
    const cwd = await createGitRepo();
    const lockPath = join(cwd, ".git", "index.lock");

    await expect(
      withGitIndexLockGuard(cwd, async () => {
        await writeFile(lockPath, "");
        throw new Error("session crashed");
      }),
    ).rejects.toThrow("session crashed");

    await expectMissing(lockPath);
  });

  it("sync recover removes a leftover index.lock that no process holds", async () => {
    const cwd = await createGitRepo();
    const lockPath = join(cwd, ".git", "index.lock");
    await writeFile(lockPath, "");

    recoverGitIndexLockAtPathSync(lockPath);

    await expectMissing(lockPath);
  });
});

describe("git index lock watchdog", () => {
  it("removes index.lock after the watched process is SIGKILL'd", async () => {
    const cwd = await createGitRepo();
    const lockPath = join(cwd, ".git", "index.lock");
    const watched = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });

    if (watched.pid === undefined) {
      watched.kill("SIGKILL");
      throw new Error("failed to spawn watched process");
    }

    const stop = startGitIndexLockWatchdog(lockPath, watched.pid);
    await writeFile(lockPath, "");

    try {
      watched.kill("SIGKILL");
      await waitUntil(async () => {
        try {
          await readFile(lockPath);
          return false;
        } catch (error) {
          return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
        }
      }, 5_000);
    } finally {
      stop();
    }
  });
});
