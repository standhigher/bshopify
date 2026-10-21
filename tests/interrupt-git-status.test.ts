import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execa } from "execa";
import { cleanFilterScript } from "../src/app/commands/init/constants";
import { composeInjection } from "../src/app/runner/compose-injection";
import { refreshGitIndexForRestoredFiles } from "../src/app/runner/git-refresh";
import {
  currentInterruptSignal,
  runWithoutInterrupt,
  withInterruptProtection,
  type InterruptListenerHost,
} from "../src/app/runner/interrupt";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliEntry = join(repoRoot, "src", "cli.ts");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: unknown; stderr?: unknown; stdout?: unknown };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stderr: String(e.stderr ?? ""),
      stdout: String(e.stdout ?? ""),
    };
  }
}

const source = '{{ "__SHOPIFY_APP_PROXY_BASE__" }}\n';
const relTarget = join("extensions", "x", "blocks", "app-embed.liquid");
const injected = composeInjection(
  source,
  relTarget,
  "__SHOPIFY_APP_PROXY_BASE__",
  "https://proxy.example.com",
  true,
).content;

/**
 * Creates a git repo wired exactly like `bshopify app init` (the generated
 * clean filter + `.gitattributes`), with the placeholder liquid committed and
 * the index stat cache poisoned the way a live injection does.
 */
async function createPoisonedRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "bshopify-interrupt-git-"));
  tempDirs.push(cwd);
  const scriptPath = join(cwd, ".bshopify", "git-add-cleaner.js");
  await mkdir(dirname(scriptPath), { recursive: true });
  await writeFile(scriptPath, cleanFilterScript);
  await git(cwd, ["init", "-q"]);
  await git(cwd, ["config", "user.email", "t@t.co"]);
  await git(cwd, ["config", "user.name", "t"]);
  await git(cwd, ["config", "core.autocrlf", "false"]);
  await git(cwd, ["config", "filter.bshopify.clean", `node ${scriptPath}`]);
  await git(cwd, ["config", "filter.bshopify.smudge", `node ${scriptPath} --smudge`]);
  await git(cwd, ["config", "filter.bshopify.required", "false"]);
  await writeFile(join(cwd, ".gitattributes"), "# bshopify cli\nextensions/** filter=bshopify\n");
  await writeFile(join(cwd, ".gitignore"), ".bshopify/\n");

  const targetPath = join(cwd, relTarget);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, source);
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-qm", "placeholder"]);

  // Live dev session: injected, then `git add` poisons the stat cache, then
  // the file is restored to placeholder bytes.
  await writeFile(targetPath, injected);
  await git(cwd, ["add", "--", relTarget]);
  await writeFile(targetPath, source);
  return cwd;
}

describe("refreshGitIndexForRestoredFiles during an interrupt", () => {
  it("clears the phantom change when the interrupt signal is not aborted", async () => {
    const cwd = await createPoisonedRepo();
    const targetPath = join(cwd, relTarget);
    await refreshGitIndexForRestoredFiles(cwd, [targetPath]);
    expect((await git(cwd, ["status", "--porcelain"])).stdout).toBe("");
  });

  it("leaves the phantom change when aborted and called inside the interrupt context", async () => {
    const cwd = await createPoisonedRepo();
    const targetPath = join(cwd, relTarget);
    const host = new EventEmitter() as InterruptListenerHost & EventEmitter;

    await withInterruptProtection(async () => {
      host.emit("SIGINT", "SIGINT");
      expect(currentInterruptSignal()?.aborted).toBe(true);
      await refreshGitIndexForRestoredFiles(cwd, [targetPath]);
    }, host);

    expect((await git(cwd, ["status", "--porcelain"])).stdout).toContain(` M ${relTarget}`);
  });

  it("clears the phantom change when aborted and run outside the interrupt context", async () => {
    const cwd = await createPoisonedRepo();
    const targetPath = join(cwd, relTarget);
    const host = new EventEmitter() as InterruptListenerHost & EventEmitter;

    await withInterruptProtection(async () => {
      host.emit("SIGINT", "SIGINT");
      expect(currentInterruptSignal()?.aborted).toBe(true);
      await runWithoutInterrupt(() => refreshGitIndexForRestoredFiles(cwd, [targetPath]));
    }, host);

    expect((await git(cwd, ["status", "--porcelain"])).stdout).toBe("");
  });
});

describe("app dev git status after SIGINT", () => {
  it("restores the file and leaves Source Control clean after a real SIGINT", async () => {
    const project = await createInterruptProject();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const child = spawnCli(["app", "dev", "--cwd", project.cwd], project.readyFile);

    await waitForInjectedCli(child, project);
    child.kill("SIGINT");
    const result = await child;

    expect(result.exitCode).toBe(130);
    await expect(readFile(project.targetPath, "utf8")).resolves.toBe(project.placeholder);
    await expectMissing(project.lockPath);
    await expectMissing(project.journalPath);
    // The regression: a Ctrl+C right after injection must not leave the file
    // showing as "modified" (phantom, empty diff) in Source Control, and the
    // restore-phase `git add` must not have left the index unusable.
    const status = await git(project.cwd, ["status", "--porcelain", "--", project.targetRel]);
    expect(status.code).toBe(0);
    expect(status.stdout).toBe("");
  }, 20_000);

  it("keeps Source Control clean after a repeated Ctrl+C during dev", async () => {
    const project = await createInterruptProject();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const child = spawnCliDetached(["app", "dev", "--cwd", project.cwd], project.readyFile);

    await waitForInjectedCli(child, project);
    // Simulate a terminal Ctrl+C delivering SIGINT to the whole process group,
    // pressed a few times like `^C^C`: the extra signals must not kill the
    // restore-phase `git add` and leave the phantom change behind. The child
    // is detached so its pid is its process-group id; kill(-pid) targets the
    // whole group (CLI + shopify), and ESRCH just means it already exited.
    signalGroup(child.pid);
    for (let i = 0; i < 4; i += 1) {
      await delay(20);
      signalGroup(child.pid);
    }
    const result = await child;

    expect(result.exitCode).toBe(130);
    await expect(readFile(project.targetPath, "utf8")).resolves.toBe(project.placeholder);
    await expectMissing(project.lockPath);
    await expectMissing(project.journalPath);
    const status = await git(project.cwd, ["status", "--porcelain", "--", project.targetRel]);
    expect(status.code).toBe(0);
    expect(status.stdout).toBe("");
  }, 20_000);
});

interface InterruptProject {
  cwd: string;
  journalPath: string;
  lockPath: string;
  placeholder: string;
  readyFile: string;
  targetPath: string;
  targetRel: string;
}

async function createInterruptProject(): Promise<InterruptProject> {
  const cwd = await mkdtemp(join(tmpdir(), "bshopify-interrupt-e2e-"));
  tempDirs.push(cwd);
  const targetRel = join("extensions", "theme-extension", "blocks", "app-embed.liquid");
  const targetPath = join(cwd, targetRel);
  const placeholder = '<div data-api-base="__SHOPIFY_APP_PROXY_BASE__"></div>\n';

  await git(cwd, ["init", "-q"]);
  await git(cwd, ["config", "user.email", "t@t.co"]);
  await git(cwd, ["config", "user.name", "t"]);
  await git(cwd, ["config", "core.autocrlf", "false"]);
  const scriptPath = join(cwd, ".bshopify", "git-add-cleaner.js");
  await mkdir(dirname(scriptPath), { recursive: true });
  await writeFile(scriptPath, cleanFilterScript);
  await git(cwd, ["config", "filter.bshopify.clean", `node ${scriptPath}`]);
  await git(cwd, ["config", "filter.bshopify.smudge", `node ${scriptPath} --smudge`]);
  await git(cwd, ["config", "filter.bshopify.required", "false"]);
  await writeFile(join(cwd, ".gitattributes"), "# bshopify cli\nextensions/** filter=bshopify\n");
  await writeFile(join(cwd, ".gitignore"), ".bshopify/\n");

  await writeFile(join(cwd, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  await writeFile(
    join(cwd, "shopify.app.dev.toml"),
    [
      'name = "fixture"',
      'client_id = "client-id"',
      "",
      "[app_proxy]",
      'prefix = "apps"',
      'subpath = "fixture-dev"',
      'url = "https://example.test/proxy"',
      "",
    ].join("\n"),
  );
  await writeFile(
    join(cwd, "bshopify.config.mjs"),
    'export default { configFiles: { dev: "shopify.app.dev.toml" } };\n',
  );
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, placeholder);
  await writeFile(
    join(cwd, "extensions", "theme-extension", "__entry.js"),
    [
      "export default {",
      "  async prepare(ctx) {",
      "    return {",
      "      injections: [",
      "        {",
      '          file: "blocks/app-embed.liquid",',
      '          strategy: "replace",',
      '          pattern: "__SHOPIFY_APP_PROXY_BASE__",',
      "          value: ctx.appConfig.app_proxy ? `/${ctx.appConfig.app_proxy.prefix}/${ctx.appConfig.app_proxy.subpath}` : undefined,",
      "        },",
      "      ],",
      "    };",
      "  },",
      "};",
      "",
    ].join("\n"),
  );

  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-qm", "fixture"]);

  await installFakeShopify(cwd);

  return {
    cwd,
    journalPath: join(cwd, ".bshopify", "extension-prepare.transaction.json"),
    lockPath: join(cwd, ".bshopify", "extension-prepare.lock"),
    placeholder,
    readyFile: join(cwd, ".bshopify", "shopify-ready"),
    targetPath,
    targetRel,
  };
}

async function installFakeShopify(cwd: string): Promise<void> {
  const binDir = join(cwd, "node_modules", ".bin");
  const shopifyPath = join(binDir, "shopify");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    shopifyPath,
    [
      "#!/usr/bin/env node",
      'import { writeFileSync } from "node:fs";',
      'import { setTimeout as delay } from "node:timers/promises";',
      "",
      "const readyFile = process.env.BSHOPIFY_INTERRUPT_READY_FILE;",
      'if (typeof readyFile === "string" && readyFile.length > 0) {',
      "  writeFileSync(readyFile, `${process.pid}\\n`);",
      "}",
      "",
      'await delay(Number(process.env.BSHOPIFY_INTERRUPT_HOLD_MS ?? "30000"));',
      "",
    ].join("\n"),
  );
  await chmod(shopifyPath, 0o755);
}

function spawnCli(args: string[], readyFile: string) {
  return execa(process.execPath, ["--import", "tsx/esm", cliEntry, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BSHOPIFY_INTERRUPT_HOLD_MS: "30000",
      BSHOPIFY_INTERRUPT_READY_FILE: readyFile,
    },
    extendEnv: true,
    reject: false,
  });
}

function spawnCliDetached(args: string[], readyFile: string) {
  return execa(process.execPath, ["--import", "tsx/esm", cliEntry, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BSHOPIFY_INTERRUPT_HOLD_MS: "30000",
      BSHOPIFY_INTERRUPT_READY_FILE: readyFile,
    },
    extendEnv: true,
    reject: false,
    detached: true,
  });
}

async function waitForInjectedCli(
  child: ReturnType<typeof execa>,
  project: InterruptProject,
): Promise<void> {
  try {
    await waitUntil(async () => pathExists(project.readyFile), 15_000, "Shopify mock never started");
    await waitUntil(
      async () => (await readFile(project.targetPath, "utf8")).includes("/apps/fixture-dev"),
      5_000,
      "Injection did not land before Shopify started",
    );
  } catch (error) {
    child.kill("SIGKILL");
    const result = await child;
    throw new Error(
      [
        error instanceof Error ? error.message : String(error),
        `exit=${String(result.exitCode)} signal=${String(result.signal)}`,
        result.stdout,
        result.stderr,
      ].join("\n"),
    );
  }
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }

    await delay(50);
  }

  throw new Error(message);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function expectMissing(path: string): Promise<void> {
  await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
}

function signalGroup(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }

  try {
    process.kill(-pid, "SIGINT");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}
