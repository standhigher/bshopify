import { ansi, colorize } from "./output";
import { packageInfo } from "./package-json";
import { isNewerVersion } from "./semver";
import {
  defaultUpdateCachePath,
  fetchLatestVersionFromNpm,
  readUpdateCache,
  resolveUpdateCommand,
  updateCheckTtlMs,
  writeUpdateCache,
  type UpdateCheckCache,
} from "./update-check";

export interface UpdateNoticeInput {
  currentVersion: string;
  latestVersion: string;
  updateCommand: string;
}

export interface UpdateNotifierDependencies {
  args?: string[];
  cliPath?: string;
  currentVersion?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetchLatestVersion?: (packageName: string) => Promise<string | undefined>;
  isInteractive?: boolean;
  now?: () => number;
  packageName?: string;
  readCache?: () => Promise<UpdateCheckCache | undefined>;
  scheduleRefresh?: (task: () => Promise<void>) => void;
  writeCache?: (cache: UpdateCheckCache) => Promise<void>;
  writeNotice?: (message: string) => void;
}

/**
 * Prints a one-shot upgrade hint when a cached npm `latest` is ahead of this
 * CLI. Registry refresh is scheduled in the background and never blocks a
 * command. Failures never fail the command.
 */
export async function notifyIfOutdated(
  dependencies: UpdateNotifierDependencies = {},
): Promise<void> {
  try {
    await notifyIfOutdatedUnsafe(dependencies);
  } catch {
    // Best effort: registry/cache problems must not break the command.
  }
}

export function formatUpdateNotice(input: UpdateNoticeInput): string {
  const headline = [
    colorize(colorize("Update available", ansi.yellow), ansi.bold),
    colorize(input.currentVersion, ansi.gray),
    colorize("→", ansi.gray),
    colorize(colorize(input.latestVersion, ansi.green), ansi.bold),
  ].join(" ");
  return ["", headline, `  ${colorize(input.updateCommand, ansi.cyan)}`, ""].join("\n");
}

function scheduleUpdateRefresh(task: () => Promise<void>): void {
  void task().catch(() => undefined);
}

async function notifyIfOutdatedUnsafe(
  dependencies: UpdateNotifierDependencies,
): Promise<void> {
  const env = dependencies.env ?? process.env;
  const args = dependencies.args ?? [];
  if (!(dependencies.isInteractive ?? process.stderr.isTTY === true) || shouldSkip(args, env)) {
    return;
  }

  const packageName = dependencies.packageName ?? packageInfo.name;
  const currentVersion = dependencies.currentVersion ?? packageInfo.version;
  const now = dependencies.now?.() ?? Date.now();
  const cachePath = defaultUpdateCachePath(env);
  const readCache = dependencies.readCache ?? (() => readUpdateCache(cachePath));
  const writeCache =
    dependencies.writeCache ?? ((cache: UpdateCheckCache) => writeUpdateCache(cachePath, cache));
  const cache = await readCache();
  let notifiedVersion = cache?.notifiedVersion;

  if (cache !== undefined && shouldNotify(cache, currentVersion)) {
    (dependencies.writeNotice ?? writeUpdateNotice)(
      formatUpdateNotice({
        currentVersion,
        latestVersion: cache.latestVersion,
        updateCommand: resolveUpdateCommand(
          packageName,
          dependencies.cliPath,
          dependencies.cwd,
          env,
        ),
      }),
    );
    notifiedVersion = cache.latestVersion;
    await writeCache({ ...cache, notifiedVersion });
  }

  if (cache === undefined || now - cache.checkedAt >= updateCheckTtlMs) {
    const scheduleRefresh = dependencies.scheduleRefresh ?? scheduleUpdateRefresh;
    scheduleRefresh(() =>
      refreshUpdateCache({
        fetchLatestVersion: dependencies.fetchLatestVersion,
        notifiedVersion,
        now,
        packageName,
        readCache,
        writeCache,
      }),
    );
  }
}

interface RefreshUpdateCacheInput {
  fetchLatestVersion?: (packageName: string) => Promise<string | undefined>;
  notifiedVersion?: string;
  now: number;
  packageName: string;
  readCache: () => Promise<UpdateCheckCache | undefined>;
  writeCache: (cache: UpdateCheckCache) => Promise<void>;
}

async function refreshUpdateCache(input: RefreshUpdateCacheInput): Promise<void> {
  const fetchLatest = input.fetchLatestVersion ?? fetchLatestVersionFromNpm;
  const fetchedVersion = await fetchLatest(input.packageName);
  if (fetchedVersion === undefined) {
    return;
  }

  const existing = await input.readCache();
  const notifiedVersion = existing?.notifiedVersion ?? input.notifiedVersion;
  await input.writeCache({
    checkedAt: input.now,
    latestVersion: fetchedVersion,
    ...(notifiedVersion === undefined ? {} : { notifiedVersion }),
  });
}

function shouldNotify(cache: UpdateCheckCache, currentVersion: string): boolean {
  return (
    isNewerVersion(cache.latestVersion, currentVersion) &&
    cache.notifiedVersion !== cache.latestVersion
  );
}

function shouldSkip(args: string[], env: NodeJS.ProcessEnv): boolean {
  if (args.length === 0 || args.some(isHelpOrVersionArg)) {
    return true;
  }
  return [env.CI, env.NO_UPDATE_NOTIFIER, env.BSHOPIFY_NO_UPDATE_NOTIFIER].some(isEnvFlagEnabled);
}

function isHelpOrVersionArg(arg: string): boolean {
  return arg === "--help" || arg === "-h" || arg === "--version" || arg === "-V" || arg === "help";
}

function isEnvFlagEnabled(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== "0" && normalized !== "false";
}

function writeUpdateNotice(message: string): void {
  console.error(message);
}
