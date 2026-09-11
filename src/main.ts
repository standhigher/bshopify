import { Command } from "commander";
import { execa, type Options } from "execa";
import {
  createAppCommand,
  shouldHandleAppCommandLocally,
  shouldHandleAppHelpLocally,
  type AppCommandDependencies,
} from "./app/commands";
import { packageInfo } from "./utils/package-json";
import { notifyIfOutdated } from "./utils/update-notifier";

export type ShopifyCommandRunner = (args: string[]) => Promise<number | void>;
export type ProcessRunner = (
  file: string,
  args: string[],
  options: Options,
) => Promise<{ exitCode?: number }>;

export interface CliDependencies extends AppCommandDependencies {
  notifyIfOutdated?: typeof notifyIfOutdated;
  runShopifyCommand?: ShopifyCommandRunner;
}

export function createCliProgram(dependencies: CliDependencies = {}): Command {
  const program = new Command();

  program
    .name("bshopify")
    .description("BestFulfill Shopify App Runner")
    .version(packageInfo.version)
    .addHelpCommand(false)
    .showHelpAfterError();

  program.addCommand(createAppCommand(dependencies));

  return program;
}

export async function runCli(
  argv: string[] = process.argv,
  dependencies: CliDependencies = {},
): Promise<void> {
  const args = argv.slice(2);
  const checkForUpdate = dependencies.notifyIfOutdated ?? notifyIfOutdated;
  await checkForUpdate({ args });

  if (shouldHandleLocally(args)) {
    await createCliProgram(dependencies).parseAsync(argv);
    return;
  }

  const runShopify = dependencies.runShopifyCommand ?? runShopifyCommand;
  const exitCode = await runShopify(args);

  if (typeof exitCode === "number") {
    process.exitCode = exitCode;
  }
}

export async function runShopifyCommand(
  args: string[],
  runner: ProcessRunner = execa,
): Promise<number> {
  try {
    const result = await runner("shopify", args, {
      localDir: process.cwd(),
      preferLocal: true,
      stdio: "inherit",
    });

    return result.exitCode ?? 0;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(
        "Shopify CLI is not available. Install it globally with npm install -g @shopify/cli@latest, or add @shopify/cli to this project.",
      );
    }

    throw error;
  }
}

function shouldHandleLocally(args: string[]): boolean {
  const [command] = args;

  if (command === undefined || isHelpOrVersionOption(command)) {
    return true;
  }

  if (command === "help") {
    return shouldHandleHelpLocally(args.slice(1));
  }

  if (command !== "app") {
    return false;
  }

  return shouldHandleAppCommandLocally(args.slice(1));
}

function isHelpOrVersionOption(value: string): boolean {
  return isHelpOption(value) || value === "--version" || value === "-V";
}

function shouldHandleHelpLocally(args: string[]): boolean {
  const [command] = args;

  if (command === undefined) {
    return true;
  }

  if (command !== "app") {
    return false;
  }

  return shouldHandleAppHelpLocally(args.slice(1));
}

function isHelpOption(value: string): boolean {
  return value === "--help" || value === "-h";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
