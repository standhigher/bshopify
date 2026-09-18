import { basename } from "node:path";
import { ansi, colorize } from "#/utils/output";

export type ShopifyCliConfigExclusiveFlag = "--client-id" | "--reset";

export function getShopifyCliConfigName(configFile: string): string {
  const fileName = basename(configFile);
  const withoutToml = fileName.endsWith(".toml") ? fileName.slice(0, -".toml".length) : fileName;

  if (withoutToml === "shopify.app") {
    return fileName;
  }

  return withoutToml.startsWith("shopify.app.")
    ? withoutToml.slice("shopify.app.".length)
    : withoutToml;
}

export function formatShopifyCliConfigArgs(configName: string | undefined): string[] {
  return configName === undefined || configName.length === 0 ? [] : ["--config", configName];
}

export function withoutShopifyCliConfigArgs(args: string[]): string[] {
  const result: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === undefined) {
      continue;
    }

    if (arg === "--config" || arg === "-c") {
      const next = args[index + 1];

      if (next !== undefined && !next.startsWith("-")) {
        index += 1;
      }

      continue;
    }

    if (arg.startsWith("--config=") || arg.startsWith("-c=")) {
      continue;
    }

    result.push(arg);
  }

  return result;
}

export function getShopifyCliConfigExclusiveFlag(
  args: string[],
): ShopifyCliConfigExclusiveFlag | undefined {
  for (const arg of withoutShopifyCliConfigArgs(args)) {
    const flag = toShopifyCliConfigExclusiveFlag(arg);

    if (flag !== undefined) {
      return flag;
    }
  }

  return undefined;
}

export function formatShopifyCliForwardedArgs(
  configFile: string,
  shopifyArgs: string[] = [],
): string[] {
  const forwardedArgs = withoutShopifyCliConfigArgs(shopifyArgs);

  if (forwardedArgs.length !== shopifyArgs.length) {
    console.warn(
      colorize(
        "Ignored --config / -c in extra Shopify args. Use bshopify --config <key> to select a configFiles environment.",
        ansi.yellow,
      ),
    );
  }

  // Shopify CLI marks `--reset` and `--client-id` exclusive with `--config`.
  // Forwarding both makes oclif reject the command:
  // `--config=dev cannot also be provided when using --reset`.
  if (getShopifyCliConfigExclusiveFlag(forwardedArgs) !== undefined) {
    const configFileName = basename(configFile);
    console.warn(
      colorize(
        `Omitted --config because Shopify CLI does not allow it with --reset / --client-id. Injections still used ${configFileName}; if Shopify CLI prompts for a config, select that file to stay on this environment.`,
        ansi.yellow,
      ),
    );
    return forwardedArgs;
  }

  return [
    ...formatShopifyCliConfigArgs(getShopifyCliConfigName(configFile)),
    ...forwardedArgs,
  ];
}

function toShopifyCliConfigExclusiveFlag(arg: string): ShopifyCliConfigExclusiveFlag | undefined {
  if (arg === "--reset" || arg === "--reset=true") {
    return "--reset";
  }

  if (arg === "--client-id" || arg.startsWith("--client-id=")) {
    return "--client-id";
  }

  return undefined;
}
