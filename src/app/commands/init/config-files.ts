import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { formatShopifyCliConfigArgs, getShopifyCliConfigName } from "#/app/runner/shopify-args";
import { runShopifyCommand as runDefaultShopifyCommand } from "#/app/runner/shopify";
import { isNodeError } from "#/utils/node";
import { ansi, colorize } from "#/utils/output";
import type { ShopifyCommandRunner } from "#/app/runner/types";
import type { InitResult } from "./types";

export interface EnsureShopifyConfigFilesOptions {
  configFiles: Record<string, string>;
  cwd: string;
  result: InitResult;
  runShopifyCommand?: ShopifyCommandRunner;
}

/**
 * Resolves a single Shopify app config file for every environment, so `init`
 * does not stop just because TOML files are absent.
 *
 * A project that is just starting has no per-environment configuration, so
 * all environments share one config file:
 *
 * - If any configured config file already exists, it is reused as the single
 *   source and nothing is generated.
 * - Otherwise any existing root-level `shopify.app*.toml` is reused.
 * - Otherwise one default `shopify.app.toml` is created via
 *   `shopify app config link` and used as the single source.
 *
 * The returned map points every configured environment at the resolved
 * source file; the caller uses it for project checks and writes it into
 * `bshopify.config.mjs`. When generation fails, the original map is returned
 * so the regular checks surface the missing files as errors.
 */
export async function ensureShopifyConfigFiles(
  options: EnsureShopifyConfigFilesOptions,
): Promise<Record<string, string>> {
  const { configFiles, cwd, result } = options;
  const configured = Object.entries(configFiles).filter(([, file]) => file.trim().length > 0);

  if (configured.length === 0) {
    return configFiles;
  }

  if (await allExist(cwd, configured.map(([, file]) => file))) {
    return configFiles;
  }

  const runShopifyCommand =
    options.runShopifyCommand ?? ((args) => runDefaultShopifyCommand(args, cwd));
  const source = await resolveSourceConfigFile(cwd, configured, result, runShopifyCommand);

  if (source === undefined) {
    return configFiles;
  }

  const resolved: Record<string, string> = {};
  for (const [env] of configured) {
    resolved[env] = source;
  }

  return resolved;
}

async function resolveSourceConfigFile(
  cwd: string,
  configured: Array<[string, string]>,
  result: InitResult,
  runShopifyCommand: ShopifyCommandRunner,
): Promise<string | undefined> {
  for (const [, file] of configured) {
    if (await pathExists(join(cwd, file))) {
      return file;
    }
  }

  const existingRootFile = await findExistingRootConfigFile(cwd);
  if (existingRootFile !== undefined) {
    return existingRootFile;
  }

  const defaultFile = "shopify.app.toml";
  await generateConfigFile(cwd, defaultFile, result, runShopifyCommand);

  return (await pathExists(join(cwd, defaultFile))) ? defaultFile : undefined;
}

async function generateConfigFile(
  cwd: string,
  configFile: string,
  result: InitResult,
  runShopifyCommand: ShopifyCommandRunner,
): Promise<void> {
  const configName = getShopifyCliConfigName(configFile);
  const args = ["app", "config", "link", ...formatShopifyCliConfigArgs(configName)];

  console.log(
    `  ${colorize("generating", ansi.cyan)} ${colorize(configFile, ansi.bold)} via ${colorize(`shopify ${args.join(" ")}`, ansi.cyan)}`,
  );

  try {
    await runShopifyCommand(args);
  } catch (error) {
    result.warnings.push(
      `failed to generate ${configFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  if (await pathExists(join(cwd, configFile))) {
    result.created.push(configFile);
  } else {
    result.warnings.push(`shopify ${args.join(" ")} did not create ${configFile}`);
  }
}

async function findExistingRootConfigFile(cwd: string): Promise<string | undefined> {
  let entries;

  try {
    entries = await readdir(cwd, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }

  const files = entries
    .filter((entry) => entry.isFile() && /^shopify\.app.*\.toml$/.test(entry.name))
    .map((entry) => entry.name);

  if (files.length === 0) {
    return undefined;
  }

  return files.includes("shopify.app.toml") ? "shopify.app.toml" : files.sort()[0];
}

async function allExist(cwd: string, files: string[]): Promise<boolean> {
  for (const file of files) {
    if (!(await pathExists(join(cwd, file)))) {
      return false;
    }
  }

  return true;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}
