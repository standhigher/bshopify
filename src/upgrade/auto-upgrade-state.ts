import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isRecord, readRecordString } from "#/utils/objects";

/**
 * Persisted bshopify global configuration, stored as a small JSON document
 * under the XDG config directory (falling back to `~/.config`). The shape is
 * intentionally extensible: new keys can be added without breaking older
 * files, and missing keys fall back to their defaults.
 */
export interface BshopifyConfig {
  autoUpgradeEnabled?: boolean;
  lastAutoUpgradeAt?: number;
}

export function defaultAutoUpgradeConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configHome = readRecordString(env, "XDG_CONFIG_HOME");

  return join(configHome ?? join(homedir(), ".config"), "bshopify", "config.json");
}

/** True when auto-upgrade is enabled; defaults to `true` when unset or unreadable. */
export async function getAutoUpgradeEnabled(
  configPath: string = defaultAutoUpgradeConfigPath(),
): Promise<boolean> {
  return (await readConfig(configPath)).autoUpgradeEnabled ?? true;
}

export async function setAutoUpgradeEnabled(
  value: boolean,
  configPath: string = defaultAutoUpgradeConfigPath(),
): Promise<void> {
  await updateConfig(configPath, (config) => ({ ...config, autoUpgradeEnabled: value }));
}

export async function readLastAutoUpgradeAt(
  configPath: string = defaultAutoUpgradeConfigPath(),
): Promise<number | undefined> {
  return (await readConfig(configPath)).lastAutoUpgradeAt;
}

export async function writeLastAutoUpgradeAt(
  timestamp: number,
  configPath: string = defaultAutoUpgradeConfigPath(),
): Promise<void> {
  await updateConfig(configPath, (config) => ({ ...config, lastAutoUpgradeAt: timestamp }));
}

// Serializes read-modify-write updates so a background auto-upgrade timestamp
// write cannot clobber a concurrent `config autoupgrade on|off` write (both
// read the file, mutate one key, and write the whole document back).
let configWriteChain: Promise<unknown> = Promise.resolve();

function updateConfig(
  configPath: string,
  update: (config: BshopifyConfig) => BshopifyConfig,
): Promise<void> {
  const run = configWriteChain.then(async () => {
    const config = await readConfig(configPath);
    await writeConfig(configPath, update(config));
  });
  configWriteChain = run.catch(() => undefined);
  return run;
}

async function readConfig(configPath: string): Promise<BshopifyConfig> {
  try {
    const content = await readFile(configPath, "utf8");
    return parseConfig(JSON.parse(content) as unknown);
  } catch {
    return {};
  }
}

async function writeConfig(configPath: string, config: BshopifyConfig): Promise<void> {
  const directory = dirname(configPath);
  await mkdir(directory, { recursive: true });

  // Atomic-ish write: write to a sibling temp file then rename, so a crash
  // mid-write never leaves a truncated config behind.
  const tempPath = join(directory, `.config.json.${process.pid}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(config, undefined, 2)}\n`);
  await rename(tempPath, configPath);
}

function parseConfig(value: unknown): BshopifyConfig {
  if (!isRecord(value)) {
    return {};
  }

  return {
    ...(typeof value.autoUpgradeEnabled === "boolean"
      ? { autoUpgradeEnabled: value.autoUpgradeEnabled }
      : {}),
    ...(typeof value.lastAutoUpgradeAt === "number" && Number.isFinite(value.lastAutoUpgradeAt)
      ? { lastAutoUpgradeAt: value.lastAutoUpgradeAt }
      : {}),
  };
}
