import { EventEmitter } from "node:events";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execa } from "execa";
import { composeInjection } from "../src/app/runner/compose-injection";
import {
  runInterruptible,
  withInterruptProtection,
  type InterruptListenerHost,
} from "../src/app/runner/interrupt";
import { deployProject, devProject } from "../src";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliEntry = join(repoRoot, "src", "cli.ts");
const placeholder = '<div data-api-base="__SHOPIFY_APP_PROXY_BASE__"></div>\n';
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("runInterruptible", () => {
  it("returns the work exit code when no signal arrives", async () => {
    await expect(runInterruptible(async () => 7, new EventEmitter())).resolves.toBe(7);
  });

  it("returns 130 when SIGINT arrives while work is running", async () => {
    const host = new EventEmitter() as InterruptListenerHost & EventEmitter;
    const exitCode = await runInterruptible(async () => {
      host.emit("SIGINT", "SIGINT");
      return 0;
    }, host);

    expect(exitCode).toBe(130);
  });

  it("returns 143 when SIGTERM arrives while work is running", async () => {
    const host = new EventEmitter() as InterruptListenerHost & EventEmitter;
    const exitCode = await runInterruptible(async () => {
      host.emit("SIGTERM", "SIGTERM");
      return 0;
    }, host);

    expect(exitCode).toBe(143);
  });

  it("returns 130 when work throws a canceled Shopify error", async () => {
    const exitCode = await runInterruptible(async () => {
      throw interruptError("SIGINT");
    }, new EventEmitter());

    expect(exitCode).toBe(130);
  });

  it("still throws non-interrupt failures", async () => {
    await expect(
      runInterruptible(async () => {
        throw new Error("shopify exploded");
      }, new EventEmitter()),
    ).rejects.toThrow("shopify exploded");
  });

  it("removes signal listeners after the session ends", async () => {
    const host = new EventEmitter() as InterruptListenerHost & EventEmitter;

    await withInterruptProtection(async () => 0, host);

    expect(host.listenerCount("SIGINT")).toBe(0);
    expect(host.listenerCount("SIGTERM")).toBe(0);
    expect(host.listenerCount("SIGHUP")).toBe(0);
  });
});

describe("dev and deploy restore on interrupt", () => {
  it("restores injected files when the Shopify dev command is canceled", async () => {
    const project = await createRunnerProject();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let seenInjected = "";
    const runShopifyCommand = vi.fn(async () => {
      seenInjected = await readFile(project.targetPath, "utf8");
      throw interruptError("SIGINT");
    });

    const exitCode = await devProject({ cwd: project.cwd, runShopifyCommand });

    expect(seenInjected).toContain("/apps/fixture-dev");
    expect(seenInjected).toContain("bshopify-restore:");
    expect(exitCode).toBe(130);
    await expect(readFile(project.targetPath, "utf8")).resolves.toBe(placeholder);
    await expectMissing(project.lockPath);
    await expectMissing(project.journalPath);
  });

  it("restores injected files when the Shopify deploy command is canceled", async () => {
    const project = await createRunnerProject({ withTestConfig: true });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let seenInjected = "";
    const runShopifyCommand = vi.fn(async () => {
      seenInjected = await readFile(project.targetPath, "utf8");
      throw interruptError("SIGTERM");
    });

    const exitCode = await deployProject({
      configName: "test",
      cwd: project.cwd,
      runShopifyCommand,
      yes: true,
    });

    expect(seenInjected).toBe('<div data-api-base="/apps/fixture-test"></div>\n');
    expect(seenInjected).not.toContain("bshopify-restore:");
    expect(exitCode).toBe(143);
    await expect(readFile(project.targetPath, "utf8")).resolves.toBe(placeholder);
    await expectMissing(project.lockPath);
    await expectMissing(project.journalPath);
  });

  it("does not run afterDeploy when deploy is interrupted", async () => {
    const project = await createRunnerProject({ withTestConfig: true });
    await writeFile(
      join(project.cwd, "extensions", "theme-extension", "__entry.js"),
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
        "  async afterDeploy() {",
        '    throw new Error("afterDeploy should not run on interrupt");',
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const exitCode = await deployProject({
      configName: "test",
      cwd: project.cwd,
      runShopifyCommand: vi.fn(async () => {
        throw interruptError("SIGINT");
      }),
      yes: true,
    });

    expect(exitCode).toBe(130);
    await expect(readFile(project.targetPath, "utf8")).resolves.toBe(placeholder);
  });

  it("restores leftover marker injections from a killed process on the next dev run", async () => {
    const project = await createRunnerProject();
    const staleValue = "https://stale.example.com/proxy";
    const composed = composeInjection(
      placeholder,
      project.targetPath,
      "__SHOPIFY_APP_PROXY_BASE__",
      staleValue,
      true,
    );
    await mkdir(join(project.cwd, ".bshopify"), { recursive: true });
    await writeFile(project.targetPath, composed.content);
    await writeFile(project.lockPath, "999999999\n");
    await writeFile(
      project.journalPath,
      `${JSON.stringify({
        files: [
          {
            path: project.targetPath,
            replacements: [
              {
                marker: composed.marker,
                pattern: "__SHOPIFY_APP_PROXY_BASE__",
                value: staleValue,
              },
            ],
          },
        ],
      })}\n`,
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runShopifyCommand = vi.fn(async () => {
      const current = await readFile(project.targetPath, "utf8");
      expect(current).toContain("/apps/fixture-dev");
      expect(current).not.toContain(staleValue);
      return 0;
    });

    await devProject({ cwd: project.cwd, runShopifyCommand });

    await expect(readFile(project.targetPath, "utf8")).resolves.toBe(placeholder);
    await expectMissing(project.journalPath);
    await expectMissing(project.lockPath);
  });
});

describe("process interrupt restore", () => {
  it("restores dev injections when the CLI process receives SIGINT after injection", async () => {
    const project = await createRunnerProject();
    await installFakeShopify(project.cwd);
    const child = spawnCli(["app", "dev", "--cwd", project.cwd], project.readyFile);

    await waitForInjectedCli(child, project);
    child.kill("SIGINT");
    const result = await child;

    expect(result.exitCode).toBe(130);
    await expect(readFile(project.targetPath, "utf8")).resolves.toBe(placeholder);
    await expectMissing(project.lockPath);
    await expectMissing(project.journalPath);
  }, 20_000);

  it("restores deploy injections when the CLI process receives SIGINT after injection", async () => {
    const project = await createRunnerProject({ withTestConfig: true });
    await installFakeShopify(project.cwd);
    const child = spawnCli(
      ["app", "deploy", "--config", "test", "--yes", "--cwd", project.cwd],
      project.readyFile,
    );

    await waitForInjectedCli(child, project, "/apps/fixture-test");
    child.kill("SIGINT");
    const result = await child;

    expect(result.exitCode).toBe(130);
    await expect(readFile(project.targetPath, "utf8")).resolves.toBe(placeholder);
    await expectMissing(project.lockPath);
    await expectMissing(project.journalPath);
  }, 20_000);

  it("restores leftover injections on the next run after SIGKILL", async () => {
    const project = await createRunnerProject();
    await installFakeShopify(project.cwd);
    const child = spawnCli(["app", "dev", "--cwd", project.cwd], project.readyFile);

    await waitForInjectedCli(child, project);
    const fakeShopifyPid = Number((await readFile(project.readyFile, "utf8")).trim());
    child.kill("SIGKILL");
    killPid(fakeShopifyPid);
    await child;

    await expect(readFile(project.targetPath, "utf8")).resolves.toContain("/apps/fixture-dev");
    await expect(readFile(project.lockPath, "utf8")).resolves.toMatch(/^\d+\n$/);

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runShopifyCommand = vi.fn(async () => {
      const current = await readFile(project.targetPath, "utf8");
      expect(current).toContain("/apps/fixture-dev");
      expect(current).not.toContain("https://stale.example.com/proxy");
      return 0;
    });

    await devProject({ cwd: project.cwd, runShopifyCommand });

    await expect(readFile(project.targetPath, "utf8")).resolves.toBe(placeholder);
    await expectMissing(project.lockPath);
    await expectMissing(project.journalPath);
  }, 20_000);
});

interface RunnerProject {
  cwd: string;
  journalPath: string;
  lockPath: string;
  readyFile: string;
  targetPath: string;
}

async function createRunnerProject(options: { withTestConfig?: boolean } = {}): Promise<RunnerProject> {
  const cwd = await mkdtemp(join(tmpdir(), "bshopify-interrupt-"));
  tempDirs.push(cwd);
  const targetPath = join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid");

  await writeFile(join(cwd, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  await writeFile(join(cwd, "shopify.app.dev.toml"), shopifyToml("https://dev.example.com", "fixture-dev"));

  if (options.withTestConfig === true) {
    await writeFile(join(cwd, "shopify.app.test.toml"), shopifyToml("https://test.example.com", "fixture-test"));
  }

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

  return {
    cwd,
    journalPath: join(cwd, ".bshopify", "extension-prepare.transaction.json"),
    lockPath: join(cwd, ".bshopify", "extension-prepare.lock"),
    readyFile: join(cwd, "shopify-ready"),
    targetPath,
  };
}

function shopifyToml(applicationUrl: string, subpath: string): string {
  return [
    'name = "fixture"',
    'client_id = "client-id"',
    `application_url = "${applicationUrl}"`,
    "",
    "[app_proxy]",
    'prefix = "apps"',
    `subpath = "${subpath}"`,
    'url = "https://example.test/proxy"',
    "",
  ].join("\n");
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

async function waitForInjectedCli(
  child: ReturnType<typeof execa>,
  project: RunnerProject,
  injectedValue = "/apps/fixture-dev",
): Promise<void> {
  try {
    await waitUntil(async () => pathExists(project.readyFile), 15_000, "Shopify mock never started");
    await waitUntil(
      async () => (await readFile(project.targetPath, "utf8")).includes(injectedValue),
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

function interruptError(signal: NodeJS.Signals): Error {
  return Object.assign(new Error("Command was canceled"), {
    isCanceled: true,
    signal,
  });
}

function killPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The child may already be gone after the parent was killed.
  }
}
