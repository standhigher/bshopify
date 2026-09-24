import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execa } from "execa";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliEntry = join(repoRoot, "src", "cli.ts");
const placeholder = '<div data-api-base="__SHOPIFY_APP_PROXY_BASE__"></div>\n';
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("Shopify child kill escalation", () => {
  it("SIGKILLs a signal-ignoring shopify child after the grace period and restores injections", async () => {
    const project = await createRunnerProject();
    await installSignalIgnoringFakeShopify(project.cwd);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const child = spawnCli(["app", "dev", "--cwd", project.cwd], project.readyFile, {
      BSHOPIFY_KILL_GRACE_MS: "200",
    });

    await waitForInjectedCli(child, project);
    child.kill("SIGINT");
    const result = await child;

    expect(result.exitCode).toBe(130);
    await expect(readFile(project.targetPath, "utf8")).resolves.toBe(placeholder);
    await expectMissing(project.lockPath);
    await expectMissing(project.journalPath);
  }, 20_000);

  it("keeps the shopify child in the parent process group so interactive stdin works", async () => {
    const project = await createRunnerProject();
    await installGroupReportingFakeShopify(project.cwd);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const child = spawnCli(["app", "dev", "--cwd", project.cwd], project.readyFile, {
      BSHOPIFY_GROUP_FILE: project.groupFile,
    });

    await waitForInjectedCli(child, project);
    await waitUntil(
      async () => pathExists(project.groupFile),
      5_000,
      "shopify group info never written",
    );
    const group = JSON.parse(await readFile(project.groupFile, "utf8")) as {
      pid: number;
      pgid: number;
    };

    // A `detached: true` child would be its own process-group leader
    // (pgid === pid), which orphans it from the terminal and breaks its
    // interactive stdin. The fix keeps it in bshopify's foreground group.
    expect(group.pgid).not.toBe(group.pid);

    child.kill("SIGINT");
    const result = await child;

    expect(result.exitCode).toBe(130);
  }, 20_000);
});

interface RunnerProject {
  cwd: string;
  groupFile: string;
  journalPath: string;
  lockPath: string;
  readyFile: string;
  targetPath: string;
}

async function createRunnerProject(): Promise<RunnerProject> {
  const cwd = await mkdtemp(join(tmpdir(), "bshopify-kill-escalation-"));
  tempDirs.push(cwd);
  const targetPath = join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid");

  await writeFile(join(cwd, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  await writeFile(join(cwd, "shopify.app.dev.toml"), shopifyToml("https://dev.example.com", "fixture-dev"));

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
    groupFile: join(cwd, "shopify-group"),
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

async function installSignalIgnoringFakeShopify(cwd: string): Promise<void> {
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
      'for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {',
      "  process.on(signal, () => {});",
      "}",
      "",
      "while (true) {",
      "  await delay(60_000);",
      "}",
      "",
    ].join("\n"),
  );
  await chmod(shopifyPath, 0o755);
}

async function installGroupReportingFakeShopify(cwd: string): Promise<void> {
  const binDir = join(cwd, "node_modules", ".bin");
  const shopifyPath = join(binDir, "shopify");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    shopifyPath,
    [
      "#!/usr/bin/env node",
      'import { writeFileSync } from "node:fs";',
      'import { execFileSync } from "node:child_process";',
      'import { setTimeout as delay } from "node:timers/promises";',
      "",
      "const readyFile = process.env.BSHOPIFY_INTERRUPT_READY_FILE;",
      'if (typeof readyFile === "string" && readyFile.length > 0) {',
      "  writeFileSync(readyFile, `${process.pid}\\n`);",
      "}",
      "",
      "const groupFile = process.env.BSHOPIFY_GROUP_FILE;",
      'if (typeof groupFile === "string" && groupFile.length > 0) {',
      '  const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());',
      "  writeFileSync(groupFile, JSON.stringify({ pid: process.pid, pgid }));",
      "}",
      "",
      "await delay(60_000);",
      "",
    ].join("\n"),
  );
  await chmod(shopifyPath, 0o755);
}

function spawnCli(
  args: string[],
  readyFile: string,
  extraEnv: Record<string, string> = {},
): ReturnType<typeof execa> {
  return execa(process.execPath, ["--import", "tsx/esm", cliEntry, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BSHOPIFY_INTERRUPT_READY_FILE: readyFile,
      ...extraEnv,
    },
    extendEnv: true,
    reject: false,
  });
}

async function waitForInjectedCli(
  child: ReturnType<typeof execa>,
  project: RunnerProject,
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
