import { Command } from "commander";
import { execa } from "execa";
import { packageInfo } from "#/utils/package-json";
import { isNewerVersion } from "#/utils/semver";
import { fetchLatestVersionFromNpm, resolveUpdateCommand } from "#/utils/update-check";
import {
  getAutoUpgradeEnabled,
  setAutoUpgradeEnabled,
} from "./auto-upgrade-state";

export interface ConfigAutoupgradeDependencies {
  getAutoUpgradeEnabled?: () => Promise<boolean>;
  setAutoUpgradeEnabled?: (value: boolean) => Promise<void>;
}

export interface UpgradeDependencies {
  currentVersion?: string;
  fetchLatestVersion?: (packageName: string) => Promise<string | undefined>;
  resolveInstallCommand?: () => string;
  runInstall?: (command: string) => Promise<void>;
}

export function createConfigCommand(
  dependencies: ConfigAutoupgradeDependencies = {},
): Command {
  const getEnabled = dependencies.getAutoUpgradeEnabled ?? getAutoUpgradeEnabled;
  const setEnabled = dependencies.setAutoUpgradeEnabled ?? setAutoUpgradeEnabled;

  const configCommand = new Command("config").description("Configure bshopify behavior.");
  configCommand.addHelpCommand(false);

  const autoupgradeCommand = configCommand
    .command("autoupgrade")
    .description("Enable or disable automatic upgrades.");
  autoupgradeCommand.addHelpCommand(false);

  autoupgradeCommand
    .command("on")
    .description("Enable automatic upgrades.")
    .action(async () => {
      await persistEnabled(setEnabled, true);
      console.log("Auto-upgrade on. bshopify will update automatically after each command.");
    });

  autoupgradeCommand
    .command("off")
    .description("Disable automatic upgrades.")
    .action(async () => {
      await persistEnabled(setEnabled, false);
      console.log("Auto-upgrade off. You'll need to run `bs upgrade` to update manually.");
    });

  autoupgradeCommand
    .command("status")
    .description("Print the current automatic upgrade state.")
    .action(async () => {
      const enabled = await getEnabled();
      console.log(enabled ? "Auto-upgrade is currently on." : "Auto-upgrade is currently off.");
    });

  return configCommand;
}

export function createUpgradeCommand(dependencies: UpgradeDependencies = {}): Command {
  const upgradeCommand = new Command("upgrade").description(
    "Upgrade bshopify to the latest version.",
  );
  upgradeCommand.addHelpCommand(false);

  upgradeCommand.action(async () => {
    await runUpgrade(dependencies);
  });

  return upgradeCommand;
}

/** Fetches the latest version and installs it when the current version is older. */
export async function runUpgrade(dependencies: UpgradeDependencies = {}): Promise<void> {
  const currentVersion = dependencies.currentVersion ?? packageInfo.version;
  const fetchLatest = dependencies.fetchLatestVersion ?? fetchLatestVersionFromNpm;
  const resolveInstall = dependencies.resolveInstallCommand ?? defaultResolveInstallCommand;
  const runInstall = dependencies.runInstall ?? runUpgradeInstall;

  const latest = await fetchLatestGracefully(fetchLatest, packageInfo.name);
  if (latest === undefined) {
    return;
  }

  if (!isNewerVersion(latest, currentVersion)) {
    console.log(`You're on the latest version, ${currentVersion}, no need to upgrade!`);
    return;
  }

  try {
    await runInstall(resolveInstall());
  } catch (error) {
    throw new Error(`Upgrade failed: ${errorMessage(error)}`);
  }

  console.log(`bshopify upgraded to ${latest}.`);
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

function defaultResolveInstallCommand(): string {
  return resolveUpdateCommand(packageInfo.name);
}

async function runUpgradeInstall(command: string): Promise<void> {
  await execa(command, { shell: true, stdio: "inherit" });
}

async function persistEnabled(
  setEnabled: (value: boolean) => Promise<void>,
  value: boolean,
): Promise<void> {
  try {
    await setEnabled(value);
  } catch (error) {
    throw new Error(`Could not save the auto-upgrade setting: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
