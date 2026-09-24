import { spawn } from "node:child_process";
import { packageInfo } from "#/utils/package-json";
import { isNewerVersion } from "#/utils/semver";
import { fetchLatestVersionFromNpm, resolveUpdateCommand } from "#/utils/update-check";
import {
  getAutoUpgradeEnabled,
  readLastAutoUpgradeAt,
  writeLastAutoUpgradeAt,
} from "./auto-upgrade-state";

export const autoUpgradeIntervalMs = 24 * 60 * 60 * 1000;

export interface AutoUpgradeTriggerDependencies {
  args?: string[];
  cliPath?: string;
  cwd?: string;
  currentVersion?: string;
  env?: NodeJS.ProcessEnv;
  fetchLatestVersion?: (packageName: string) => Promise<string | undefined>;
  getAutoUpgradeEnabled?: () => Promise<boolean>;
  isInteractive?: boolean;
  now?: () => number;
  packageName?: string;
  readLastAutoUpgradeAt?: () => Promise<number | undefined>;
  spawnDetached?: (command: string) => void;
  spawnWorker?: () => void;
  writeLastAutoUpgradeAt?: (timestamp: number) => Promise<void>;
}

/**
 * Foreground trigger: performs only cheap, synchronous skip checks, then hands
 * the actual version check + install off to a detached, unref'd worker so the
 * CLI never lingers waiting on the network.
 */
export function triggerAutoUpgrade(
  dependencies: AutoUpgradeTriggerDependencies = {},
): void {
  const args = dependencies.args ?? [];
  const env = dependencies.env ?? process.env;

  if (shouldSkipArgs(args)) {
    return;
  }
  if (isEnvFlagEnabled(env.CI)) {
    return;
  }
  if (!(dependencies.isInteractive ?? process.stderr.isTTY === true)) {
    return;
  }

  const spawnWorker = dependencies.spawnWorker ?? spawnDetachedAutoUpgradeWorker;
  spawnWorker();
}

/**
 * Worker body, run inside the detached child. Checks whether bshopify is
 * outdated and, when it is, fires a detached, unref'd install. Never throws:
 * every failure path degrades to a no-op so a background upgrade can't break
 * anything.
 */
export async function maybeAutoUpgrade(
  dependencies: AutoUpgradeTriggerDependencies = {},
): Promise<void> {
  const env = dependencies.env ?? process.env;
  const getEnabled = dependencies.getAutoUpgradeEnabled ?? getAutoUpgradeEnabled;
  if (!(await getEnabled())) {
    return;
  }

  const packageName = dependencies.packageName ?? packageInfo.name;
  const currentVersion = dependencies.currentVersion ?? packageInfo.version;
  const fetchLatest = dependencies.fetchLatestVersion ?? fetchLatestVersionFromNpm;
  const latest = await fetchLatestGracefully(fetchLatest, packageName);
  if (latest === undefined || !isNewerVersion(latest, currentVersion)) {
    return;
  }

  const readLast = dependencies.readLastAutoUpgradeAt ?? readLastAutoUpgradeAt;
  const now = dependencies.now ?? Date.now;
  const last = await readLast();
  if (last !== undefined && now() - last < autoUpgradeIntervalMs) {
    return;
  }

  const command = resolveUpdateCommand(
    packageName,
    dependencies.cliPath,
    dependencies.cwd,
    env,
  );
  const spawnDetached = dependencies.spawnDetached ?? spawnDetachedUpdateCommand;
  try {
    spawnDetached(command);
  } catch {
    return;
  }

  const writeLast = dependencies.writeLastAutoUpgradeAt ?? writeLastAutoUpgradeAt;
  try {
    await writeLast(now());
  } catch {
    // Best effort: a failed timestamp write only risks a retry next run.
  }
}

/**
 * Spawns a detached, unref'd worker that re-enters the CLI via a hidden
 * `__auto-upgrade` argument. The worker performs the version check and the
 * install off the main process, so the foreground CLI exits immediately.
 */
export function spawnDetachedAutoUpgradeWorker(
  spawnChild: typeof spawn = spawn,
): void {
  const cliEntry = process.argv[1];

  if (cliEntry === undefined) {
    return;
  }

  const child = spawnChild(process.execPath, [cliEntry, "__auto-upgrade"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

/**
 * Spawns a shell-style package-manager install as a detached, unref'd child
 * with ignored stdio, so it can neither block the CLI's exit nor keep the
 * event loop alive while it downloads.
 */
export function spawnDetachedUpdateCommand(
  command: string,
  spawnChild: typeof spawn = spawn,
): void {
  const child = spawnChild(command, {
    detached: true,
    shell: true,
    stdio: "ignore",
  });
  child.unref();
}

async function fetchLatestGracefully(
  fetchLatest: (packageName: string) => Promise<string | undefined>,
  packageName: string,
): Promise<string | undefined> {
  try {
    return await fetchLatest(packageName);
  } catch {
    return undefined;
  }
}

function shouldSkipArgs(args: string[]): boolean {
  const [command] = args;

  if (command === undefined) {
    return true;
  }
  if (isHelpOrVersionArg(command)) {
    return true;
  }
  return (
    command === "config" ||
    command === "upgrade" ||
    command === "help" ||
    command === "__auto-upgrade"
  );
}

function isHelpOrVersionArg(value: string): boolean {
  return value === "--help" || value === "-h" || value === "--version" || value === "-V" || value === "help";
}

function isEnvFlagEnabled(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== "0" && normalized !== "false";
}
