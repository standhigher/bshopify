import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execa } from "execa";
import { deployProject, devProject, initProject, runCli } from "../src";
import { bshopifyStateDir } from "../src/app/runner/constants";
import { configFileName } from "../src/app/commands/init/constants";
import { manifestFileName } from "../src/app/commands/init/manifest";
import {
  assertProjectInitialized,
  projectNotInitializedMessage,
} from "../src/app/commands/init/ready";
import { ansi, formatCliError } from "../src/utils/output";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliEntry = join(repoRoot, "src", "cli.ts");
const manifestSource = "{\"version\":1}\n";
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function createTempProject(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "bshopify-init-ready-"));
  tempDirs.push(cwd);
  await writeFile(join(cwd, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  return cwd;
}

async function writeManifest(cwd: string, contents: string): Promise<void> {
  await mkdir(join(cwd, bshopifyStateDir), { recursive: true });
  await writeFile(join(cwd, bshopifyStateDir, manifestFileName), contents);
}

async function writeInitializedProject(cwd: string): Promise<void> {
  await writeManifest(cwd, manifestSource);
  await writeFile(join(cwd, configFileName), "export default {};\n");
}

describe("assertProjectInitialized", () => {
  it("rejects a checkout that has never been initialized", async () => {
    const cwd = await createTempProject();

    await expect(assertProjectInitialized(cwd)).rejects.toThrow(projectNotInitializedMessage(cwd));
  });

  it("rejects a checkout that only has bshopify.config.mjs", async () => {
    const cwd = await createTempProject();
    await writeFile(join(cwd, configFileName), "export default {};\n");

    await expect(assertProjectInitialized(cwd)).rejects.toThrow(projectNotInitializedMessage(cwd));
  });

  it("rejects an empty manifest", async () => {
    const cwd = await createTempProject();
    await writeManifest(cwd, "");
    await writeFile(join(cwd, configFileName), "export default {};\n");

    await expect(assertProjectInitialized(cwd)).rejects.toThrow(projectNotInitializedMessage(cwd));
  });

  it("rejects a manifest that is not JSON", async () => {
    const cwd = await createTempProject();
    await writeManifest(cwd, "not-json\n");
    await writeFile(join(cwd, configFileName), "export default {};\n");

    await expect(assertProjectInitialized(cwd)).rejects.toThrow(projectNotInitializedMessage(cwd));
  });

  it("rejects a manifest object that has no numeric version", async () => {
    const cwd = await createTempProject();
    await writeManifest(cwd, "{}\n");
    await writeFile(join(cwd, configFileName), "export default {};\n");

    await expect(assertProjectInitialized(cwd)).rejects.toThrow(projectNotInitializedMessage(cwd));
  });

  it("rejects a valid manifest when the runner config is missing", async () => {
    const cwd = await createTempProject();
    await writeManifest(cwd, manifestSource);

    await expect(assertProjectInitialized(cwd)).rejects.toThrow(projectNotInitializedMessage(cwd));
  });

  it("accepts a checkout with a versioned manifest and runner config", async () => {
    const cwd = await createTempProject();
    await writeInitializedProject(cwd);

    await expect(assertProjectInitialized(cwd)).resolves.toBeUndefined();
  });
});

describe("commands that require init", () => {
  it("stops app dev before Shopify CLI and prints a red error", async () => {
    const cwd = await createTempProject();
    const runShopifyCommand = vi.fn(async () => 0);
    const message = projectNotInitializedMessage(cwd);

    const error = await devProject({ cwd, runShopifyCommand }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
    expect(runShopifyCommand).not.toHaveBeenCalled();
    expect(formatCliError(error)).toBe(
      [
        "",
        `${ansi.bold[0]}${ansi.red[0]}Error${ansi.red[1]}${ansi.bold[1]}`,
        "",
        `${ansi.red[0]}  ${message}${ansi.red[1]}`,
        "",
      ].join("\n"),
    );
  });

  it("prints the red init error from the CLI process", async () => {
    const cwd = await createTempProject();
    const message = projectNotInitializedMessage(cwd);
    const result = await execa(
      process.execPath,
      ["--import", "tsx/esm", cliEntry, "app", "dev", "--cwd", cwd],
      { cwd: repoRoot, reject: false },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`${ansi.bold[0]}${ansi.red[0]}Error${ansi.red[1]}${ansi.bold[1]}`);
    expect(result.stderr).toContain(`${ansi.red[0]}  ${message}${ansi.red[1]}`);
  });

  it("stops app deploy before Shopify CLI", async () => {
    const cwd = await createTempProject();
    const runShopifyCommand = vi.fn(async () => 0);

    await expect(
      deployProject({
        configName: "dev",
        cwd,
        dryRun: true,
        runShopifyCommand,
        yes: true,
      }),
    ).rejects.toThrow(projectNotInitializedMessage(cwd));
    expect(runShopifyCommand).not.toHaveBeenCalled();
  });

  it("reports a missing init before a deploy flag conflict", async () => {
    const cwd = await createTempProject();

    await expect(
      deployProject({
        cwd,
        shopifyArgs: ["--reset"],
        yes: true,
      }),
    ).rejects.toThrow(projectNotInitializedMessage(cwd));
  });

  it("stops app guard and does not pass it through to Shopify CLI", async () => {
    const cwd = await createTempProject();
    const previous = process.cwd();
    const runShopifyCommand = vi.fn(async () => 0);
    process.chdir(cwd);

    try {
      await expect(
        runCli(["node", "bshopify", "app", "guard"], {
          notifyIfOutdated: async () => undefined,
          runShopifyCommand,
          triggerAutoUpgrade: () => undefined,
        }),
      ).rejects.toThrow(projectNotInitializedMessage(process.cwd()));
      expect(runShopifyCommand).not.toHaveBeenCalled();
    } finally {
      process.chdir(previous);
    }
  });

  it("runs app dev after init", async () => {
    const cwd = await createTempProject();
    await writeFile(join(cwd, "shopify.app.dev.toml"), "name = \"dev\"\n");
    await writeFile(join(cwd, "shopify.app.test.toml"), "name = \"test\"\n");
    await writeFile(join(cwd, "shopify.app.production.toml"), "name = \"production\"\n");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runShopifyCommand = vi.fn(async () => 0);

    const initResult = await initProject({ cwd });
    expect(initResult.errors).toEqual([]);

    await expect(devProject({ cwd, runShopifyCommand })).resolves.toBe(0);
    expect(runShopifyCommand).toHaveBeenCalledOnce();
  });

  it("runs app guard after the manifest and runner config exist", async () => {
    const cwd = await createTempProject();
    await writeInitializedProject(cwd);
    const previous = process.cwd();
    const runShopifyCommand = vi.fn(async () => 0);
    process.chdir(cwd);

    try {
      await runCli(["node", "bshopify", "app", "guard"], {
        notifyIfOutdated: async () => undefined,
        runShopifyCommand,
        triggerAutoUpgrade: () => undefined,
      });
      expect(runShopifyCommand).not.toHaveBeenCalled();
    } finally {
      process.chdir(previous);
    }
  });
});

describe("commands that do not require init", () => {
  it("still runs init --check, clear, and Shopify passthrough", async () => {
    const cwd = await createTempProject();
    const runShopifyCommand = vi.fn(async () => 0);
    const previousExitCode = process.exitCode;
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await runCli(["node", "bshopify", "app", "init", "--check", "--cwd", cwd], {
        notifyIfOutdated: async () => undefined,
        triggerAutoUpgrade: () => undefined,
      });
      await runCli(["node", "bshopify", "app", "clear", "--yes", "--cwd", cwd], {
        notifyIfOutdated: async () => undefined,
        triggerAutoUpgrade: () => undefined,
      });
      await runCli(["node", "bshopify", "theme", "dev"], {
        notifyIfOutdated: async () => undefined,
        runShopifyCommand,
        triggerAutoUpgrade: () => undefined,
      });
    } finally {
      process.exitCode = previousExitCode;
    }

    expect(runShopifyCommand).toHaveBeenCalledWith(["theme", "dev"]);
  });

  it("prints help without requiring init", async () => {
    const cwd = await createTempProject();
    const previous = process.cwd();
    process.chdir(cwd);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("help-exit");
    }) as typeof process.exit);

    try {
      await expect(
        runCli(["node", "bshopify", "--help"], {
          notifyIfOutdated: async () => undefined,
          triggerAutoUpgrade: () => undefined,
        }),
      ).rejects.toThrow("help-exit");
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      process.chdir(previous);
    }
  });
});
