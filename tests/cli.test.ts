import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@inquirer/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@inquirer/prompts")>();

  return {
    ...actual,
    confirm: vi.fn(async () => true),
    input: vi.fn(async () => "confirm"),
    select: vi.fn(async ({ choices }: { choices: Array<{ value: string }> }) => choices[0]?.value),
  };
});

import { createAppCommand } from "../src/app/commands";
import { formatDeploySummary } from "../src/app/commands/deploy/summary";
import { formatCliError } from "../src/utils/output";
import {
  createCliProgram,
  deployProject,
  devProject,
  packageInfo,
  runShopifyCommand,
  runCli,
} from "../src";
import { findManagedEntries, loadManagedEntryHooks } from "../src/extension/entries";
import { managedEntryTemplate } from "../src/extension/manage-content";
import { defaultRunnerConfig } from "../src/app/runner/config";
import type { RunnerContextBase } from "../src/app/runner/types";

interface CommandWithRuntimeHiddenFlag {
  _hidden?: boolean;
}

interface PackageJsonFixture {
  bin: Record<string, string>;
  name: string;
  scripts: Record<string, string>;
  version: string;
}

interface TsConfigFixture {
  compilerOptions?: {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
}

interface EmittedWarning {
  code?: string;
}

const tempDirs: string[] = [];

function createEmptyInitResult() {
  return {
    checks: [],
    created: [],
    errors: [],
    skipped: [],
    updated: [],
    warnings: [],
  };
}

async function createDevProject(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "bshopify-dev-"));
  tempDirs.push(cwd);

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
  await mkdir(join(cwd, "extensions", "theme-extension", "blocks"), { recursive: true });
  await writeFile(
    join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid"),
    '<div data-api-base="__SHOPIFY_APP_PROXY_BASE__"></div>\n',
  );
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

  return cwd;
}

function createShopifyBasicConfig(applicationUrl: string): string[] {
  return [
    'client_id = "client-id"',
    'name = "fixture"',
    `application_url = "${applicationUrl}"`,
  ];
}

async function readSourceFiles(dir: string): Promise<Array<{ path: string; content: string }>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);

      if (entry.isDirectory()) {
        return readSourceFiles(path);
      }

      if (!entry.isFile() || !entry.name.endsWith(".ts")) {
        return [];
      }

      return [{ path, content: await readFile(path, "utf8") }];
    }),
  );

  return files.flat();
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true })));
  vi.restoreAllMocks();
});

describe("bshopify CLI", () => {
  it("formats thrown CLI errors with red spacing", () => {
    const output = formatCliError(
      new Error(
        [
          "Unresolved deploy placeholders found after extension entry injection.",
          "  - extensions/theme-extension/blocks/app-embed.liquid: __SHOPIFY_APP_PROXY_BASE__",
        ].join("\n"),
      ),
    );

    expect(output).toBe(
      [
        "",
        "\u001B[1m\u001B[31mError\u001B[39m\u001B[22m",
        "",
        "\u001B[31m  Unresolved deploy placeholders found after extension entry injection.\u001B[39m",
        "\u001B[31m  - extensions/theme-extension/blocks/app-embed.liquid: __SHOPIFY_APP_PROXY_BASE__\u001B[39m",
        "",
      ].join("\n"),
    );
  });

  it("formats deploy summaries as a prominent block with long values on their own lines", () => {
    const output = formatDeploySummary(
      {
        configPath: "shopify.app.test.toml",
        env: "test",
        appConfig: {
          application_url: "https://api.platform.test.standhigher.com/api/v2/shopify/entry/test",
        },
      } as RunnerContextBase,
      [],
      false,
    );

    expect(output).toContain("\u001B[1m\u001B[46m\u001B[30m DEPLOY SUMMARY \u001B[39m\u001B[49m\u001B[22m");
    expect(output).toContain("\n  \u001B[1m\u001B[36mApplication URL\u001B[39m\u001B[22m\n    \u001B[1mhttps://api.platform.test.standhigher.com/api/v2/shopify/entry/test\u001B[22m");
    expect(output).toContain("\n  \u001B[1m\u001B[36mApp Proxy\u001B[39m\u001B[22m\n    \u001B[90m(not configured)\u001B[39m");
    expect(output).not.toContain("Application URL:");
  });

  it("omits imported production config review details from deploy summaries", () => {
    const output = formatDeploySummary(
      {
        configPath: "shopify.app.production.toml",
        env: "production",
        appConfig: {
          application_url: "https://api.platform.test.standhigher.com/api/v2/shopify/entry/production",
        },
      } as RunnerContextBase,
      [],
      false,
    );

    expect(output).toContain("\u001B[1m\u001B[46m\u001B[30m DEPLOY SUMMARY \u001B[39m\u001B[49m\u001B[22m");
    expect(output).toContain("\n  \u001B[1m\u001B[36mApplication URL\u001B[39m\u001B[22m\n    \u001B[1mhttps://api.platform.test.standhigher.com/api/v2/shopify/entry/production\u001B[22m");
    expect(output).not.toContain("PRODUCTION CONFIG REVIEW REQUIRED");
    expect(output).not.toContain("Review these imported Shopify production values before deploy.");
    expect(output).not.toContain("application_url");
    expect(output).not.toContain("webhooks.api_version");
  });

  it("exposes the package name and version", () => {
    expect(packageInfo.name).toBe("@standhigher/bshopify");
    expect(packageInfo.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("reads package metadata from package.json", async () => {
    const packageJson = JSON.parse(
      await readFile(join(process.cwd(), "package.json"), "utf8"),
    ) as PackageJsonFixture;
    const rootIndex = await readFile(join(process.cwd(), "src", "index.ts"), "utf8");
    const mainSource = await readFile(join(process.cwd(), "src", "main.ts"), "utf8");
    const packageJsonSource = await readFile(
      join(process.cwd(), "src", "utils", "package-json.ts"),
      "utf8",
    );
    const tsupConfig = await readFile(join(process.cwd(), "tsup.config.ts"), "utf8");
    const sourceFiles = await readSourceFiles(join(process.cwd(), "src"));
    const hardcodedPackageInfo = sourceFiles
      .filter((file) => file.content.includes(`version: "${packageJson.version}"`))
      .map((file) => file.path);

    expect(packageInfo).toEqual({
      name: packageJson.name,
      version: packageJson.version,
    });
    expect(packageJson.bin).toEqual({
      bshopify: "./dist/cli.js",
      bs: "./dist/cli.js",
    });
    await expect(stat(join(process.cwd(), "src", "package-info.ts"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(rootIndex).toContain('export { packageInfo } from "./utils/package-json";');
    expect(rootIndex).toContain('export type { PackageInfo } from "./utils/package-json";');
    expect(mainSource).toContain('./utils/package-json');
    expect(packageJsonSource).toContain("export const packageInfo");
    expect(packageJsonSource).toContain("__BSHOPIFY_PACKAGE_NAME__");
    expect(packageJsonSource).toContain("__BSHOPIFY_PACKAGE_VERSION__");
    expect(tsupConfig).toContain("__BSHOPIFY_PACKAGE_NAME__");
    expect(tsupConfig).toContain("__BSHOPIFY_PACKAGE_VERSION__");
    expect(packageJson.scripts.check).toContain("npm run verify:dist");
    expect(packageJson.scripts["verify:dist"]).toBe("node dist/cli.js --help");
    expect(hardcodedPackageInfo).toEqual([]);
  });

  it("registers app-level bshopify commands", () => {
    const program = createCliProgram();
    const commands = program.commands
      .filter((command) => !isRuntimeHiddenCommand(command))
      .map((command) => command.name())
      .sort();
    const appCommand = program.commands.find((command) => command.name() === "app");

    expect(commands).toEqual(["app"]);
    expect(appCommand?.commands.map((command) => command.name()).sort()).toEqual([
      "clear",
      "deploy",
      "dev",
      "guard",
      "init",
    ]);
  });

  it("builds app commands from the app command module", () => {
    const appCommand = createAppCommand();

    expect(appCommand.name()).toBe("app");
    expect(appCommand.commands.map((command) => command.name()).sort()).toEqual([
      "clear",
      "deploy",
      "dev",
      "guard",
      "init",
    ]);
  });

  it("does not expose implicit help subcommands", () => {
    const programHelp = createCliProgram().helpInformation();
    const appHelp = createAppCommand().helpInformation();

    expect(programHelp).not.toContain("help [command]");
    expect(appHelp).not.toContain("help [command]");
  });

  it("uses extensionless relative TypeScript imports", async () => {
    const sourceFiles = await readSourceFiles(join(process.cwd(), "src"));
    const relativeImportWithExtensionPattern =
      /(?:from\s+["']|import\(["'])(?:\.{1,2}\/[^"']+)\.(?:js|ts)["']/;
    const offenders = sourceFiles
      .filter((file) => relativeImportWithExtensionPattern.test(file.content))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it("uses source path aliases instead of deep relative imports", async () => {
    const tsconfig = JSON.parse(
      await readFile(join(process.cwd(), "tsconfig.json"), "utf8"),
    ) as TsConfigFixture;
    const vitestConfig = await readFile(
      join(process.cwd(), "vitest.config.ts"),
      "utf8",
    );
    const sourceFiles = await readSourceFiles(join(process.cwd(), "src"));
    const deepRelativeImportPattern =
      /(?:from\s+["']|import\(["'])\.\.\/\.\.\/(?:[^"']*)["']/;
    const offenders = sourceFiles
      .filter((file) => deepRelativeImportPattern.test(file.content))
      .map((file) => file.path);

    expect(tsconfig.compilerOptions?.paths?.["#/*"]).toEqual(["./src/*"]);
    expect(vitestConfig).toContain('find: "#"');
    expect(offenders).toEqual([]);
  });

  it("uses root index.ts as the only explicit public re-export surface", async () => {
    const sourceFiles = await readSourceFiles(join(process.cwd(), "src"));
    const wildcardExportPattern = /export\s+\*\s+from\s+["'][^"']+["']/;
    const explicitReExportPattern =
      /export\s+(?:\{[\s\S]*?\}|type\s+\{[\s\S]*?\})\s+from\s+["'][^"']+["']/;
    const rootIndex = await readFile(join(process.cwd(), "src", "index.ts"), "utf8");
    const wildcardOffenders = sourceFiles
      .filter((file) => wildcardExportPattern.test(file.content))
      .map((file) => file.path);
    const offenders = sourceFiles
      .filter(
        (file) =>
          file.path !== join(process.cwd(), "src", "index.ts") &&
          explicitReExportPattern.test(file.content),
      )
      .map((file) => file.path);

    await expect(stat(join(process.cwd(), "src", "exports.ts"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(rootIndex).toContain('export { createCliProgram, runCli, runShopifyCommand } from "./main";');
    expect(rootIndex).toContain('export { packageInfo } from "./utils/package-json";');
    expect(rootIndex).toContain('export { deployProject } from "./app/commands/deploy";');
    expect(rootIndex).toContain('export { devProject } from "./app/commands/dev";');
    expect(rootIndex).toContain('export { formatInitResult, initProject } from "./app/commands/init";');
    expect(rootIndex).toContain('export type { CliDependencies, ProcessRunner, ShopifyCommandRunner } from "./main";');
    expect(rootIndex).toContain('export type { PackageInfo } from "./utils/package-json";');
    expect(rootIndex).toContain('export type { DeployOptions } from "./app/runner/types";');
    expect(rootIndex).toContain('export type { DevOptions } from "./app/runner/types";');
    expect(rootIndex).toContain('export type { InitCheck, InitOptions, InitResult } from "./app/commands/init/types";');
    expect(wildcardOffenders).toEqual([]);
    expect(offenders).toEqual([]);
  });

  it("keeps CLI runtime code in main.ts", async () => {
    const sourceFiles = await readSourceFiles(join(process.cwd(), "src"));
    const cliProgramReferences = sourceFiles
      .filter((file) => file.content.includes("cli-program"))
      .map((file) => file.path);

    await expect(stat(join(process.cwd(), "src", "main.ts"))).resolves.toBeTruthy();
    expect(cliProgramReferences).toEqual([]);
  });

  it("keeps reusable app runner modules above concrete commands", async () => {
    const rootUtilsSourceFiles = await readSourceFiles(
      join(process.cwd(), "src", "utils"),
    );
    const extensionSourceFiles = await readSourceFiles(
      join(process.cwd(), "src", "extension"),
    );
    const runnerSourceFiles = await readSourceFiles(
      join(process.cwd(), "src", "app", "runner"),
    );
    const deploySourceFiles = await readSourceFiles(
      join(process.cwd(), "src", "app", "commands", "deploy"),
    );
    const devSourceFiles = await readSourceFiles(
      join(process.cwd(), "src", "app", "commands", "dev"),
    );
    const initSourceFiles = await readSourceFiles(
      join(process.cwd(), "src", "app", "commands", "init"),
    );
    const oversizedFiles = [
      ...rootUtilsSourceFiles,
      ...extensionSourceFiles,
      ...runnerSourceFiles,
      ...deploySourceFiles,
      ...devSourceFiles,
      ...initSourceFiles,
    ]
      .filter((file) => file.content.split(/\r?\n/).length > 250)
      .map((file) => file.path);
    expect(rootUtilsSourceFiles.map((file) => file.path).sort()).toEqual(
      expect.arrayContaining([
        join(process.cwd(), "src", "utils", "config.ts"),
        join(process.cwd(), "src", "utils", "files.ts"),
        join(process.cwd(), "src", "utils", "node.ts"),
        join(process.cwd(), "src", "utils", "objects.ts"),
        join(process.cwd(), "src", "utils", "output.ts"),
        join(process.cwd(), "src", "utils", "package-json.ts"),
        join(process.cwd(), "src", "utils", "markers.ts"),
        join(process.cwd(), "src", "utils", "paths.ts"),
      ]),
    );
    expect(extensionSourceFiles.map((file) => file.path).sort()).toEqual(
      expect.arrayContaining([
        join(process.cwd(), "src", "extension", "entries.ts"),
        join(process.cwd(), "src", "extension", "entry-loader.ts"),
        join(process.cwd(), "src", "extension", "manage-content.ts"),
        join(process.cwd(), "src", "extension", "manage.ts"),
        join(process.cwd(), "src", "extension", "paths.ts"),
        join(process.cwd(), "src", "extension", "types.ts"),
      ]),
    );
    await expect(stat(join(process.cwd(), "src", "app", "utils", "extensions.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(process.cwd(), "src", "app", "runner", "utils.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(process.cwd(), "src", "app", "runner", "markers.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(process.cwd(), "src", "app", "utils.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(process.cwd(), "src", "app", "runner", "entries.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(process.cwd(), "src", "app", "runner", "entry-loader.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(process.cwd(), "src", "app", "commands", "init", "extension-entries.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(process.cwd(), "src", "app", "commands", "init", "extension-entry-content.ts"))).rejects.toMatchObject({ code: "ENOENT" });

    expect(runnerSourceFiles.map((file) => file.path).sort()).toEqual(
      expect.arrayContaining([
        join(process.cwd(), "src", "app", "runner", "config.ts"),
        join(process.cwd(), "src", "app", "runner", "context.ts"),
        join(process.cwd(), "src", "app", "runner", "injections.ts"),
        join(process.cwd(), "src", "app", "runner", "lock.ts"),
        join(process.cwd(), "src", "app", "runner", "shopify.ts"),
        join(process.cwd(), "src", "app", "runner", "transaction.ts"),
        join(process.cwd(), "src", "app", "runner", "types.ts"),
      ]),
    );
    expect(deploySourceFiles.map((file) => file.path).sort()).toEqual([
      join(process.cwd(), "src", "app", "commands", "deploy", "config.ts"),
      join(process.cwd(), "src", "app", "commands", "deploy", "index.ts"),
      join(process.cwd(), "src", "app", "commands", "deploy", "summary.ts"),
    ]);
    expect(devSourceFiles.map((file) => file.path).sort()).toEqual([
      join(process.cwd(), "src", "app", "commands", "dev", "index.ts"),
    ]);
    expect(initSourceFiles.map((file) => file.path).sort()).toEqual(
      expect.arrayContaining([
        join(process.cwd(), "src", "app", "commands", "init", "checks.ts"),
        join(process.cwd(), "src", "app", "commands", "init", "constants.ts"),
        join(process.cwd(), "src", "app", "commands", "init", "files.ts"),
        join(process.cwd(), "src", "app", "commands", "init", "git-hooks.ts"),
        join(process.cwd(), "src", "app", "commands", "init", "index.ts"),
        join(process.cwd(), "src", "app", "commands", "init", "paths.ts"),
        join(process.cwd(), "src", "app", "commands", "init", "types.ts"),
        join(process.cwd(), "src", "app", "commands", "init", "utils.ts"),
      ]),
    );
    expect(oversizedFiles).toEqual([]);
  });

  it("dispatches bshopify app init to the local initializer", async () => {
    const initProject = vi.fn(async () => createEmptyInitResult());
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await createCliProgram({ initProject }).parseAsync([
        "node",
        "bshopify",
        "app",
        "init",
        "--check",
        "--cwd",
        "/tmp/shopify-app",
      ]);
    } finally {
      log.mockRestore();
    }

    expect(initProject).toHaveBeenCalledWith({
      check: true,
      cwd: "/tmp/shopify-app",
    });
  });

  it("dispatches bshopify app clear to the local clearer", async () => {
    const clearProject = vi.fn(async () => ({
      errors: [],
      removed: [],
      updated: [],
      warnings: [],
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await createCliProgram({ clearProject }).parseAsync([
        "node",
        "bshopify",
        "app",
        "clear",
        "--cwd",
        "/tmp/shopify-app",
        "--yes",
      ]);
    } finally {
      log.mockRestore();
    }

    expect(clearProject).toHaveBeenCalledWith({
      cwd: "/tmp/shopify-app",
      yes: true,
    });
  });

  it("dispatches bshopify app deploy to the local deploy runner", async () => {
    const runDeploy = vi.fn(async () => 0);

    await createCliProgram({ runDeploy }).parseAsync([
      "node",
      "bshopify",
      "app",
      "deploy",
      "--cwd",
      "/tmp/shopify-app",
      "--config",
      "test",
      "--dry-run",
      "--yes",
      "--",
      "--source-control-url",
      "https://example.test/commit",
    ]);

    expect(runDeploy).toHaveBeenCalledWith({
      configName: "test",
      confirmProduction: false,
      cwd: "/tmp/shopify-app",
      dryRun: true,
      shopifyArgs: ["--source-control-url", "https://example.test/commit"],
      yes: true,
    });
  });

  it("dispatches bare bshopify app dev to the local dev runner with the default config", async () => {
    const runDev = vi.fn(async () => 0);

    await createCliProgram({ runDev }).parseAsync([
      "node",
      "bshopify",
      "app",
      "dev",
      "--cwd",
      "/tmp/shopify-app",
    ]);

    expect(runDev).toHaveBeenCalledWith({
      configName: "dev",
      cwd: "/tmp/shopify-app",
      shopifyArgs: [],
    });
  });

  it("keeps the default dev config when --reset is passed without --", async () => {
    const runDev = vi.fn(async () => 0);

    await createCliProgram({ runDev }).parseAsync([
      "node",
      "bshopify",
      "app",
      "dev",
      "--cwd",
      "/tmp/shopify-app",
      "--reset",
    ]);

    expect(runDev).toHaveBeenCalledWith({
      configName: "dev",
      cwd: "/tmp/shopify-app",
      shopifyArgs: ["--reset"],
    });
  });

  it("maps -c to the bshopify configFiles key", async () => {
    const runDev = vi.fn(async () => 0);

    await createCliProgram({ runDev }).parseAsync([
      "node",
      "bshopify",
      "app",
      "dev",
      "--cwd",
      "/tmp/shopify-app",
      "-c",
      "test",
      "--reset",
    ]);

    expect(runDev).toHaveBeenCalledWith({
      configName: "test",
      cwd: "/tmp/shopify-app",
      shopifyArgs: ["--reset"],
    });
  });

  it("does not treat --config after -- as a bshopify configFiles key", async () => {
    const runDev = vi.fn(async () => 0);

    await createCliProgram({ runDev }).parseAsync([
      "node",
      "bshopify",
      "app",
      "dev",
      "--cwd",
      "/tmp/shopify-app",
      "--",
      "--config",
      "test",
      "--reset",
    ]);

    expect(runDev).toHaveBeenCalledWith({
      configName: "dev",
      cwd: "/tmp/shopify-app",
      shopifyArgs: ["--config", "test", "--reset"],
    });
  });

  it("dispatches bshopify app dev with a matching Shopify config", async () => {
    const runDev = vi.fn(async () => 0);

    await createCliProgram({ runDev }).parseAsync([
      "node",
      "bshopify",
      "app",
      "dev",
      "--cwd",
      "/tmp/shopify-app",
      "--config",
      "test",
      "--",
      "--reset",
    ]);

    expect(runDev).toHaveBeenCalledWith({
      configName: "test",
      cwd: "/tmp/shopify-app",
      shopifyArgs: ["--reset"],
    });
  });

  it("falls back to the Shopify CLI for commands bshopify does not intercept", async () => {
    const runShopifyCommand = vi.fn(async () => 0);

    await runCli(
      ["node", "bshopify", "theme", "dev", "--store", "example.myshopify.com"],
      { runShopifyCommand },
    );

    expect(runShopifyCommand).toHaveBeenCalledWith([
      "theme",
      "dev",
      "--store",
      "example.myshopify.com",
    ]);
  });

  it("falls back to Shopify help for commands bshopify does not intercept", async () => {
    const runShopifyCommand = vi.fn(async () => 0);

    await runCli(["node", "bshopify", "help", "theme", "dev"], {
      runShopifyCommand,
    });

    expect(runShopifyCommand).toHaveBeenCalledWith(["help", "theme", "dev"]);
  });

  it("keeps the generated pre-commit app guard command local", async () => {
    const runShopifyCommand = vi.fn(async () => 0);

    await runCli(["node", "bshopify", "app", "guard"], { runShopifyCommand });

    expect(runShopifyCommand).not.toHaveBeenCalled();
  });

  it("falls back top-level guard to Shopify because guard is app-scoped", async () => {
    const runShopifyCommand = vi.fn(async () => 0);

    await runCli(["node", "bshopify", "guard"], { runShopifyCommand });

    expect(runShopifyCommand).toHaveBeenCalledWith(["guard"]);
  });

  it("falls back through the user's Shopify CLI installation", async () => {
    const runShopifyCommand = vi.fn(async () => 0);

    await runCli(["node", "bshopify", "theme", "pull"], { runShopifyCommand });

    expect(runShopifyCommand).toHaveBeenCalledWith(["theme", "pull"]);
  });

  it("uses execa local binary preference for Shopify CLI fallback", async () => {
    const runner = vi.fn(async () => ({ exitCode: 0 }));

    await runShopifyCommand(["theme", "pull"], runner);

    expect(runner).toHaveBeenCalledWith("shopify", ["theme", "pull"], {
      localDir: process.cwd(),
      preferLocal: true,
      stdio: "inherit",
    });
  });
});

describe("devProject", () => {
  it("loads ESM extension entries without Node typeless package warnings", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bshopify-entry-warning-"));
    tempDirs.push(cwd);
    const emittedWarnings: EmittedWarning[] = [];
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(
      ((_warning: string | Error, options?: string | NodeJS.EmitWarningOptions) => {
        emittedWarnings.push({
          code: typeof options === "object" ? options.code : undefined,
        });
      }) as typeof process.emitWarning,
    );

    await writeFile(join(cwd, "package.json"), `${JSON.stringify({ name: "fixture" })}\n`);
    await mkdir(join(cwd, "extensions", "theme-extension"), { recursive: true });
    await writeFile(
      join(cwd, "extensions", "theme-extension", "__entry.js"),
      "export default { prepare() { return { injections: [] }; } };\n",
    );

    try {
      const entries = await findManagedEntries(cwd, {
        entryFileName: defaultRunnerConfig.entryFileName,
        extensionsRoot: defaultRunnerConfig.extensionsRoot,
      });

      await loadManagedEntryHooks(entries);
    } finally {
      emitWarning.mockRestore();
    }

    expect(emittedWarnings).not.toContainEqual({
      code: "MODULE_TYPELESS_PACKAGE_JSON",
    });
  });

  it("does not force extension entry relative CommonJS helpers to load as ESM", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bshopify-entry-helper-"));
    tempDirs.push(cwd);

    await writeFile(join(cwd, "package.json"), `${JSON.stringify({ name: "fixture" })}\n`);
    await mkdir(join(cwd, "extensions", "theme-extension"), { recursive: true });
    await writeFile(
      join(cwd, "extensions", "theme-extension", "helper.js"),
      "module.exports = { extensionName: 'theme-extension' };\n",
    );
    await writeFile(
      join(cwd, "extensions", "theme-extension", "__entry.js"),
      [
        'import helper from "./helper.js";',
        "export default {",
        "  prepare() {",
        "    return { extension: helper.extensionName, injections: [] };",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    const entries = await findManagedEntries(cwd, {
      entryFileName: defaultRunnerConfig.entryFileName,
      extensionsRoot: defaultRunnerConfig.extensionsRoot,
    });
    const hooks = await loadManagedEntryHooks(entries);

    expect(hooks).toHaveLength(1);
  });

  it("injects dev app proxy values while Shopify dev runs and restores placeholders afterward", async () => {
    const cwd = await createDevProject();
    const targetPath = join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid");
    const runShopifyCommand = vi.fn(async () => {
      await expect(readFile(targetPath, "utf8")).resolves.toContain(
        "/apps/fixture-dev",
      );
      const current = await readFile(targetPath, "utf8");
      await writeFile(
        targetPath,
        `${current}<p>edited during dev</p>\n`,
      );
      return 0;
    });

    const exitCode = await devProject({ cwd, runShopifyCommand });

    await expect(readFile(targetPath, "utf8")).resolves.toBe(
      '<div data-api-base="__SHOPIFY_APP_PROXY_BASE__"></div>\n<p>edited during dev</p>\n',
    );
    await expect(readFile(join(cwd, ".bshopify", "extension-prepare.lock"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(exitCode).toBe(0);
    expect(runShopifyCommand).toHaveBeenCalledWith(["app", "dev", "--config", "dev"]);
  });

  it("injects values from custom envFiles namespaces into extension templates", async () => {
    const cwd = await createDevProject();
    await mkdir(join(cwd, "config"), { recursive: true });
    await writeFile(
      join(cwd, "config", "a.json"),
      `${JSON.stringify({ gateway: "https://gw.example.test" })}\n`,
    );
    await writeFile(
      join(cwd, "config", "a2.toml"),
      [
        'gateway = "https://gw.override.test"',
        'other = "from-toml"',
        "",
      ].join("\n"),
    );
    await writeFile(
      join(cwd, "config", "b.json"),
      `${JSON.stringify({ flag: true, label: "b" })}\n`,
    );
    await writeFile(
      join(cwd, "bshopify.config.mjs"),
      [
        "export default {",
        "  envFiles: {",
        '    aEnv: ["config/a.json", "config/a2.toml"],',
        '    bEnv: "config/b.json",',
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    const targetPath = join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid");
    await writeFile(
      targetPath,
      '<div data-gateway="__CUSTOM_GATEWAY__" data-flag="__ENV_B_FLAG__" data-other="__AENV_OTHER__"></div>\n',
    );
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
        '          pattern: "__CUSTOM_GATEWAY__",',
        "          value: ctx.aEnv.gateway,",
        "        },",
        "        {",
        '          file: "blocks/app-embed.liquid",',
        '          strategy: "replace",',
        '          pattern: "__ENV_B_FLAG__",',
        "          value: String(ctx.bEnv.flag),",
        "        },",
        "        {",
        '          file: "blocks/app-embed.liquid",',
        '          strategy: "replace",',
        '          pattern: "__AENV_OTHER__",',
        "          value: ctx.aEnv.other,",
        "        },",
        "      ],",
        "    };",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runShopifyCommand = vi.fn(async () => {
      const current = await readFile(targetPath, "utf8");

      expect(current).toContain('data-gateway="https://gw.override.test"');
      expect(current).toContain('data-flag="true"');
      expect(current).toContain('data-other="from-toml"');
      return 0;
    });

    let output = "";

    try {
      await devProject({ cwd, runShopifyCommand });
      output = log.mock.calls.map(([message]) => String(message)).join("\n");
    } finally {
      log.mockRestore();
    }

    expect(output).toContain("\u001B[1m\u001B[36mCustom env files injected\u001B[39m\u001B[22m");
    expect(output).toContain(
      "\u001B[36maEnv\u001B[39m \u001B[90m->\u001B[39m \u001B[35mconfig/a.json\u001B[39m, \u001B[35mconfig/a2.toml\u001B[39m",
    );
    expect(output).toContain(
      "\u001B[36mbEnv\u001B[39m \u001B[90m->\u001B[39m \u001B[35mconfig/b.json\u001B[39m",
    );

    await expect(readFile(targetPath, "utf8")).resolves.toBe(
      '<div data-gateway="__CUSTOM_GATEWAY__" data-flag="__ENV_B_FLAG__" data-other="__AENV_OTHER__"></div>\n',
    );
  });

  it("rejects invalid envFiles keys in the runner config", async () => {
    const cwd = await createDevProject();
    await writeFile(
      join(cwd, "bshopify.config.mjs"),
      [
        "export default {",
        '  envFiles: { "bad-key": "config/a.json" },',
        "};",
        "",
      ].join("\n"),
    );

    await expect(
      devProject({ cwd, runShopifyCommand: vi.fn(async () => 0) }),
    ).rejects.toThrow(
      'bshopify envFiles key "bad-key" must be a valid JavaScript identifier.',
    );
  });

  it("warns and keeps dev running with an empty namespace when an envFiles path is missing", async () => {
    const cwd = await createDevProject();
    await writeFile(
      join(cwd, "bshopify.config.mjs"),
      [
        "export default {",
        '  envFiles: { aEnv: "config/missing.json" },',
        "};",
        "",
      ].join("\n"),
    );
    const targetPath = join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid");
    await writeFile(targetPath, '<div data-size="__AENV_SIZE__"></div>\n');
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
        '          pattern: "__AENV_SIZE__",',
        "          value: String(Object.keys(ctx.aEnv).length),",
        "        },",
        "      ],",
        "    };",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runShopifyCommand = vi.fn(async () => {
      const current = await readFile(targetPath, "utf8");

      expect(current).toContain('data-size="0"');
      return 0;
    });
    let warningOutput = "";
    let logOutput = "";

    try {
      await devProject({ cwd, runShopifyCommand });
      warningOutput = warn.mock.calls.map(([message]) => String(message)).join("\n");
      logOutput = log.mock.calls.map(([message]) => String(message)).join("\n");
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }

    expect(warningOutput).toContain(
      "bshopify envFiles.aEnv config/missing.json does not exist; skipped.",
    );
    expect(logOutput).toContain(
      "\u001B[36maEnv\u001B[39m \u001B[90m->\u001B[39m \u001B[90m(none)\u001B[39m",
    );
    await expect(readFile(targetPath, "utf8")).resolves.toBe(
      '<div data-size="__AENV_SIZE__"></div>\n',
    );
  });

  it("merges surviving files and warns when one envFiles path is missing", async () => {
    const cwd = await createDevProject();
    await mkdir(join(cwd, "config"), { recursive: true });
    await writeFile(join(cwd, "config", "a.json"), `${JSON.stringify({ gateway: "kept" })}\n`);
    await writeFile(
      join(cwd, "bshopify.config.mjs"),
      [
        "export default {",
        '  envFiles: { aEnv: ["config/a.json", "config/missing.toml"] },',
        "};",
        "",
      ].join("\n"),
    );
    const targetPath = join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid");
    await writeFile(targetPath, '<div data-gateway="__AENV_GATEWAY__"></div>\n');
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
        '          pattern: "__AENV_GATEWAY__",',
        "          value: ctx.aEnv.gateway,",
        "        },",
        "      ],",
        "    };",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runShopifyCommand = vi.fn(async () => {
      await expect(readFile(targetPath, "utf8")).resolves.toContain('data-gateway="kept"');
      return 0;
    });
    let warningOutput = "";

    try {
      await devProject({ cwd, runShopifyCommand });
      warningOutput = warn.mock.calls.map(([message]) => String(message)).join("\n");
    } finally {
      warn.mockRestore();
    }

    expect(warningOutput).toContain(
      "bshopify envFiles.aEnv config/missing.toml does not exist; skipped.",
    );
    await expect(readFile(targetPath, "utf8")).resolves.toBe(
      '<div data-gateway="__AENV_GATEWAY__"></div>\n',
    );
  });

  it("warns and treats envFiles as empty when it is not an object", async () => {
    const cwd = await createDevProject();
    await writeFile(
      join(cwd, "bshopify.config.mjs"),
      'export default { envFiles: "config/a.json" };\n',
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runShopifyCommand = vi.fn(async () => 0);
    let warningOutput = "";

    try {
      await devProject({ cwd, runShopifyCommand });
      warningOutput = warn.mock.calls.map(([message]) => String(message)).join("\n");
    } finally {
      warn.mockRestore();
    }

    expect(warningOutput).toContain(
      "bshopify envFiles must be an object; treated as empty.",
    );
    expect(runShopifyCommand).toHaveBeenCalledWith(["app", "dev", "--config", "dev"]);
  });

  it("loads envFiles JSON files that start with a BOM", async () => {
    const cwd = await createDevProject();
    await mkdir(join(cwd, "config"), { recursive: true });
    await writeFile(join(cwd, "config", "a.json"), `\uFEFF${JSON.stringify({ gateway: "bom" })}\n`);
    await writeFile(
      join(cwd, "bshopify.config.mjs"),
      'export default { envFiles: { aEnv: "config/a.json" } };\n',
    );
    const targetPath = join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid");
    await writeFile(targetPath, '<div data-gateway="__AENV_GATEWAY__"></div>\n');
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
        '          pattern: "__AENV_GATEWAY__",',
        "          value: ctx.aEnv.gateway,",
        "        },",
        "      ],",
        "    };",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    const runShopifyCommand = vi.fn(async () => {
      await expect(readFile(targetPath, "utf8")).resolves.toContain('data-gateway="bom"');
      return 0;
    });

    await devProject({ cwd, runShopifyCommand });
  });

  it("rejects envFiles files whose content is not an object", async () => {
    const cwd = await createDevProject();
    await mkdir(join(cwd, "config"), { recursive: true });
    await writeFile(join(cwd, "config", "a.json"), '[1, 2, 3]\n');
    await writeFile(
      join(cwd, "bshopify.config.mjs"),
      'export default { envFiles: { aEnv: "config/a.json" } };\n',
    );

    await expect(
      devProject({ cwd, runShopifyCommand: vi.fn(async () => 0) }),
    ).rejects.toThrow("bshopify envFiles.aEnv config/a.json must be a JSON/TOML object.");
  });

  it("rejects envFiles files with unsupported extensions", async () => {
    const cwd = await createDevProject();
    await mkdir(join(cwd, "config"), { recursive: true });
    await writeFile(join(cwd, "config", "a.yaml"), "gateway: yaml\n");
    await writeFile(
      join(cwd, "bshopify.config.mjs"),
      'export default { envFiles: { aEnv: "config/a.yaml" } };\n',
    );

    await expect(
      devProject({ cwd, runShopifyCommand: vi.fn(async () => 0) }),
    ).rejects.toThrow("bshopify envFiles config/a.yaml must be a .json or .toml file.");
  });

  it("rejects envFiles keys reserved by the runner context", async () => {
    const cwd = await createDevProject();
    await writeFile(
      join(cwd, "bshopify.config.mjs"),
      'export default { envFiles: { appConfig: "config/a.json" } };\n',
    );

    await expect(
      devProject({ cwd, runShopifyCommand: vi.fn(async () => 0) }),
    ).rejects.toThrow('bshopify envFiles key "appConfig" is reserved.');
  });

  it("does not print the envFiles hint when envFiles is not configured", async () => {
    const cwd = await createDevProject();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runShopifyCommand = vi.fn(async () => 0);
    let output = "";

    try {
      await devProject({ cwd, runShopifyCommand });
      output = log.mock.calls.map(([message]) => String(message)).join("\n");
    } finally {
      log.mockRestore();
    }

    expect(output).not.toContain("Custom env files injected");
  });

  it("uses the selected config for app dev context and Shopify CLI", async () => {
    const cwd = await createDevProject();
    await writeFile(
      join(cwd, "shopify.app.test.toml"),
      [
        'name = "fixture"',
        "",
        "[app_proxy]",
        'prefix = "apps"',
        'subpath = "fixture-test"',
        'url = "https://example.test/proxy"',
        "",
      ].join("\n"),
    );
    const targetPath = join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid");
    const runShopifyCommand = vi.fn(async () => {
      await expect(readFile(targetPath, "utf8")).resolves.toContain(
        "/apps/fixture-test",
      );
      return 0;
    });

    await devProject({ configName: "test", cwd, runShopifyCommand });

    expect(runShopifyCommand).toHaveBeenCalledWith(["app", "dev", "--config", "test"]);
  });

  it("uses the configured config file name for app dev context and Shopify CLI", async () => {
    const cwd = await createDevProject();
    await writeFile(
      join(cwd, "bshopify.config.mjs"),
      [
        "export default {",
        "  configFiles: {",
        '    dev: "shopify.app.preview.toml",',
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(cwd, "shopify.app.preview.toml"),
      [
        'name = "fixture"',
        'client_id = "client-id"',
        "",
        "[app_proxy]",
        'prefix = "apps"',
        'subpath = "fixture-preview"',
        'url = "https://example.test/proxy"',
        "",
      ].join("\n"),
    );
    const targetPath = join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid");
    const runShopifyCommand = vi.fn(async () => {
      await expect(readFile(targetPath, "utf8")).resolves.toContain(
        "/apps/fixture-preview",
      );
      return 0;
    });

    await devProject({ cwd, runShopifyCommand });

    expect(runShopifyCommand).toHaveBeenCalledWith(["app", "dev", "--config", "preview"]);
  });

  it("rejects configured dev config files outside the app root", async () => {
    const cwd = await createDevProject();
    await mkdir(join(cwd, "configs"), { recursive: true });
    await writeFile(
      join(cwd, "bshopify.config.mjs"),
      [
        "export default {",
        "  configFiles: {",
        '    dev: "configs/shopify.app.preview.toml",',
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    await expect(devProject({ cwd })).rejects.toThrow(
      "bshopify configFiles.dev must be a root-level Shopify app config file",
    );
  });

  it("forwards the default app config file to Shopify CLI", async () => {
    const cwd = await createDevProject();
    await writeFile(
      join(cwd, "bshopify.config.mjs"),
      [
        "export default {",
        "  configFiles: {",
        '    dev: "shopify.app.toml",',
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(cwd, "shopify.app.toml"),
      [
        'name = "fixture"',
        'client_id = "client-id"',
        "",
        "[app_proxy]",
        'prefix = "apps"',
        'subpath = "fixture-default"',
        'url = "https://example.test/proxy"',
        "",
      ].join("\n"),
    );
    const targetPath = join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid");
    const runShopifyCommand = vi.fn(async () => {
      await expect(readFile(targetPath, "utf8")).resolves.toContain(
        "/apps/fixture-default",
      );
      return 0;
    });

    await devProject({ cwd, runShopifyCommand });

    expect(runShopifyCommand).toHaveBeenCalledWith([
      "app",
      "dev",
      "--config",
      "shopify.app.toml",
    ]);
  });

  it("forwards the default CLI config when passing Shopify args such as --reset", async () => {
    const cwd = await createDevProject();
    const runShopifyCommand = vi.fn(async () => 0);

    await devProject({ cwd, runShopifyCommand, shopifyArgs: ["--reset"] });

    expect(runShopifyCommand).toHaveBeenCalledWith(["app", "dev", "--config", "dev", "--reset"]);
  });

  it("forwards the selected config together with extra Shopify args", async () => {
    const cwd = await createDevProject();
    await writeFile(
      join(cwd, "shopify.app.test.toml"),
      [
        'name = "fixture"',
        'client_id = "client-id"',
        "",
        "[app_proxy]",
        'prefix = "apps"',
        'subpath = "fixture-test"',
        'url = "https://example.test/proxy"',
        "",
      ].join("\n"),
    );
    const runShopifyCommand = vi.fn(async () => 0);

    await devProject({
      configName: "test",
      cwd,
      runShopifyCommand,
      shopifyArgs: ["--reset"],
    });

    expect(runShopifyCommand).toHaveBeenCalledWith(["app", "dev", "--config", "test", "--reset"]);
  });

  it("ignores --config in extra Shopify args and keeps the selected config", async () => {
    const cwd = await createDevProject();
    const runShopifyCommand = vi.fn(async () => 0);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await devProject({
        cwd,
        runShopifyCommand,
        shopifyArgs: ["--config", "test", "--reset"],
      });
      expect(runShopifyCommand).toHaveBeenCalledWith(["app", "dev", "--config", "dev", "--reset"]);
      expect(warn.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
        "Ignored --config / -c in extra Shopify args",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("forwards shopify.app.toml when it is the configured dev file and extra args are present", async () => {
    const cwd = await createDevProject();
    await writeFile(
      join(cwd, "bshopify.config.mjs"),
      [
        "export default {",
        "  configFiles: {",
        '    dev: "shopify.app.toml",',
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(cwd, "shopify.app.toml"),
      [
        'name = "fixture"',
        'client_id = "client-id"',
        "",
        "[app_proxy]",
        'prefix = "apps"',
        'subpath = "fixture-default"',
        'url = "https://example.test/proxy"',
        "",
      ].join("\n"),
    );
    const runShopifyCommand = vi.fn(async () => 0);

    await devProject({ cwd, runShopifyCommand, shopifyArgs: ["--reset"] });

    expect(runShopifyCommand).toHaveBeenCalledWith([
      "app",
      "dev",
      "--config",
      "shopify.app.toml",
      "--reset",
    ]);
  });

  it("prints the dev placeholder injection details with color", async () => {
    const cwd = await createDevProject();
    const targetPath = join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid");
    await writeFile(
      targetPath,
      [
        '<div data-api-base="__SHOPIFY_APP_PROXY_BASE__">',
        '  <span data-env="__SHOPIFY_CONFIG_NAME__"></span>',
        "</div>",
        "",
      ].join("\n"),
    );
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
        "        {",
        '          file: "blocks/app-embed.liquid",',
        '          strategy: "replace",',
        '          pattern: "__SHOPIFY_CONFIG_NAME__",',
        "          value: ctx.env,",
        "        },",
        "      ],",
        "    };",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runShopifyCommand = vi.fn(async () => 0);
    let output = "";

    try {
      await devProject({ cwd, runShopifyCommand });
      output = log.mock.calls.map(([message]) => String(message)).join("\n");
    } finally {
      log.mockRestore();
    }

    expect(output).toContain("\u001B[1m\u001B[36mDev extension injections\u001B[39m\u001B[22m");
    expect(output).toContain(
      "\u001B[90mReason:\u001B[39m temporary values for shopify app dev --config dev; restored when dev exits.",
    );
    expect(output).toContain(
      [
        "\u001B[90mReason:\u001B[39m temporary values for shopify app dev --config dev; restored when dev exits.",
        "",
        "\u001B[36mextensions/theme-extension/blocks/app-embed.liquid\u001B[39m:",
        "    \u001B[33m__SHOPIFY_APP_PROXY_BASE__\u001B[39m \u001B[90m->\u001B[39m \u001B[35m/apps/fixture-dev\u001B[39m",
        "    \u001B[33m__SHOPIFY_CONFIG_NAME__\u001B[39m \u001B[90m->\u001B[39m \u001B[35mdev\u001B[39m",
      ].join("\n"),
    );
    expect(output.endsWith("\n")).toBe(true);
  });

  it("prints a restore notice with surrounding blank lines when dev exits", async () => {
    const cwd = await createDevProject();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runShopifyCommand = vi.fn(async () => 0);
    let restoreOutput = "";

    try {
      await devProject({ cwd, runShopifyCommand });
      restoreOutput = String(log.mock.calls.at(-1)?.[0] ?? "");
    } finally {
      log.mockRestore();
    }

    expect(restoreOutput).toBe(
      "\n\u001B[1m\u001B[36mDev extension files restored.\u001B[39m\u001B[22m\n",
    );
  });

  it("cleans a stale dev lock before preparing extensions", async () => {
    const cwd = await createDevProject();
    await mkdir(join(cwd, ".bshopify"), { recursive: true });
    await writeFile(join(cwd, ".bshopify", "extension-prepare.lock"), "999999999\n");
    const runShopifyCommand = vi.fn(async () => 0);

    await devProject({ cwd, runShopifyCommand });

    expect(runShopifyCommand).toHaveBeenCalledWith(["app", "dev", "--config", "dev"]);
    await expect(readFile(join(cwd, ".bshopify", "extension-prepare.lock"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("restores a stale dev transaction before preparing extensions", async () => {
    const cwd = await createDevProject();
    const targetPath = join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid");
    const marker = "{% comment %} bshopify-restore:stale {% endcomment %}";
    const transactionPath = join(cwd, ".bshopify", "extension-prepare.transaction.json");
    await mkdir(join(cwd, ".bshopify"), { recursive: true });
    await writeFile(join(cwd, ".bshopify", "extension-prepare.lock"), "999999999\n");
    await writeFile(
      targetPath,
      `<div data-api-base="/apps/fixture-dev${marker}"></div>\n`,
    );
    await writeFile(
      transactionPath,
      `${JSON.stringify({
        files: [
          {
            path: targetPath,
            replacements: [
              {
                marker,
                pattern: "__SHOPIFY_APP_PROXY_BASE__",
                value: "/apps/fixture-dev",
              },
            ],
          },
        ],
      })}\n`,
    );
    const runShopifyCommand = vi.fn(async () => {
      await expect(readFile(targetPath, "utf8")).resolves.toContain(
        "/apps/fixture-dev",
      );
      return 0;
    });

    await devProject({ cwd, runShopifyCommand });

    await expect(readFile(targetPath, "utf8")).resolves.toBe(
      '<div data-api-base="__SHOPIFY_APP_PROXY_BASE__"></div>\n',
    );
    await expect(readFile(transactionPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("releases the dev lock when stale transaction recovery fails", async () => {
    const cwd = await createDevProject();
    const lockPath = join(cwd, ".bshopify", "extension-prepare.lock");
    await mkdir(join(cwd, ".bshopify"), { recursive: true });
    await writeFile(lockPath, "999999999\n");
    await writeFile(join(cwd, ".bshopify", "extension-prepare.transaction.json"), "{\n");

    await expect(devProject({ cwd, runShopifyCommand: vi.fn(async () => 0) })).rejects.toThrow();

    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("restores only marker-wrapped injected values and keeps matching user edits", async () => {
    const cwd = await createDevProject();
    const targetPath = join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid");
    const runShopifyCommand = vi.fn(async () => {
      const current = await readFile(targetPath, "utf8");
      await writeFile(
        targetPath,
        [
          current.trimEnd(),
          '<p data-copy="/apps/fixture-dev">edited during dev</p>',
          "",
        ].join("\n"),
      );
      return 0;
    });

    await devProject({ cwd, runShopifyCommand });

    await expect(readFile(targetPath, "utf8")).resolves.toBe(
      [
        '<div data-api-base="__SHOPIFY_APP_PROXY_BASE__"></div>',
        '<p data-copy="/apps/fixture-dev">edited during dev</p>',
        "",
      ].join("\n"),
    );
  });

  it("uses restore markers that match the target file type", async () => {
    const cwd = await createDevProject();
    const extensionRoot = join(cwd, "extensions", "theme-extension");
    const cases = [
      {
        file: "blocks/app-embed.liquid",
        markerPattern: "{% comment %} bshopify-restore:",
      },
      {
        file: "blocks/app-block.html",
        markerPattern: "<!-- bshopify-restore:",
      },
      {
        file: "assets/app.js",
        markerPattern: "/* bshopify-restore:",
      },
      {
        file: "assets/app.jsx",
        markerPattern: "{/* bshopify-restore:",
      },
      {
        file: "assets/app.tsx",
        markerPattern: "{/* bshopify-restore:",
      },
      {
        file: "assets/app.css",
        markerPattern: "/* bshopify-restore:",
      },
    ];
    await mkdir(join(extensionRoot, "assets"), { recursive: true });
    await writeFile(
      join(extensionRoot, "__entry.js"),
      [
        "export default {",
        "  async prepare(ctx) {",
        "    return {",
        "      injections: [",
        ...cases.map(
          ({ file }) =>
            `        { file: ${JSON.stringify(file)}, strategy: "replace", pattern: "__SHOPIFY_APP_PROXY_BASE__", value: ctx.appConfig.app_proxy ? \`/\${ctx.appConfig.app_proxy.prefix}/\${ctx.appConfig.app_proxy.subpath}\` : undefined },`,
        ),
        "      ],",
        "    };",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    for (const { file } of cases) {
      await mkdir(join(extensionRoot, file, ".."), { recursive: true });
      await writeFile(join(extensionRoot, file), "__SHOPIFY_APP_PROXY_BASE__\n");
    }

    const runShopifyCommand = vi.fn(async () => {
      for (const { file, markerPattern } of cases) {
        await expect(readFile(join(extensionRoot, file), "utf8")).resolves.toContain(
          markerPattern,
        );
      }
      return 0;
    });

    await devProject({ cwd, runShopifyCommand });

    for (const { file } of cases) {
      await expect(readFile(join(extensionRoot, file), "utf8")).resolves.toBe(
        "__SHOPIFY_APP_PROXY_BASE__\n",
      );
    }
  });

  it("can disable restore markers from runner config", async () => {
    const cwd = await createDevProject();
    const targetPath = join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid");
    await writeFile(
      join(cwd, "bshopify.config.mjs"),
      "export default { restoreMarkers: false };\n",
    );
    const runShopifyCommand = vi.fn(async () => {
      const current = await readFile(targetPath, "utf8");

      expect(current).toContain('/apps/fixture-dev');
      expect(current).not.toContain("bshopify-restore:");
      return 0;
    });

    await devProject({ cwd, runShopifyCommand });

    await expect(readFile(targetPath, "utf8")).resolves.toBe(
      '<div data-api-base="__SHOPIFY_APP_PROXY_BASE__"></div>\n',
    );
  });

  it("warns and keeps dev running when an injection pattern matches nothing", async () => {
    const cwd = await createDevProject();
    const extensionRoot = join(cwd, "extensions", "theme-extension");
    const unmatchedPath = join(extensionRoot, "assets", "productBlock.tsx");
    await mkdir(join(extensionRoot, "assets"), { recursive: true });
    await writeFile(
      unmatchedPath,
      'export function ProductBlock() { return <div data-api-base="https://example.test/proxy"></div>; }\n',
    );
    await writeFile(
      join(extensionRoot, "__entry.js"),
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
        "        {",
        '          file: "assets/productBlock.tsx",',
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
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runShopifyCommand = vi.fn(async () => 0);
    let warningOutput = "";

    try {
      await devProject({ cwd, runShopifyCommand });
      warningOutput = warn.mock.calls.map(([message]) => String(message)).join("\n");
    } finally {
      warn.mockRestore();
    }

    expect(runShopifyCommand).toHaveBeenCalledWith(["app", "dev", "--config", "dev"]);
    await expect(readFile(unmatchedPath, "utf8")).resolves.toBe(
      'export function ProductBlock() { return <div data-api-base="https://example.test/proxy"></div>; }\n',
    );
    expect(warningOutput).toContain("\u001B[1m\u001B[33mExtension injection warnings\u001B[39m\u001B[22m");
    expect(warningOutput).toContain(
      'extensions/theme-extension/assets/productBlock.tsx: expected exactly one "__SHOPIFY_APP_PROXY_BASE__" match, got 0; skipped.',
    );
  });

  it("warns and keeps dev running when an injection pattern matches multiple times", async () => {
    const cwd = await createDevProject();
    const extensionRoot = join(cwd, "extensions", "theme-extension");
    const repeatedPath = join(extensionRoot, "assets", "app.js");
    await mkdir(join(extensionRoot, "assets"), { recursive: true });
    await writeFile(
      repeatedPath,
      [
        'const a = "__SHOPIFY_APP_PROXY_BASE__";',
        'const b = "__SHOPIFY_APP_PROXY_BASE__";',
        "",
      ].join("\n"),
    );
    await writeFile(
      join(extensionRoot, "__entry.js"),
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
        "        {",
        '          file: "assets/app.js",',
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
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runShopifyCommand = vi.fn(async () => 0);
    let warningOutput = "";

    try {
      await devProject({ cwd, runShopifyCommand });
      warningOutput = warn.mock.calls.map(([message]) => String(message)).join("\n");
    } finally {
      warn.mockRestore();
    }

    expect(runShopifyCommand).toHaveBeenCalledWith(["app", "dev", "--config", "dev"]);
    await expect(readFile(repeatedPath, "utf8")).resolves.toBe(
      [
        'const a = "__SHOPIFY_APP_PROXY_BASE__";',
        'const b = "__SHOPIFY_APP_PROXY_BASE__";',
        "",
      ].join("\n"),
    );
    expect(warningOutput).toContain(
      'extensions/theme-extension/assets/app.js: expected exactly one "__SHOPIFY_APP_PROXY_BASE__" match, got 2; skipped.',
    );
  });

  it("fails before Shopify dev when Liquid placeholders remain unresolved", async () => {
    const cwd = await createDevProject();
    const targetPath = join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid");
    await writeFile(
      targetPath,
      [
        '<div data-api-base="__SHOPIFY_APP_PROXY_BASE__">',
        '  <span data-value="__UNRESOLVED_PLACEHOLDER__"></span>',
        "</div>",
        "",
      ].join("\n"),
    );
    const runShopifyCommand = vi.fn(async () => 0);

    await expect(devProject({ cwd, runShopifyCommand })).rejects.toThrow(
      "Unresolved deploy placeholders found after extension entry injection.",
    );

    await expect(readFile(targetPath, "utf8")).resolves.toContain(
      "__SHOPIFY_APP_PROXY_BASE__",
    );
    expect(runShopifyCommand).not.toHaveBeenCalled();
  });

  it("skips placeholder entries during dev without loading or restoring them", async () => {
    const cwd = await createDevProject();
    await writeFile(
      join(cwd, "extensions", "theme-extension", "__entry.js"),
      managedEntryTemplate,
    );
    await writeFile(
      join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid"),
      "<div></div>\n",
    );
    const runShopifyCommand = vi.fn(async () => 0);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let output = "";

    try {
      const exitCode = await devProject({ cwd, runShopifyCommand });
      output = log.mock.calls.map(([message]) => String(message)).join("\n");
      expect(exitCode).toBe(0);
    } finally {
      log.mockRestore();
    }

    expect(runShopifyCommand).toHaveBeenCalledWith(["app", "dev", "--config", "dev"]);
    expect(output).toContain("Skipped 1 placeholder extension entr");
    expect(output).not.toContain("Dev extension files restored.");
  });
});

describe("deployProject", () => {
  it("deploys configs that pass Shopify basic fields without app proxy", async () => {
    const cwd = await createDevProject();
    await writeFile(
      join(cwd, "shopify.app.test.toml"),
      [
        ...createShopifyBasicConfig("https://test.example.com"),
        "",
      ].join("\n"),
    );
    await writeFile(
      join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid"),
      "<div></div>\n",
    );
    await writeFile(
      join(cwd, "extensions", "theme-extension", "__entry.js"),
      "export default { async prepare() { return { injections: [] }; } };\n",
    );
    const runShopifyCommand = vi.fn(async () => 0);

    const exitCode = await deployProject({
      configName: "test",
      cwd,
      runShopifyCommand,
      yes: true,
    });

    expect(exitCode).toBe(0);
    expect(runShopifyCommand).toHaveBeenCalledWith(["app", "deploy", "--config", "test"]);
  });

  it("uses the configured config file name for app deploy context and Shopify CLI", async () => {
    const cwd = await createDevProject();
    await writeFile(
      join(cwd, "bshopify.config.mjs"),
      [
        "export default {",
        "  configFiles: {",
        '    test: "shopify.app.preview.toml",',
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(cwd, "shopify.app.preview.toml"),
      [
        ...createShopifyBasicConfig("https://preview.example.com"),
        "",
      ].join("\n"),
    );
    await writeFile(
      join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid"),
      "<div></div>\n",
    );
    await writeFile(
      join(cwd, "extensions", "theme-extension", "__entry.js"),
      "export default { async prepare() { return { injections: [] }; } };\n",
    );
    const runShopifyCommand = vi.fn(async () => 0);

    const exitCode = await deployProject({
      configName: "test",
      cwd,
      runShopifyCommand,
      yes: true,
    });

    expect(exitCode).toBe(0);
    expect(runShopifyCommand).toHaveBeenCalledWith(["app", "deploy", "--config", "preview"]);
  });

  it("uses the selected production config key for deploy confirmation regardless of file suffix", async () => {
    const cwd = await createDevProject();
    await writeFile(
      join(cwd, "bshopify.config.mjs"),
      [
        "export default {",
        "  configFiles: {",
        '    production: "shopify.app.prod.toml",',
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(cwd, "shopify.app.prod.toml"),
      [
        ...createShopifyBasicConfig("https://production.example.com"),
        "",
      ].join("\n"),
    );
    const runShopifyCommand = vi.fn(async () => 0);

    await expect(
      deployProject({
        configName: "production",
        cwd,
        runShopifyCommand,
        yes: true,
      }),
    ).rejects.toThrow("Production deploy requires --confirm-production.");
    expect(runShopifyCommand).not.toHaveBeenCalled();
  });

  it("falls back to the config picker when the requested deploy config key is not configured", async () => {
    const prompts = await import("@inquirer/prompts");
    const cwd = await createDevProject();
    await writeFile(
      join(cwd, "shopify.app.test.toml"),
      [
        ...createShopifyBasicConfig("https://test.example.com"),
        "",
      ].join("\n"),
    );
    await writeFile(
      join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid"),
      "<div></div>\n",
    );
    await writeFile(
      join(cwd, "extensions", "theme-extension", "__entry.js"),
      "export default { async prepare() { return { injections: [] }; } };\n",
    );
    vi.mocked(prompts.select).mockResolvedValueOnce("test");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runShopifyCommand = vi.fn(async () => 0);

    let exitCode = 1;
    try {
      exitCode = await deployProject({
        configName: "prod",
        cwd,
        runShopifyCommand,
        yes: true,
      });
      expect(warn).toHaveBeenCalledWith(
        "bshopify configFiles.prod is not configured. Select a deploy config to continue.\n",
      );
    } finally {
      warn.mockRestore();
    }

    expect(exitCode).toBe(0);
    expect(prompts.select).toHaveBeenCalled();
    expect(runShopifyCommand).toHaveBeenCalledWith(["app", "deploy", "--config", "test"]);
  });

  it("rejects configured deploy config files outside the app root", async () => {
    const cwd = await createDevProject();
    await mkdir(join(cwd, "configs"), { recursive: true });
    await writeFile(
      join(cwd, "bshopify.config.mjs"),
      [
        "export default {",
        "  configFiles: {",
        '    test: "configs/shopify.app.preview.toml",',
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    await expect(
      deployProject({
        configName: "test",
        cwd,
        yes: true,
      }),
    ).rejects.toThrow("bshopify configFiles.test must be a root-level Shopify app config file");
  });

  it("forwards the default app deploy config file to Shopify CLI", async () => {
    const cwd = await createDevProject();
    await writeFile(
      join(cwd, "bshopify.config.mjs"),
      [
        "export default {",
        "  configFiles: {",
        '    test: "shopify.app.toml",',
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(cwd, "shopify.app.toml"),
      [
        ...createShopifyBasicConfig("https://default.example.com"),
        "",
      ].join("\n"),
    );
    await writeFile(
      join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid"),
      "<div></div>\n",
    );
    await writeFile(
      join(cwd, "extensions", "theme-extension", "__entry.js"),
      "export default { async prepare() { return { injections: [] }; } };\n",
    );
    const runShopifyCommand = vi.fn(async () => 0);

    const exitCode = await deployProject({
      configName: "test",
      cwd,
      runShopifyCommand,
      yes: true,
    });

    expect(exitCode).toBe(0);
    expect(runShopifyCommand).toHaveBeenCalledWith([
      "app",
      "deploy",
      "--config",
      "shopify.app.toml",
    ]);
  });

  it("requires Shopify basic fields for deploy configs", async () => {
    const cwd = await createDevProject();
    await writeFile(
      join(cwd, "shopify.app.test.toml"),
      [
        'client_id = "client-id"',
        'name = "fixture"',
        "",
      ].join("\n"),
    );
    const runShopifyCommand = vi.fn(async () => 0);

    await expect(
      deployProject({
        configName: "test",
        cwd,
        runShopifyCommand,
        yes: true,
      }),
    ).rejects.toThrow("shopify.app.test.toml application_url is required.");
    expect(runShopifyCommand).not.toHaveBeenCalled();
  });

  it("omits imported production config values from the deploy summary", async () => {
    const cwd = await createDevProject();
    await writeFile(
      join(cwd, "shopify.app.production.toml"),
      [
        ...createShopifyBasicConfig("https://production.example.com"),
        "",
        "[webhooks]",
        'api_version = "2026-01"',
        "",
        "[[webhooks.subscriptions]]",
        'topics = ["orders/create", "orders/updated"]',
        'uri = "/webhooks/orders"',
        "",
      ].join("\n"),
    );
    await writeFile(
      join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid"),
      "<div></div>\n",
    );
    await writeFile(
      join(cwd, "extensions", "theme-extension", "__entry.js"),
      "export default { async prepare() { return { injections: [] }; } };\n",
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let output = "";

    try {
      await deployProject({
        configName: "production",
        cwd,
        dryRun: true,
        yes: true,
      });
      output = log.mock.calls.map(([message]) => String(message)).join("\n");
    } finally {
      log.mockRestore();
    }

    expect(output).toContain("DEPLOY DRY-RUN SUMMARY");
    expect(output).toContain("Application URL");
    expect(output).toContain("https://production.example.com");
    expect(output).not.toContain("PRODUCTION CONFIG REVIEW REQUIRED");
    expect(output).not.toContain("application_url");
    expect(output).not.toContain("webhooks.api_version");
    expect(output).not.toContain("webhooks.subscriptions[0].topics");
    expect(output).not.toContain("orders/create, orders/updated");
  });

  it("injects deploy values while Shopify deploy runs and restores afterward", async () => {
    const cwd = await createDevProject();
    await writeFile(
      join(cwd, "shopify.app.test.toml"),
      [
        ...createShopifyBasicConfig("https://test.example.com"),
        "",
        "[app_proxy]",
        'prefix = "apps"',
        'subpath = "fixture-test"',
        'url = "https://example.test/proxy"',
        "",
      ].join("\n"),
    );
    const targetPath = join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid");
    const entryPath = join(cwd, "extensions", "theme-extension", "__entry.js");
    const runShopifyCommand = vi.fn(async () => {
      await expect(readFile(targetPath, "utf8")).resolves.toContain(
        "/apps/fixture-test",
      );
      await expect(readFile(targetPath, "utf8")).resolves.not.toContain("bshopify-restore:");
      // entry files stay in place during deploy; Shopify ignores extra files
      await expect(stat(entryPath)).resolves.toBeDefined();
      return 0;
    });

    const exitCode = await deployProject({
      configName: "test",
      cwd,
      runShopifyCommand,
      yes: true,
    });

    await expect(readFile(targetPath, "utf8")).resolves.toBe(
      '<div data-api-base="__SHOPIFY_APP_PROXY_BASE__"></div>\n',
    );
    await expect(readFile(entryPath, "utf8")).resolves.toContain("async prepare(ctx)");
    await expect(readFile(join(cwd, ".bshopify", "extension-prepare.lock"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(exitCode).toBe(0);
    expect(runShopifyCommand).toHaveBeenCalledWith(["app", "deploy", "--config", "test"]);
  });

  it("restores deploy injections without rewriting unrelated substrings of the value", async () => {
    const cwd = await createDevProject();
    await writeFile(
      join(cwd, "shopify.app.test.toml"),
      [
        ...createShopifyBasicConfig("https://test.example.com"),
        "",
        "[app_proxy]",
        'prefix = "apps"',
        'subpath = "fixture-test"',
        'url = "https://example.test/proxy"',
        "",
      ].join("\n"),
    );
    const extensionRoot = join(cwd, "extensions", "cart-drawer-discount");
    const tomlPath = join(extensionRoot, "shopify.extension.toml");
    const source = [
      'handle = "__CART_DRAWER_HANDLE__"',
      'path = "target/wasm32-unknown-unknown/release/bestupsell-cart-drawer-discount.wasm"',
      "",
    ].join("\n");
    await mkdir(extensionRoot, { recursive: true });
    await writeFile(tomlPath, source);
    await writeFile(
      join(extensionRoot, "__entry.js"),
      [
        "export default {",
        "  async prepare() {",
        "    return {",
        "      injections: [",
        "        {",
        '          file: "shopify.extension.toml",',
        '          strategy: "replace",',
        '          pattern: "__CART_DRAWER_HANDLE__",',
        '          value: "upsell-cart-drawer-discount",',
        "        },",
        "      ],",
        "    };",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    const runShopifyCommand = vi.fn(async () => {
      const current = await readFile(tomlPath, "utf8");
      expect(current).toContain('handle = "upsell-cart-drawer-discount"');
      expect(current).toContain("bestupsell-cart-drawer-discount.wasm");
      expect(current).not.toContain("bshopify-restore:");
      return 0;
    });

    const exitCode = await deployProject({
      configName: "test",
      cwd,
      runShopifyCommand,
      yes: true,
    });

    await expect(readFile(tomlPath, "utf8")).resolves.toBe(source);
    expect(exitCode).toBe(0);
  });

  it("injects custom envFiles values during deploy dry-runs", async () => {
    const cwd = await createDevProject();
    await writeFile(
      join(cwd, "shopify.app.test.toml"),
      [...createShopifyBasicConfig("https://test.example.com"), ""].join("\n"),
    );
    await mkdir(join(cwd, "config"), { recursive: true });
    await writeFile(join(cwd, "config", "a.json"), `${JSON.stringify({ gateway: "deploy-gw" })}\n`);
    await writeFile(
      join(cwd, "bshopify.config.mjs"),
      [
        "export default {",
        '  envFiles: { aEnv: "config/a.json" },',
        "};",
        "",
      ].join("\n"),
    );
    const targetPath = join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid");
    await writeFile(targetPath, '<div data-gateway="__AENV_GATEWAY__"></div>\n');
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
        '          pattern: "__AENV_GATEWAY__",',
        "          value: ctx.aEnv.gateway,",
        "        },",
        "      ],",
        "    };",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let output = "";

    try {
      await deployProject({
        configName: "test",
        cwd,
        dryRun: true,
        runShopifyCommand: vi.fn(async () => 0),
      });
      output = log.mock.calls.map(([message]) => String(message)).join("\n");
    } finally {
      log.mockRestore();
    }

    expect(output).toContain("\u001B[1m\u001B[36mCustom env files injected\u001B[39m\u001B[22m");
    expect(output).toContain(
      "\u001B[36maEnv\u001B[39m \u001B[90m->\u001B[39m \u001B[35mconfig/a.json\u001B[39m",
    );
    await expect(readFile(targetPath, "utf8")).resolves.toBe(
      '<div data-gateway="__AENV_GATEWAY__"></div>\n',
    );
  });

  it("restores stale injected values from a killed deploy before preparing plans", async () => {
    const cwd = await createDevProject();
    await writeFile(
      join(cwd, "shopify.app.test.toml"),
      [
        ...createShopifyBasicConfig("https://test.example.com"),
        "",
        "[app_proxy]",
        'prefix = "apps"',
        'subpath = "fixture-test"',
        'url = "https://example.test/proxy"',
        "",
      ].join("\n"),
    );
    const targetPath = join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid");
    const transactionPath = join(cwd, ".bshopify", "extension-prepare.transaction.json");
    const staleValue = "https://stale.example.com/proxy";
    // Simulate a deploy killed after injecting without markers (deploy style):
    // the target still holds the stale value and the journal records it.
    await writeFile(
      targetPath,
      '<div data-api-base="https://stale.example.com/proxy"></div>\n',
    );
    await mkdir(join(cwd, ".bshopify"), { recursive: true });
    await writeFile(join(cwd, ".bshopify", "extension-prepare.lock"), "999999999\n");
    await writeFile(
      transactionPath,
      `${JSON.stringify({
        files: [
          {
            path: targetPath,
            replacements: [
              {
                pattern: "__SHOPIFY_APP_PROXY_BASE__",
                value: staleValue,
              },
            ],
          },
        ],
      })}\n`,
    );
    const runShopifyCommand = vi.fn(async () => {
      await expect(readFile(targetPath, "utf8")).resolves.toContain("/apps/fixture-test");
      await expect(readFile(targetPath, "utf8")).resolves.not.toContain(staleValue);
      return 0;
    });

    await deployProject({
      configName: "test",
      cwd,
      runShopifyCommand,
      yes: true,
    });

    await expect(readFile(targetPath, "utf8")).resolves.toBe(
      '<div data-api-base="__SHOPIFY_APP_PROXY_BASE__"></div>\n',
    );
    await expect(readFile(transactionPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("runs deploy dry-runs without calling Shopify deploy", async () => {
    const cwd = await createDevProject();
    await writeFile(
      join(cwd, "shopify.app.test.toml"),
      [
        ...createShopifyBasicConfig("https://test.example.com"),
        "",
        "[app_proxy]",
        'prefix = "apps"',
        'subpath = "fixture-test"',
        'url = "https://example.test/proxy"',
        "",
      ].join("\n"),
    );
    const targetPath = join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid");
    const runShopifyCommand = vi.fn(async () => 0);

    const exitCode = await deployProject({
      configName: "test",
      cwd,
      dryRun: true,
      runShopifyCommand,
      yes: true,
    });

    expect(exitCode).toBe(0);
    expect(runShopifyCommand).not.toHaveBeenCalled();
    await expect(readFile(targetPath, "utf8")).resolves.toBe(
      '<div data-api-base="__SHOPIFY_APP_PROXY_BASE__"></div>\n',
    );
  });

  it("requires explicit confirmation for production deploys", async () => {
    const cwd = await createDevProject();
    await writeFile(
      join(cwd, "shopify.app.production.toml"),
      [
        ...createShopifyBasicConfig("https://production.example.com"),
        "",
        "[app_proxy]",
        'prefix = "apps"',
        'subpath = "fixture-production"',
        'url = "https://example.test/proxy"',
        "",
      ].join("\n"),
    );
    const runShopifyCommand = vi.fn(async () => 0);

    await expect(
      deployProject({
        configName: "production",
        cwd,
        runShopifyCommand,
        yes: true,
      }),
    ).rejects.toThrow("Production deploy requires --confirm-production.");
    expect(runShopifyCommand).not.toHaveBeenCalled();
  });

  it("shows the production summary before asking for the production confirmation text", async () => {
    const prompts = await import("@inquirer/prompts");
    const cwd = await createDevProject();
    await writeFile(
      join(cwd, "shopify.app.production.toml"),
      [
        ...createShopifyBasicConfig("https://production.example.com"),
        "",
      ].join("\n"),
    );
    await writeFile(
      join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid"),
      "<div></div>\n",
    );
    await writeFile(
      join(cwd, "extensions", "theme-extension", "__entry.js"),
      "export default { async prepare() { return { injections: [] }; } };\n",
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runShopifyCommand = vi.fn(async () => 0);
    const events: string[] = [];
    log.mockImplementation(() => {
      events.push("summary");
    });
    vi.mocked(prompts.input).mockImplementationOnce(() => {
      events.push("confirm-production");
      return Object.assign(Promise.resolve("confirm"), {
        cancel: () => undefined,
      });
    });

    try {
      await deployProject({
        configName: "production",
        cwd,
        runShopifyCommand,
      });
    } finally {
      log.mockRestore();
    }

    expect(events.indexOf("summary")).toBeLessThan(events.indexOf("confirm-production"));
    expect(runShopifyCommand).toHaveBeenCalledWith([
      "app",
      "deploy",
      "--config",
      "production",
    ]);
  });

  it("prints a blank line before handing off to Shopify deploy output", async () => {
    const cwd = await createDevProject();
    await writeFile(
      join(cwd, "shopify.app.production.toml"),
      [
        ...createShopifyBasicConfig("https://production.example.com"),
        "",
      ].join("\n"),
    );
    await writeFile(
      join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid"),
      "<div></div>\n",
    );
    await writeFile(
      join(cwd, "extensions", "theme-extension", "__entry.js"),
      "export default { async prepare() { return { injections: [] }; } };\n",
    );
    const events: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((message) => {
      events.push(message === "" ? "blank-line" : "bshopify-log");
    });
    const runShopifyCommand = vi.fn(async () => {
      events.push("shopify-deploy");
      return 0;
    });

    try {
      await deployProject({
        configName: "production",
        cwd,
        runShopifyCommand,
      });
    } finally {
      log.mockRestore();
    }

    expect(events[events.indexOf("shopify-deploy") - 1]).toBe("blank-line");
  });

  it("uses deploy wording when deploy injection values are missing", async () => {
    const cwd = await createDevProject();
    await writeFile(
      join(cwd, "shopify.app.test.toml"),
      [
        ...createShopifyBasicConfig("https://test.example.com"),
        "",
      ].join("\n"),
    );
    const runShopifyCommand = vi.fn(async () => 0);

    await expect(
      deployProject({
        configName: "test",
        cwd,
        runShopifyCommand,
        yes: true,
      }),
    ).rejects.toThrow("__SHOPIFY_APP_PROXY_BASE__ has no value for deploy.");
    expect(runShopifyCommand).not.toHaveBeenCalled();
  });

  it("warns and keeps deploy running when an injection pattern matches nothing", async () => {
    const cwd = await createDevProject();
    await writeFile(
      join(cwd, "shopify.app.test.toml"),
      [
        ...createShopifyBasicConfig("https://test.example.com"),
        "",
      ].join("\n"),
    );
    const extensionRoot = join(cwd, "extensions", "theme-extension");
    const unmatchedPath = join(extensionRoot, "assets", "productBlock.tsx");
    await mkdir(join(extensionRoot, "assets"), { recursive: true });
    await writeFile(
      unmatchedPath,
      'export function ProductBlock() { return <div data-api-base="https://test.example.com"></div>; }\n',
    );
    await writeFile(
      join(extensionRoot, "__entry.js"),
      [
        "export default {",
        "  async prepare() {",
        "    return {",
        "      injections: [",
        "        {",
        '          file: "blocks/app-embed.liquid",',
        '          strategy: "replace",',
        '          pattern: "__SHOPIFY_APP_PROXY_BASE__",',
        '          value: "https://test.example.com/proxy",',
        "        },",
        "        {",
        '          file: "assets/productBlock.tsx",',
        '          strategy: "replace",',
        '          pattern: "__SHOPIFY_APP_PROXY_BASE__",',
        '          value: "https://test.example.com/proxy",',
        "        },",
        "      ],",
        "    };",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runShopifyCommand = vi.fn(async () => 0);
    let warningOutput = "";

    try {
      const exitCode = await deployProject({
        configName: "test",
        cwd,
        runShopifyCommand,
        yes: true,
      });
      expect(exitCode).toBe(0);
      warningOutput = warn.mock.calls.map(([message]) => String(message)).join("\n");
    } finally {
      warn.mockRestore();
    }

    expect(runShopifyCommand).toHaveBeenCalledWith(["app", "deploy", "--config", "test"]);
    await expect(readFile(unmatchedPath, "utf8")).resolves.toBe(
      'export function ProductBlock() { return <div data-api-base="https://test.example.com"></div>; }\n',
    );
    expect(warningOutput).toContain(
      'extensions/theme-extension/assets/productBlock.tsx: expected exactly one "__SHOPIFY_APP_PROXY_BASE__" match, got 0; skipped.',
    );
  });

  it("skips placeholder entries during deploy: not listed, entries stay in place, effective entries still injected", async () => {
    const cwd = await createDevProject();
    await mkdir(join(cwd, "extensions", "placeholder-ext", "blocks"), { recursive: true });
    await writeFile(
      join(cwd, "extensions", "placeholder-ext", "blocks", "app-embed.liquid"),
      "<div></div>\n",
    );
    await writeFile(
      join(cwd, "extensions", "placeholder-ext", "__entry.js"),
      managedEntryTemplate,
    );
    await writeFile(
      join(cwd, "shopify.app.test.toml"),
      [
        ...createShopifyBasicConfig("https://test.example.com"),
        "",
        "[app_proxy]",
        'prefix = "apps"',
        'subpath = "fixture-test"',
        'url = "https://example.test/proxy"',
        "",
      ].join("\n"),
    );
    const customEntryPath = join(cwd, "extensions", "theme-extension", "__entry.js");
    const placeholderEntryPath = join(cwd, "extensions", "placeholder-ext", "__entry.js");
    const targetPath = join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let output = "";
    const runShopifyCommand = vi.fn(async () => {
      // no entry files are hidden anymore, placeholder or not
      await expect(stat(customEntryPath)).resolves.toBeDefined();
      await expect(stat(placeholderEntryPath)).resolves.toBeDefined();
      // the effective entry still ran its injection while Shopify deploys
      await expect(readFile(targetPath, "utf8")).resolves.toContain("/apps/fixture-test");
      return 0;
    });

    try {
      const exitCode = await deployProject({
        configName: "test",
        cwd,
        runShopifyCommand,
        yes: true,
      });
      output = log.mock.calls.map(([message]) => String(message)).join("\n");
      expect(exitCode).toBe(0);
    } finally {
      log.mockRestore();
    }

    expect(output).toContain("Skipped 1 placeholder extension entr");
    expect(output).toContain("theme-extension");
    expect(output).not.toContain("placeholder-ext");
    await expect(readFile(customEntryPath, "utf8")).resolves.toContain("async prepare(ctx)");
    await expect(readFile(placeholderEntryPath, "utf8")).resolves.toBe(managedEntryTemplate);
  });

  it("skips all-placeholder projects entirely: no injections and no restore notice", async () => {
    const cwd = await createDevProject();
    await writeFile(
      join(cwd, "extensions", "theme-extension", "__entry.js"),
      managedEntryTemplate,
    );
    await writeFile(
      join(cwd, "extensions", "theme-extension", "blocks", "app-embed.liquid"),
      "<div></div>\n",
    );
    await writeFile(
      join(cwd, "shopify.app.test.toml"),
      [
        ...createShopifyBasicConfig("https://test.example.com"),
        "",
      ].join("\n"),
    );
    const entryPath = join(cwd, "extensions", "theme-extension", "__entry.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let output = "";
    const runShopifyCommand = vi.fn(async () => {
      await expect(stat(entryPath)).resolves.toBeDefined();
      return 0;
    });

    try {
      const exitCode = await deployProject({
        configName: "test",
        cwd,
        runShopifyCommand,
        yes: true,
      });
      output = log.mock.calls.map(([message]) => String(message)).join("\n");
      expect(exitCode).toBe(0);
    } finally {
      log.mockRestore();
    }

    expect(runShopifyCommand).toHaveBeenCalledWith(["app", "deploy", "--config", "test"]);
    expect(output).toContain("Skipped 1 placeholder extension entr");
    expect(output).not.toContain("Deploy extension files restored.");
  });
});

function isRuntimeHiddenCommand(command: unknown): boolean {
  return (command as CommandWithRuntimeHiddenFlag)._hidden === true;
}
