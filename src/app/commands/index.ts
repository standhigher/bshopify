import { Command } from "commander";
import { clearProject, formatClearResult } from "./clear";
import { deployProject } from "./deploy";
import {
  formatInitResult,
  initProject,
} from "./init";
import { devProject } from "./dev";
import type { ClearOptions, ClearResult } from "./clear/types";
import type { InitOptions, InitResult } from "./init/types";
import type { DeployOptions, DevOptions } from "../runner/types";

interface ClearCommandOptions {
  cwd?: string;
  yes?: boolean;
}

interface DeployCommandOptions {
  config?: string;
  confirmProduction?: boolean;
  cwd?: string;
  dryRun?: boolean;
  yes?: boolean;
}

interface DevCommandOptions {
  config?: string;
  cwd?: string;
}

interface InitCommandOptions {
  check?: boolean;
  cwd?: string;
}

export interface AppCommandDependencies {
  clearProject?: (options?: ClearOptions) => Promise<ClearResult>;
  runDeploy?: (options?: DeployOptions) => Promise<number | void>;
  runDev?: (options?: DevOptions) => Promise<number | void>;
  initProject?: (options?: InitOptions) => Promise<InitResult>;
}

const localAppCommands = new Set(["clear", "deploy", "dev", "guard", "init"]);

export function createAppCommand(dependencies: AppCommandDependencies = {}): Command {
  const runClear = dependencies.clearProject ?? clearProject;
  const runDeploy = dependencies.runDeploy ?? deployProject;
  const runDev = dependencies.runDev ?? devProject;
  const initializeProject = dependencies.initProject ?? initProject;
  const appCommand = new Command("app").description(
    "Standhigher wrappers for Shopify app commands.",
  );
  appCommand.addHelpCommand(false);

  appCommand
    .command("clear")
    .description("Remove all bshopify-generated files from the current app project.")
    .option("--cwd <path>", "project directory to clear")
    .option("--yes", "skip the interactive removal confirmation")
    .action(async (options: ClearCommandOptions) => {
      const result = await runClear({
        cwd: options.cwd,
        yes: options.yes === true,
      });
      console.log(formatClearResult(result));

      if (result.errors.length > 0) {
        process.exitCode = 1;
      }
    });

  appCommand
    .command("init")
    .description("Initialize bshopify in the current Shopify app project.")
    .option("--check", "only check project readiness without writing files")
    .option("--cwd <path>", "project directory to initialize")
    .action(async (options: InitCommandOptions) => {
      const result = await initializeProject(toInitOptions(options));
      console.log(formatInitResult(result));

      if (result.errors.length > 0) {
        process.exitCode = 1;
      }
    });

  appCommand
    .command("deploy")
    .description("Deploy a Shopify app with temporary extension config injection.")
    .option("-c, --config <name>", "bshopify configFiles key to deploy")
    .option("--cwd <path>", "project directory to deploy")
    .option("--dry-run", "prepare and validate deploy injections without calling Shopify CLI")
    .option("--yes", "skip interactive deploy confirmation")
    .option("--confirm-production", "allow non-interactive production deploys")
    .allowUnknownOption(true)
    .argument("[shopifyArgs...]", "extra arguments passed to Shopify CLI after --")
    .action(async (shopifyArgs: string[], options: DeployCommandOptions) => {
      const exitCode = await runDeploy(toDeployOptions(options, shopifyArgs));

      if (typeof exitCode === "number") {
        process.exitCode = exitCode;
      }
    });

  appCommand
    .command("dev")
    .description("Run Shopify app dev with temporary extension config injection.")
    .option("-c, --config <name>", "bshopify configFiles key to run")
    .option("--cwd <path>", "project directory to run")
    .allowUnknownOption(true)
    .argument("[shopifyArgs...]", "extra arguments passed to Shopify CLI after --")
    .action(async (shopifyArgs: string[], options: DevCommandOptions) => {
      const exitCode = await runDev(toDevOptions(options, shopifyArgs));

      if (typeof exitCode === "number") {
        process.exitCode = exitCode;
      }
    });

  appCommand
    .command("guard")
    .description("Prevent unsafe injected values or active locks from being committed.")
    .action(() => undefined);

  return appCommand;
}

function toDeployOptions(
  options: DeployCommandOptions,
  shopifyArgs: string[] | undefined,
): DeployOptions {
  return {
    configName: options.config,
    confirmProduction: options.confirmProduction === true,
    cwd: options.cwd,
    dryRun: options.dryRun === true,
    shopifyArgs: shopifyArgs ?? [],
    yes: options.yes === true,
  };
}

function toDevOptions(
  options: DevCommandOptions,
  shopifyArgs: string[] | undefined,
): DevOptions {
  return {
    configName: options.config ?? "dev",
    cwd: options.cwd,
    shopifyArgs: shopifyArgs ?? [],
  };
}

export function shouldHandleAppCommandLocally(args: string[]): boolean {
  const [subcommand] = args;

  return (
    subcommand === undefined ||
    isHelpOption(subcommand) ||
    localAppCommands.has(subcommand)
  );
}

export function shouldHandleAppHelpLocally(args: string[]): boolean {
  const [subcommand] = args;

  return subcommand === undefined || localAppCommands.has(subcommand);
}

function toInitOptions(options: InitCommandOptions): InitOptions {
  return {
    check: options.check,
    cwd: options.cwd,
  };
}

function isHelpOption(value: string): boolean {
  return value === "--help" || value === "-h";
}
