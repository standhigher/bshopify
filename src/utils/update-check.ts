import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isRecord, readRecordString } from "./objects";
import { isInsidePath } from "./paths";

export interface UpdateCheckCache {
  checkedAt: number;
  latestVersion: string;
  notifiedVersion?: string;
}

export const updateCheckTimeoutMs = 1_500;
export const updateCheckTtlMs = 24 * 60 * 60 * 1000;

const npmLatestAccept =
  "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";

export function resolveUpdateCommand(
  packageName: string,
  cliPath = process.argv[1],
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const specifier = `${packageName}@latest`;
  const local = isLocalInstall(cliPath, cwd);
  const agent = env.npm_config_user_agent ?? "";

  if (agent.startsWith("pnpm/")) {
    return local ? `pnpm add -D ${specifier}` : `pnpm add -g ${specifier}`;
  }
  if (agent.startsWith("yarn/")) {
    return local ? `yarn add -D ${specifier}` : `yarn global add ${specifier}`;
  }

  return local ? `npm i -D ${specifier}` : `npm i -g ${specifier}`;
}

export async function fetchLatestVersionFromNpm(
  packageName: string,
  fetcher: typeof fetch = fetch,
): Promise<string | undefined> {
  const response = await fetcher(npmLatestUrl(packageName), {
    headers: { accept: npmLatestAccept },
    signal: AbortSignal.timeout(updateCheckTimeoutMs),
  });
  if (!response.ok) {
    return undefined;
  }
  const body = await response.json();
  return isRecord(body) ? readRecordString(body, "version") : undefined;
}

export function npmLatestUrl(packageName: string): string {
  return `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`;
}

export function defaultUpdateCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const cacheHome = readRecordString(env, "XDG_CACHE_HOME");
  if (cacheHome !== undefined) {
    return join(cacheHome, "bshopify", "update-check.json");
  }
  return join(homedir(), ".cache", "bshopify", "update-check.json");
}

export async function readUpdateCache(path: string): Promise<UpdateCheckCache | undefined> {
  try {
    return parseUpdateCache(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
}

export async function writeUpdateCache(path: string, cache: UpdateCheckCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cache)}\n`);
}

function isLocalInstall(cliPath: string | undefined, cwd: string): boolean {
  if (cliPath === undefined || cliPath.length === 0) {
    return false;
  }

  const resolvedCli = resolve(cliPath);
  let dir = resolve(cwd);

  while (true) {
    if (isInsidePath(join(dir, "node_modules"), resolvedCli)) {
      return true;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      return false;
    }

    dir = parent;
  }
}

function parseUpdateCache(value: unknown): UpdateCheckCache | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const latestVersion = readRecordString(value, "latestVersion");
  const checkedAt = value.checkedAt;
  if (latestVersion === undefined || typeof checkedAt !== "number" || !Number.isFinite(checkedAt)) {
    return undefined;
  }

  const notifiedVersion = readRecordString(value, "notifiedVersion");
  return notifiedVersion === undefined
    ? { checkedAt, latestVersion }
    : { checkedAt, latestVersion, notifiedVersion };
}
