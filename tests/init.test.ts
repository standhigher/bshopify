import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { formatInitResult, initProject } from "../src";
import { createFileMarker, createRestoreMarker } from "../src/utils/markers";

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

interface FixturePackageJson {
  scripts: Record<string, string>;
}

interface FixtureInitManifest {
  cleanFilter?: { path: string };
  entries: Record<string, { path: string }>;
  preCommitHook?: { path: string };
  version: number;
}

async function createTempProject(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "bshopify-init-"));
  tempDirs.push(cwd);

  await writeFile(
    join(cwd, "package.json"),
    `${JSON.stringify(
      {
        name: "fixture-shopify-app",
        scripts: {
          dev: "shopify app dev",
          lint: "eslint .",
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(cwd, "shopify.app.dev.toml"), "name = \"dev\"\n");
  await writeFile(join(cwd, "shopify.app.test.toml"), "name = \"test\"\n");
  await writeFile(
    join(cwd, "shopify.app.production.toml"),
    "name = \"production\"\n",
  );
  await writeFile(join(cwd, ".gitignore"), "node_modules/\n");
  await mkdir(join(cwd, "extensions", "theme-extension"), { recursive: true });
  await execFileAsync("git", ["init"], { cwd });

  return cwd;
}

async function createLinkedWorktreeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bshopify-worktree-"));
  tempDirs.push(root);

  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  await mkdir(repo);
  await writeFile(join(repo, "package.json"), `${JSON.stringify({ scripts: {} })}\n`);
  await execFileAsync("git", ["init"], { cwd: repo });
  await execFileAsync("git", ["add", "package.json"], { cwd: repo });
  await execFileAsync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "init"],
    { cwd: repo },
  );
  await execFileAsync("git", ["worktree", "add", worktree], { cwd: repo });

  await writeFile(join(worktree, "shopify.app.dev.toml"), "name = \"dev\"\n");
  await writeFile(join(worktree, "shopify.app.test.toml"), "name = \"test\"\n");
  await writeFile(
    join(worktree, "shopify.app.production.toml"),
    "name = \"production\"\n",
  );
  await writeFile(join(worktree, ".gitignore"), "node_modules/\n");
  await mkdir(join(worktree, "extensions", "theme-extension"), { recursive: true });

  return worktree;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true })));
});

describe("initProject", () => {
  it("generates runner config, default git hook, gitignore entry, and extension entry", async () => {
    const cwd = await createTempProject();

    const result = await initProject({ cwd });

    const runnerConfig = await readFile(join(cwd, "bshopify.config.mjs"), "utf8");
    expect(runnerConfig).toContain("// @ts-check");
    expect(runnerConfig).toContain("@typedef {Object} BshopifyRunnerConfig");
    expect(runnerConfig).toContain(
      "@property {Record<string, string>} [configFiles]",
    );
    expect(runnerConfig).toContain(
      "@property {Record<string, string | string[]>} [envFiles]",
    );
    expect(runnerConfig).toContain(
      "@property {boolean} [failOnUnresolvedPlaceholders]",
    );
    expect(runnerConfig).toContain("/** @type {BshopifyRunnerConfig} */");
    // The generated config must stay self-contained: no package import or
    // module reference, so global-only installs type-check without errors.
    expect(runnerConfig).not.toContain("@standhigher/bshopify");
    expect(runnerConfig).not.toContain("import(");
    expect(runnerConfig).not.toContain("defineConfig");
    expect(runnerConfig).toContain("Shopify app config files by environment");
    expect(runnerConfig).toContain("configFiles:");
    expect(runnerConfig).toContain("failOnUnresolvedPlaceholders: true");
    expect(runnerConfig).not.toContain("restoreMarkers");
    expect(runnerConfig).not.toContain("extensionsRoot");
    expect(runnerConfig).not.toContain("tmpRoot");
    expect(runnerConfig).not.toContain("hideEntryBeforeDeploy");
    await expect(readFile(join(cwd, ".gitignore"), "utf8")).resolves.toContain(
      ".bshopify/",
    );
    await expect(readFile(join(cwd, ".gitignore"), "utf8")).resolves.toContain(
      "# bshopify cli",
    );
    await expect(readFile(join(cwd, ".git", "hooks", "pre-commit"), "utf8")).resolves.toContain(
      "./node_modules/.bin/bshopify app guard",
    );
    const entry = await readFile(
      join(cwd, "extensions", "theme-extension", "__entry.js"),
      "utf8",
    );
    expect(entry).toContain("async prepare(ctx)");
    expect(entry).toContain("// @ts-check");
    expect(entry).toContain("@typedef {Object} BshopifyExtensionLifecycle");
    expect(entry).toContain("/** @type {BshopifyExtensionLifecycle} */");
    // The generated entry must stay self-contained: no package import or
    // module reference, so global-only installs type-check without errors.
    expect(entry).not.toContain("@standhigher/bshopify");
    expect(entry).not.toContain("import(");

    // init leaves package.json scripts to the user and never overrides them.
    const packageJson = JSON.parse(
      await readFile(join(cwd, "package.json"), "utf8"),
    ) as FixturePackageJson;
    expect(packageJson.scripts.dev).toBe("shopify app dev");
    expect(packageJson.scripts.deploy).toBeUndefined();
    expect(packageJson.scripts.lint).toBe("eslint .");
    expect(packageJson.scripts["shopify:dev"]).toBeUndefined();
    expect(packageJson.scripts["shopify:deploy"]).toBeUndefined();
    expect(packageJson.scripts["shopify:validate"]).toBeUndefined();
    expect(packageJson.scripts["shopify:guard"]).toBeUndefined();
    expect(result.errors).toEqual([]);
    expect(result.created).toContain("bshopify.config.mjs");
    expect(result.updated).not.toContain(expect.stringContaining("package.json scripts"));
  });

  it("writes an init manifest for generated and managed resources", async () => {
    const cwd = await createTempProject();

    await initProject({ cwd });

    const manifest = JSON.parse(
      await readFile(join(cwd, ".bshopify", "bshopify.manifest.json"), "utf8"),
    ) as FixtureInitManifest;
    await expect(stat(join(cwd, "bshopify.manifest.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(manifest.version).toBe(1);
    expect(manifest).not.toHaveProperty("tmpRoot");
    expect(manifest).not.toHaveProperty("packageScripts");
    expect(manifest.preCommitHook?.path).toBe(".git/hooks/pre-commit");
    expect(manifest.entries["theme-extension"]?.path).toBe(
      "extensions/theme-extension/__entry.js",
    );
  });

  it("drops manifest entries for extensions that no longer exist", async () => {
    const cwd = await createTempProject();
    await mkdir(join(cwd, "extensions", "removed-extension"), { recursive: true });
    await initProject({ cwd });
    await rm(join(cwd, "extensions", "removed-extension"), { recursive: true });

    const result = await initProject({ cwd });
    const manifest = JSON.parse(
      await readFile(join(cwd, ".bshopify", "bshopify.manifest.json"), "utf8"),
    ) as FixtureInitManifest;

    expect(manifest.entries["removed-extension"]).toBeUndefined();
    expect(manifest.entries["theme-extension"]?.path).toBe(
      "extensions/theme-extension/__entry.js",
    );
    expect(result.updated).toContain(
      "removed manifest entry for missing extension extensions/removed-extension",
    );
  });

  it("migrates legacy extensionEntries manifest keys when reading an older manifest", async () => {
    const cwd = await createTempProject();
    await initProject({ cwd });
    await writeFile(
      join(cwd, ".bshopify", "bshopify.manifest.json"),
      `${JSON.stringify(
        {
          configFile: "bshopify.config.mjs",
          extensionEntries: {
            "theme-extension": {
              path: "extensions/theme-extension/__entry.js",
            },
          },
          gitignore: { path: ".gitignore" },
          version: 1,
        },
        null,
        2,
      )}\n`,
    );

    await initProject({ cwd });
    const manifest = JSON.parse(
      await readFile(join(cwd, ".bshopify", "bshopify.manifest.json"), "utf8"),
    ) as FixtureInitManifest;

    expect(manifest.entries["theme-extension"]?.path).toBe(
      "extensions/theme-extension/__entry.js",
    );
    expect(manifest).not.toHaveProperty("extensionEntries");
  });

  it("inserts guard block near the top of an existing pre-commit hook", async () => {
    const cwd = await createTempProject();
    const hookPath = join(cwd, ".git", "hooks", "pre-commit");
    await writeFile(hookPath, "#!/usr/bin/env sh\nexit 0\nnpm test\n");

    const result = await initProject({ cwd });
    const hook = await readFile(hookPath, "utf8");

    expect(hook).toContain("# bshopify app guard start");
    expect(hook.indexOf("bshopify app guard")).toBeLessThan(hook.indexOf("exit 0"));
    expect(hook).toContain("# bshopify app guard end");
    expect(hook).toContain("exit 0");
    expect(hook).toContain("npm test");
    expect(result.updated).toContain(".git/hooks/pre-commit");
  });

  it("does not insert duplicate guard blocks", async () => {
    const cwd = await createTempProject();
    const hookPath = join(cwd, ".git", "hooks", "pre-commit");
    await writeFile(
      hookPath,
      "#!/usr/bin/env sh\n# bshopify app guard start\nbshopify app guard\n# bshopify app guard end\nnpm test\n",
    );

    const result = await initProject({ cwd });
    const hook = await readFile(hookPath, "utf8");

    expect(hook.match(/# bshopify app guard start/g)).toHaveLength(1);
    expect(result.updated).toContain(".git/hooks/pre-commit");
  });

  it("refreshes existing app guard blocks to the latest managed content", async () => {
    const cwd = await createTempProject();
    const hookPath = join(cwd, ".git", "hooks", "pre-commit");
    await writeFile(
      hookPath,
      "#!/usr/bin/env sh\n# bshopify app guard start\nbshopify app guard\n# bshopify app guard end\nnpm test\n",
    );

    const result = await initProject({ cwd });
    const hook = await readFile(hookPath, "utf8");

    expect(hook).toContain("./node_modules/.bin/bshopify app guard");
    expect(hook).toContain("npm test");
    expect(hook.match(/# bshopify app guard start/g)).toHaveLength(1);
    expect(result.updated).toContain(".git/hooks/pre-commit");
  });

  it("upgrades legacy bare guard commands into an app guard block", async () => {
    const cwd = await createTempProject();
    const hookPath = join(cwd, ".git", "hooks", "pre-commit");
    await writeFile(hookPath, "#!/usr/bin/env sh\nexit 0\nbshopify guard\n");

    const result = await initProject({ cwd });
    const hook = await readFile(hookPath, "utf8");

    expect(hook).toContain("# bshopify app guard start");
    expect(hook.indexOf("bshopify app guard")).toBeLessThan(hook.indexOf("exit 0"));
    expect(hook.match(/^bshopify guard$/gm)).toBeNull();
    expect(hook).toContain("./node_modules/.bin/bshopify app guard");
    expect(result.updated).toContain(".git/hooks/pre-commit");
  });

  it("upgrades legacy marked guard blocks into an app guard block", async () => {
    const cwd = await createTempProject();
    const hookPath = join(cwd, ".git", "hooks", "pre-commit");
    await writeFile(
      hookPath,
      "#!/usr/bin/env sh\n# bshopify guard start\nbshopify guard\n# bshopify guard end\nnpm test\n",
    );

    const result = await initProject({ cwd });
    const hook = await readFile(hookPath, "utf8");

    expect(hook).toContain("# bshopify app guard start");
    expect(hook).toContain("./node_modules/.bin/bshopify app guard");
    expect(hook).not.toContain("# bshopify guard start");
    expect(hook.match(/^bshopify guard$/gm)).toBeNull();
    expect(result.updated).toContain(".git/hooks/pre-commit");
  });

  it("writes pre-commit hook to the configured core.hooksPath", async () => {
    const cwd = await createTempProject();
    await execFileAsync("git", ["config", "core.hooksPath", ".custom-hooks"], { cwd });

    const result = await initProject({ cwd });

    await expect(readFile(join(cwd, ".custom-hooks", "pre-commit"), "utf8")).resolves.toContain(
      "bshopify app guard",
    );
    expect(result.created).toContain(".custom-hooks/pre-commit");
  });

  it("supports absolute core.hooksPath values", async () => {
    const cwd = await createTempProject();
    const hooksPath = join(cwd, "absolute-hooks");
    await execFileAsync("git", ["config", "core.hooksPath", hooksPath], { cwd });

    const result = await initProject({ cwd });

    await expect(readFile(join(hooksPath, "pre-commit"), "utf8")).resolves.toContain(
      "bshopify app guard",
    );
    expect(result.created).toContain("absolute-hooks/pre-commit");
  });

  it("clears stale pre-commit manifest tracking when no git hook path is available", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bshopify-no-git-"));
    tempDirs.push(cwd);
    await writeFile(join(cwd, "package.json"), `${JSON.stringify({ scripts: {} })}\n`);
    await writeFile(join(cwd, "shopify.app.dev.toml"), "name = \"dev\"\n");
    await writeFile(join(cwd, "shopify.app.test.toml"), "name = \"test\"\n");
    await writeFile(join(cwd, "shopify.app.production.toml"), "name = \"production\"\n");
    await writeFile(join(cwd, ".gitignore"), "node_modules/\n");
    await mkdir(join(cwd, "extensions", "theme-extension"), { recursive: true });
    await mkdir(join(cwd, ".bshopify"), { recursive: true });
    await writeFile(
      join(cwd, ".bshopify", "bshopify.manifest.json"),
      `${JSON.stringify(
        {
          configFile: "bshopify.config.mjs",
          entries: {},
          gitignore: { path: ".gitignore" },
          preCommitHook: { path: ".git/hooks/pre-commit" },
          version: 1,
        },
        null,
        2,
      )}\n`,
    );

    const result = await initProject({ cwd });
    const manifest = JSON.parse(
      await readFile(join(cwd, ".bshopify", "bshopify.manifest.json"), "utf8"),
    ) as FixtureInitManifest;

    expect(manifest.preCommitHook).toBeUndefined();
    expect(result.warnings).toContain("git repository not found; pre-commit hook skipped");
  });

  it("creates pre-commit in Git's effective hook path for linked worktrees", async () => {
    const cwd = await createLinkedWorktreeProject();
    const { stdout } = await execFileAsync("git", ["rev-parse", "--git-path", "hooks/pre-commit"], {
      cwd,
    });
    const hookPath = stdout.trim();

    const result = await initProject({ cwd });

    await expect(readFile(hookPath, "utf8")).resolves.toContain("bshopify app guard");
    expect(result.created).toContain(hookPath);
  });

  it("does not overwrite existing extension entries", async () => {
    const cwd = await createTempProject();
    const entryPath = join(cwd, "extensions", "theme-extension", "__entry.js");
    await writeFile(entryPath, "export default { custom: true };\n");

    const result = await initProject({ cwd });

    await expect(readFile(entryPath, "utf8")).resolves.toBe(
      "export default { custom: true };\n",
    );
    expect(result.skipped).toContain("extensions/theme-extension/__entry.js");
  });

  it("syncs entries for extensions added after initialization", async () => {
    const cwd = await createTempProject();
    const existingEntryPath = join(cwd, "extensions", "theme-extension", "__entry.js");
    await initProject({ cwd });
    await writeFile(existingEntryPath, "export default { custom: true };\n");
    await mkdir(join(cwd, "extensions", "new-theme-extension"), { recursive: true });

    const result = await initProject({ cwd });

    await expect(readFile(existingEntryPath, "utf8")).resolves.toBe(
      "export default { custom: true };\n",
    );
    await expect(
      readFile(join(cwd, "extensions", "new-theme-extension", "__entry.js"), "utf8"),
    ).resolves.toContain("async prepare(ctx)");
    expect(result.created).toContain("extensions/new-theme-extension/__entry.js");
    expect(result.skipped).toContain("extensions/theme-extension/__entry.js");
  });

  it("uses the configured entry file name when creating extension entries", async () => {
    const cwd = await createTempProject();
    await writeFile(
      join(cwd, "bshopify.config.mjs"),
      "export default { entryFileName: 'entry.mjs' };\n",
    );

    const result = await initProject({ cwd });

    await expect(
      readFile(join(cwd, "extensions", "theme-extension", "entry.mjs"), "utf8"),
    ).resolves.toContain("async prepare(ctx)");
    expect(result.created).toContain("extensions/theme-extension/entry.mjs");
  });

  it("does not claim pre-existing custom extension entries as managed resources", async () => {
    const cwd = await createTempProject();
    const customEntryPath = join(cwd, "extensions", "theme-extension", "__entry.js");
    await writeFile(customEntryPath, "export default { custom: true };\n");
    await initProject({ cwd });
    await writeFile(
      join(cwd, "bshopify.config.mjs"),
      "export default { entryFileName: 'entry.mjs' };\n",
    );

    const result = await initProject({ cwd });
    const manifest = JSON.parse(
      await readFile(join(cwd, ".bshopify", "bshopify.manifest.json"), "utf8"),
    ) as FixtureInitManifest;

    await expect(readFile(customEntryPath, "utf8")).resolves.toBe(
      "export default { custom: true };\n",
    );
    await expect(
      readFile(join(cwd, "extensions", "theme-extension", "entry.mjs"), "utf8"),
    ).resolves.toContain("async prepare(ctx)");
    expect(manifest.entries["theme-extension"]?.path).toBe(
      "extensions/theme-extension/entry.mjs",
    );
    expect(result.created).toContain("extensions/theme-extension/entry.mjs");
  });

  it("merges existing runner config with the latest managed defaults and keeps user fields", async () => {
    const cwd = await createTempProject();
    await writeFile(
      join(cwd, "bshopify.config.mjs"),
      [
        "export default {",
        '  entryFileName: "entry.mjs",',
        '  customField: "kept",',
        "};",
        "",
      ].join("\n"),
    );

    const result = await initProject({ cwd });
    const runnerConfig = await readFile(join(cwd, "bshopify.config.mjs"), "utf8");

    expect(runnerConfig).toContain('entryFileName: "entry.mjs"');
    expect(runnerConfig).not.toContain("extensionsRoot:");
    expect(runnerConfig).toContain("configFiles:");
    expect(runnerConfig).toContain("failOnUnresolvedPlaceholders: true");
    expect(runnerConfig).not.toContain("restoreMarkers");
    expect(runnerConfig).not.toContain("hideEntryBeforeDeploy");
    expect(runnerConfig).toContain('customField: "kept"');
    expect(result.updated).toContain("bshopify.config.mjs");
  });

  it("replaces configFiles in an existing runner config when resolution changed the mapping", async () => {
    const cwd = await createTempProject();
    await rm(join(cwd, "shopify.app.test.toml"));
    await rm(join(cwd, "shopify.app.production.toml"));
    await writeFile(
      join(cwd, "bshopify.config.mjs"),
      [
        "export default {",
        "  configFiles: {",
        '    dev: "shopify.app.dev.toml",',
        '    test: "shopify.app.test.toml",',
        '    production: "shopify.app.production.toml",',
        "  },",
        '  customField: "kept",',
        "};",
        "",
      ].join("\n"),
    );

    const result = await initProject({ cwd });
    const runnerConfig = await readFile(join(cwd, "bshopify.config.mjs"), "utf8");

    expect(result.errors).toEqual([]);
    expect(runnerConfig).toContain('dev: "shopify.app.dev.toml"');
    expect(runnerConfig).toContain('test: "shopify.app.dev.toml"');
    expect(runnerConfig).toContain('production: "shopify.app.dev.toml"');
    expect(runnerConfig).toContain('customField: "kept"');
    expect(result.updated).toContain("bshopify.config.mjs");
  });

  it("merges defineConfig-wrapped runner configs like the plain form", async () => {
    const cwd = await createTempProject();
    // A defineConfig-style config imports the package at runtime, so the
    // fixture needs it resolvable from the project (a real install would
    // provide the same resolution).
    await mkdir(join(cwd, "node_modules", "@standhigher", "bshopify"), {
      recursive: true,
    });
    await writeFile(
      join(cwd, "node_modules", "@standhigher", "bshopify", "package.json"),
      `${JSON.stringify({
        exports: { ".": "./index.mjs" },
        name: "@standhigher/bshopify",
        type: "module",
      })}\n`,
    );
    await writeFile(
      join(cwd, "node_modules", "@standhigher", "bshopify", "index.mjs"),
      "export function defineConfig(config) { return config; }\n",
    );
    await writeFile(
      join(cwd, "bshopify.config.mjs"),
      [
        "import { defineConfig } from \"@standhigher/bshopify\";",
        "",
        "export default defineConfig({",
        '  entryFileName: "entry.mjs",',
        '  customField: "kept",',
        "});",
        "",
      ].join("\n"),
    );

    const result = await initProject({ cwd });
    const runnerConfig = await readFile(join(cwd, "bshopify.config.mjs"), "utf8");

    expect(result.errors).toEqual([]);
    expect(runnerConfig).toContain('import { defineConfig } from "@standhigher/bshopify"');
    expect(runnerConfig).toContain('export default defineConfig({');
    expect(runnerConfig).toContain('entryFileName: "entry.mjs"');
    expect(runnerConfig).toContain('customField: "kept"');
    expect(runnerConfig).toContain("\n  configFiles: {");
    expect(runnerConfig).toContain("\n  failOnUnresolvedPlaceholders: true,");
    expect(runnerConfig.endsWith("});\n")).toBe(true);
    expect(result.updated).toContain("bshopify.config.mjs");
  });

  it("merges missing runner config fields even when nested objects use the same names", async () => {
    const cwd = await createTempProject();
    await writeFile(
      join(cwd, "bshopify.config.mjs"),
      [
        "export default {",
        "  custom: {",
        "    configFiles: {},",
        "    restoreMarkers: false,",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    await initProject({ cwd });
    const runnerConfig = await readFile(join(cwd, "bshopify.config.mjs"), "utf8");

    expect(runnerConfig).toContain("  custom: {");
    expect(runnerConfig).toContain("    restoreMarkers: false,");
    expect(runnerConfig).toContain("\n  configFiles: {");
    expect(runnerConfig).toContain("\n  failOnUnresolvedPlaceholders: true,");
    expect(runnerConfig).not.toContain("\n  restoreMarkers: true,");
  });

  it("merges runner config fields after block comments with braces", async () => {
    const cwd = await createTempProject();
    await writeFile(
      join(cwd, "bshopify.config.mjs"),
      [
        "export default {",
        "  /* { */",
        '  customField: "kept",',
        "  restoreMarkers: false,",
        "};",
        "",
      ].join("\n"),
    );

    await initProject({ cwd });
    const runnerConfig = await readFile(join(cwd, "bshopify.config.mjs"), "utf8");

    expect(runnerConfig).toContain('customField: "kept"');
    expect(runnerConfig).toContain("\n  restoreMarkers: false,");
    expect(runnerConfig.match(/restoreMarkers:/g)).toHaveLength(1);
  });

  it("leaves package.json scripts untouched", async () => {
    const cwd = await createTempProject();
    await writeFile(
      join(cwd, "package.json"),
      `${JSON.stringify(
        {
          name: "fixture-shopify-app",
          scripts: {
            dev: "pnpm custom-dev",
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = await initProject({ cwd });
    const packageJson = JSON.parse(
      await readFile(join(cwd, "package.json"), "utf8"),
    ) as FixturePackageJson;

    expect(packageJson.scripts.dev).toBe("pnpm custom-dev");
    expect(packageJson.scripts.deploy).toBeUndefined();
    // init never reports package.json script changes in the summary.
    expect(result.updated).not.toContain(expect.stringContaining("package.json scripts"));
  });











  it("writes the git clean filter script, gitattributes entry, and git config", async () => {
    const cwd = await createTempProject();

    const result = await initProject({ cwd });

    await expect(
      readFile(join(cwd, ".bshopify", "git-add-cleaner.js"), "utf8"),
    ).resolves.toContain("bshopify-restore:");
    await expect(readFile(join(cwd, ".gitattributes"), "utf8")).resolves.toContain(
      "extensions/** filter=bshopify",
    );

    const { stdout: clean } = await execFileAsync(
      "git",
      ["config", "--get", "filter.bshopify.clean"],
      { cwd },
    );
    const { stdout: smudge } = await execFileAsync(
      "git",
      ["config", "--get", "filter.bshopify.smudge"],
      { cwd },
    );
    const { stdout: required } = await execFileAsync(
      "git",
      ["config", "--get", "filter.bshopify.required"],
      { cwd },
    );
    expect(clean.trim()).toBe("node .bshopify/git-add-cleaner.js");
    expect(smudge.trim()).toBe("node .bshopify/git-add-cleaner.js --smudge");
    expect(required.trim()).toBe("false");

    const manifest = JSON.parse(
      await readFile(join(cwd, ".bshopify", "bshopify.manifest.json"), "utf8"),
    ) as FixtureInitManifest;
    expect(manifest.cleanFilter?.path).toBe(".bshopify/git-add-cleaner.js");
    expect(result.created).toContain(".bshopify/git-add-cleaner.js");
    expect(result.skipped).not.toContain(".bshopify/git-add-cleaner.js");
    expect(result.updated).toContain(".gitattributes");
    expect(result.updated).toContain("git config filter.bshopify");
    // init never rewrites already-tracked files: on first use there are no
    // bshopify injections to restore, and user edits stay untouched.
    expect(result.warnings).toEqual([]);
  });

  it("does not duplicate the gitattributes entry on re-init", async () => {
    const cwd = await createTempProject();

    await initProject({ cwd });
    const result = await initProject({ cwd });

    const gitattributes = await readFile(join(cwd, ".gitattributes"), "utf8");
    expect(gitattributes.match(/extensions\/\*\* filter=bshopify/g)).toHaveLength(1);
    expect(result.skipped).toContain(".gitattributes");
    expect(result.skipped).toContain("git config filter.bshopify");
  });


  it("keeps a custom clean filter script on plain init", async () => {
    const cwd = await createTempProject();
    await mkdir(join(cwd, ".bshopify"), { recursive: true });
    await writeFile(join(cwd, ".bshopify", "git-add-cleaner.js"), "// custom\n");

    const result = await initProject({ cwd });

    await expect(
      readFile(join(cwd, ".bshopify", "git-add-cleaner.js"), "utf8"),
    ).resolves.toBe("// custom\n");
    expect(result.skipped).toContain(".bshopify/git-add-cleaner.js");
  });

  it("refreshes an outdated bshopify-generated clean filter script on re-init", async () => {
    const cwd = await createTempProject();
    await initProject({ cwd });
    const scriptPath = join(cwd, ".bshopify", "git-add-cleaner.js");
    await writeFile(
      scriptPath,
      "// Generated by bshopify (bshopify app init). Do not edit by hand.\n// stale old template\n",
    );

    const result = await initProject({ cwd });

    const script = await readFile(scriptPath, "utf8");
    expect(script).toContain("bshopify-restore:");
    expect(script).not.toContain("stale old template");
    expect(result.updated).toContain(".bshopify/git-add-cleaner.js");
    expect(result.skipped).not.toContain(".bshopify/git-add-cleaner.js");
  });

  it("reports clean filter readiness during check", async () => {
    const cwd = await createTempProject();

    const before = await initProject({ cwd, check: true });
    expect(before.checks).toContainEqual({
      name: "git clean filter",
      ok: false,
      message: "bshopify clean filter not configured; run bshopify app init",
    });

    await initProject({ cwd });
    const after = await initProject({ cwd, check: true });
    expect(after.checks).toContainEqual({
      name: "git clean filter",
      ok: true,
      message: "bshopify clean filter configured",
    });
  });

  it("reports the clean filter as not configured when the gitattributes line is missing", async () => {
    const cwd = await createTempProject();
    await initProject({ cwd });
    await rm(join(cwd, ".gitattributes"));

    const result = await initProject({ cwd, check: true });

    expect(result.checks).toContainEqual({
      name: "git clean filter",
      ok: false,
      message: "bshopify clean filter not configured; run bshopify app init",
    });
  });

  it("stages only the placeholder when an injected file is git added", async () => {
    const cwd = await createTempProject();
    await initProject({ cwd });

    const relativePath = "extensions/theme-extension/blocks/app-embed.liquid";
    const targetPath = join(cwd, relativePath);
    await mkdir(join(cwd, "extensions", "theme-extension", "blocks"), { recursive: true });
    const source = '{{ "__SHOPIFY_APP_PROXY_BASE__" }}\n';
    const marker = createFileMarker(
      targetPath,
      createRestoreMarker("__SHOPIFY_APP_PROXY_BASE__", "https://proxy.example.com"),
    );
    await writeFile(
      targetPath,
      source.replace("__SHOPIFY_APP_PROXY_BASE__", `https://proxy.example.com${marker}`),
    );

    await execFileAsync("git", ["add", relativePath], { cwd });

    const { stdout } = await execFileAsync("git", ["show", `:${relativePath}`], {
      cwd,
      encoding: null,
    });
    expect(stdout.toString("utf8")).toBe(source);
  });

  it("keeps non-UTF-8 extension files byte-identical through git add", async () => {
    const cwd = await createTempProject();
    await initProject({ cwd });

    const relativePath = "extensions/theme-extension/blocks/notes.txt";
    const targetPath = join(cwd, relativePath);
    await mkdir(join(cwd, "extensions", "theme-extension", "blocks"), { recursive: true });
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    await writeFile(targetPath, latin1);

    await execFileAsync("git", ["add", relativePath], { cwd });

    const { stdout } = await execFileAsync("git", ["show", `:${relativePath}`], {
      cwd,
      encoding: null,
    });
    expect(stdout).toEqual(latin1);
  });

  it("writes the clean filter script to the repo top level from a subdirectory", async () => {
    const root = await mkdtemp(join(tmpdir(), "bshopify-monorepo-"));
    tempDirs.push(root);
    await execFileAsync("git", ["init"], { cwd: root });
    const app = join(root, "app");
    await mkdir(join(app, "extensions", "theme-extension"), { recursive: true });
    await writeFile(join(app, "package.json"), `${JSON.stringify({ scripts: {} })}\n`);
    await writeFile(join(app, "shopify.app.dev.toml"), "name = \"dev\"\n");
    await writeFile(join(app, "shopify.app.test.toml"), "name = \"test\"\n");
    await writeFile(join(app, "shopify.app.production.toml"), "name = \"production\"\n");
    await writeFile(join(app, ".gitignore"), "node_modules/\n");

    await initProject({ cwd: app });

    await expect(
      readFile(join(root, ".bshopify", "git-add-cleaner.js"), "utf8"),
    ).resolves.toContain("bshopify-restore:");
    const { stdout: clean } = await execFileAsync(
      "git",
      ["config", "--get", "filter.bshopify.clean"],
      { cwd: app },
    );
    expect(clean.trim()).toBe("node .bshopify/git-add-cleaner.js");

    // The filter command resolves from the repo top, so staging an injected
    // file from a subdirectory must still land the placeholder in the index.
    const relativePath = "app/extensions/theme-extension/blocks/app-embed.liquid";
    const targetPath = join(app, "extensions", "theme-extension", "blocks", "app-embed.liquid");
    await mkdir(join(app, "extensions", "theme-extension", "blocks"), { recursive: true });
    const source = '{{ "__SHOPIFY_APP_PROXY_BASE__" }}\n';
    const marker = createFileMarker(
      targetPath,
      createRestoreMarker("__SHOPIFY_APP_PROXY_BASE__", "https://proxy.example.com"),
    );
    await writeFile(
      targetPath,
      source.replace("__SHOPIFY_APP_PROXY_BASE__", `https://proxy.example.com${marker}`),
    );
    await execFileAsync("git", ["add", relativePath], { cwd: root });

    const { stdout } = await execFileAsync("git", ["show", `:${relativePath}`], {
      cwd: root,
      encoding: null,
    });
    expect(stdout.toString("utf8")).toBe(source);
  });

  it("checks project readiness without writing files", async () => {
    const cwd = await createTempProject();

    const result = await initProject({ cwd, check: true });

    await expect(stat(join(cwd, "bshopify.config.mjs"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(result.checks).toContainEqual({
      name: "shopify.app.dev.toml",
      ok: true,
      message: "found shopify.app.dev.toml",
    });
    expect(result.errors).toEqual([]);
  });

  it("allows projects without extension directories", async () => {
    const cwd = await createTempProject();
    await rm(join(cwd, "extensions", "theme-extension"), { recursive: true });

    const result = await initProject({ cwd });

    await expect(readFile(join(cwd, "bshopify.config.mjs"), "utf8")).resolves.toContain(
      "configFiles:",
    );
    await expect(readFile(join(cwd, "bshopify.config.mjs"), "utf8")).resolves.not.toContain(
      "extensionsRoot",
    );
    expect(result.checks).not.toContainEqual({
      name: "extensions/*",
      ok: false,
      message: "no extension directories found",
    });
    expect(result.errors).toEqual([]);
  });

  it("generates a single default config when no config files exist and points all environments at it", async () => {
    const cwd = await createTempProject();
    await rm(join(cwd, "shopify.app.dev.toml"));
    await rm(join(cwd, "shopify.app.test.toml"));
    await rm(join(cwd, "shopify.app.production.toml"));
    const generated: string[] = [];

    const result = await initProject({
      cwd,
      runShopifyCommand: async (args) => {
        generated.push(args.join(" "));
        await writeFile(join(cwd, "shopify.app.toml"), "name = \"app\"\n");
        return 0;
      },
    });

    expect(generated).toEqual(["app config link --config shopify.app.toml"]);
    expect(result.errors).toEqual([]);
    expect(result.created).toContain("shopify.app.toml");
    expect(result.created).not.toContain("shopify.app.dev.toml");
    const runnerConfig = await readFile(join(cwd, "bshopify.config.mjs"), "utf8");
    expect(runnerConfig).toContain('dev: "shopify.app.toml"');
    expect(runnerConfig).toContain('test: "shopify.app.toml"');
    expect(runnerConfig).toContain('production: "shopify.app.toml"');
    await expect(readFile(join(cwd, "shopify.app.toml"), "utf8")).resolves.toContain(
      "name = \"app\"",
    );
  });

  it("reuses an existing config file for all environments without generating", async () => {
    const cwd = await createTempProject();
    await rm(join(cwd, "shopify.app.test.toml"));
    await rm(join(cwd, "shopify.app.production.toml"));
    let called = false;

    const result = await initProject({
      cwd,
      runShopifyCommand: async () => {
        called = true;
        return 0;
      },
    });

    expect(called).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.created).not.toContain("shopify.app.dev.toml");
    const runnerConfig = await readFile(join(cwd, "bshopify.config.mjs"), "utf8");
    expect(runnerConfig).toContain('dev: "shopify.app.dev.toml"');
    expect(runnerConfig).toContain('test: "shopify.app.dev.toml"');
    expect(runnerConfig).toContain('production: "shopify.app.dev.toml"');
  });

  it("reuses an existing root config file when configured files are missing", async () => {
    const cwd = await createTempProject();
    await rm(join(cwd, "shopify.app.dev.toml"));
    await rm(join(cwd, "shopify.app.test.toml"));
    await rm(join(cwd, "shopify.app.production.toml"));
    await writeFile(join(cwd, "shopify.app.toml"), "name = \"app\"\n");
    let called = false;

    const result = await initProject({
      cwd,
      runShopifyCommand: async () => {
        called = true;
        return 0;
      },
    });

    expect(called).toBe(false);
    expect(result.errors).toEqual([]);
    const runnerConfig = await readFile(join(cwd, "bshopify.config.mjs"), "utf8");
    expect(runnerConfig).toContain('dev: "shopify.app.toml"');
    expect(runnerConfig).toContain('test: "shopify.app.toml"');
    expect(runnerConfig).toContain('production: "shopify.app.toml"');
  });

  it("keeps missing config file errors when shopify generation fails", async () => {
    const cwd = await createTempProject();
    await rm(join(cwd, "shopify.app.dev.toml"));
    await rm(join(cwd, "shopify.app.test.toml"));
    await rm(join(cwd, "shopify.app.production.toml"));

    const result = await initProject({
      cwd,
      runShopifyCommand: async () => {
        throw new Error("shopify CLI is not available");
      },
    });

    expect(result.errors).toContain("missing shopify.app.dev.toml");
    expect(result.errors).toContain("missing shopify.app.test.toml");
    expect(result.errors).toContain("missing shopify.app.production.toml");
    expect(result.warnings).toContain(
      "failed to generate shopify.app.toml: shopify CLI is not available",
    );
  });

  it("records a warning when shopify config link does not create the file", async () => {
    const cwd = await createTempProject();
    await rm(join(cwd, "shopify.app.dev.toml"));
    await rm(join(cwd, "shopify.app.test.toml"));
    await rm(join(cwd, "shopify.app.production.toml"));

    const result = await initProject({
      cwd,
      runShopifyCommand: async () => 0,
    });

    expect(result.errors).toContain("missing shopify.app.dev.toml");
    expect(result.errors).toContain("missing shopify.app.test.toml");
    expect(result.errors).toContain("missing shopify.app.production.toml");
    expect(result.warnings).toContain(
      "shopify app config link --config shopify.app.toml did not create shopify.app.toml",
    );
  });

  it("does not run shopify generation during check", async () => {
    const cwd = await createTempProject();
    await rm(join(cwd, "shopify.app.dev.toml"));
    let called = false;

    const result = await initProject({
      cwd,
      check: true,
      runShopifyCommand: async () => {
        called = true;
        return 0;
      },
    });

    expect(called).toBe(false);
    expect(result.errors).toContain("missing shopify.app.dev.toml");
  });

  it("reports invalid config file paths during check instead of throwing", async () => {
    const cwd = await createTempProject();
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

    const result = await initProject({ cwd, check: true });

    expect(result.checks).toContainEqual({
      name: "bshopify.config.mjs",
      ok: false,
      message: "invalid bshopify.config.mjs",
    });
    expect(result.errors).toContain(
      "bshopify configFiles.dev must be a root-level Shopify app config file: shopify.app.toml or shopify.app.<name>.toml.",
    );
  });

  it("formats init summary with colored sections", () => {
    const summary = formatInitResult({
      checks: [{ name: "package.json", ok: true, message: "found package.json" }],
      created: ["bshopify.config.mjs"],
      errors: ["missing extensions"],
      skipped: ["extensions/theme-extension/__entry.js"],
      updated: [".git/hooks/pre-commit"],
      warnings: ["git repository not found; pre-commit hook skipped"],
    });

    expect(summary).toContain("\n\n\u001B[1m\u001B[34mChecks\u001B[39m\u001B[22m");
    expect(summary).toContain("  \u001B[32mok\u001B[39m package.json");
    expect(summary).not.toContain("package.json: package.json");
    expect(summary).not.toContain("found package.json");
    expect(summary).toContain("\n\n\u001B[1m\u001B[36mUpdated\u001B[39m\u001B[22m");
    expect(summary).toContain("  \u001B[36m~\u001B[39m .git/hooks/pre-commit");
    expect(summary).toContain("  \u001B[33m!\u001B[39m git repository not found; pre-commit hook skipped");
    expect(summary).toContain("  \u001B[31mx\u001B[39m missing extensions");
  });


});

describe("runner config template typing", () => {
  it("keeps the generated config typedef in sync with the documented team-facing config fields", async () => {
    const constantsSource = await readFile(
      join(process.cwd(), "src", "app", "commands", "init", "constants.ts"),
      "utf8",
    );
    const typesSource = await readFile(
      join(process.cwd(), "src", "app", "runner", "types.ts"),
      "utf8",
    );

    const typedefProperties = new Set(
      [...constantsSource.matchAll(/@property \{.*?\} \[([A-Za-z]+)\]/g)].map(
        (match) => match[1],
      ),
    );
    const teamFacingMatch = typesSource.match(
      /Only `([A-Za-z]+)`, `([A-Za-z]+)`, and `([A-Za-z]+)` are/,
    );
    expect(teamFacingMatch).not.toBeNull();
    const teamFacing = new Set(teamFacingMatch?.slice(1) ?? []);

    expect(typedefProperties).toEqual(teamFacing);
  });
});
