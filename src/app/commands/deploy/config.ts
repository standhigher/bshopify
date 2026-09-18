import { input, select } from "@inquirer/prompts";
import { getShopifyCliConfigExclusiveFlag } from "#/app/runner/shopify-args";
import { readRecordString } from "#/utils/objects";
import type { RunnerConfig, RunnerContextBase } from "#/app/runner/types";

export interface ProductionConfirmationOptions {
  confirmProduction: boolean;
  dryRun: boolean;
  yes: boolean;
}

export async function resolveConfigName(
  requestedConfigName: string | undefined,
  config: RunnerConfig,
): Promise<string> {
  const configNames = Object.keys(config.configFiles).filter(
    (configName) => config.configFiles[configName]?.trim(),
  );

  if (configNames.length === 0) {
    throw new Error("bshopify configFiles must define at least one deploy target.");
  }

  if (
    requestedConfigName !== undefined
    && config.configFiles[requestedConfigName]?.trim()
  ) {
    return requestedConfigName;
  }

  if (requestedConfigName !== undefined) {
    console.warn(
      `bshopify configFiles.${requestedConfigName} is not configured. Select a deploy config to continue.\n`,
    );
  }

  return select({
    choices: configNames.map((configName) => ({
      name: `${configName}  ${config.configFiles[configName]}`,
      value: configName,
    })),
    message: "Select deploy config:",
  });
}

export async function requireProductionConfirmation(
  configName: string,
  options: ProductionConfirmationOptions,
): Promise<void> {
  if (configName !== "production" || options.dryRun || options.confirmProduction) {
    return;
  }

  if (options.yes) {
    throw new Error("Production deploy requires --confirm-production.");
  }

  const answer = await input({
    message: 'Type "confirm" to continue:',
  });

  if (answer !== "confirm") {
    throw new Error("Production deploy requires --confirm-production.");
  }
}

export function assertDeployShopifyArgs(shopifyArgs: string[]): void {
  const exclusiveFlag = getShopifyCliConfigExclusiveFlag(shopifyArgs);

  if (exclusiveFlag === undefined) {
    return;
  }

  throw new Error(
    `Shopify CLI does not allow ${exclusiveFlag} together with --config. bshopify app deploy always selects a configFiles environment, so ${exclusiveFlag} is rejected. Reset with \`bshopify app dev --reset\`, then deploy with \`bshopify app deploy --config <key>\`.`,
  );
}

export function assertShopifyDeployConfig(context: RunnerContextBase): void {
  assertRequiredShopifyField(context.configPath, "client_id", readRecordString(context.appConfig, "client_id"));
  assertRequiredShopifyField(context.configPath, "name", readRecordString(context.appConfig, "name"));
  assertRequiredShopifyField(
    context.configPath,
    "application_url",
    readRecordString(context.appConfig, "application_url"),
  );
}

function assertRequiredShopifyField(
  configFile: string,
  fieldName: string,
  value: string | undefined,
): void {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${configFile} ${fieldName} is required.`);
  }
}
