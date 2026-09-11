import { join } from "node:path";
import { confirm } from "@inquirer/prompts";
import { bshopifyStateDir } from "#/app/runner/constants";
import {
  formatShopifyCliForwardedArgs,
  getShopifyCliConfigName,
  loadRunnerConfig,
} from "#/app/runner/config";
import { createRunnerContext } from "#/app/runner/context";
import { printEnvFilesOutput } from "#/app/runner/env-files";
import {
  findManagedEntries,
  formatSkippedPlaceholderEntries,
  loadManagedEntryHooks,
  preparePlans,
  runAfterDeployHooks,
  runBeforeDeployHooks,
  runOnErrorHooks,
  validatePlans,
} from "#/extension/entries";
import {
  applyInjections,
  assertNoUnresolvedPlaceholders,
  formatAppliedInjections,
  formatInjectionWarnings,
} from "#/app/runner/injections";
import { withGitIndexLockGuard } from "#/app/runner/git-index-lock-guard";
import { refreshGitIndexForRestoredFiles } from "#/app/runner/git-refresh";
import { currentInterruptSignal, isActiveInterrupt, runInterruptible } from "#/app/runner/interrupt";
import { acquireLock } from "#/app/runner/lock";
import { runShopifyCommand as runDefaultShopifyCommand } from "#/app/runner/shopify";
import {
  createFileTransaction,
  restoreFileTransactionJournal,
} from "#/app/runner/transaction";
import {
  assertShopifyDeployConfig,
  requireProductionConfirmation,
  resolveConfigName,
} from "./config";
import { formatDeploySummary, formatRestoreNotice } from "./summary";
import type { AppliedInjection, InjectionWarning } from "#/app/runner/injections";
import type {
  DeployOptions,
  ShopifyCommandRunner,
} from "#/app/runner/types";

export async function deployProject(options: DeployOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const config = await loadRunnerConfig(cwd);
  const configName = await resolveConfigName(options.configName, config);
  const dryRun = options.dryRun === true;

  const { context, envFileSummary, envFileWarnings } = await createRunnerContext({
    configName,
    cwd,
    runnerConfig: config,
  });
  printEnvFilesOutput(envFileSummary, envFileWarnings);
  assertShopifyDeployConfig(context);
  const lock = await acquireLock(cwd, bshopifyStateDir);
  const transactionPath = join(cwd, bshopifyStateDir, "extension-prepare.transaction.json");

  try {
    return await withGitIndexLockGuard(cwd, async () => {
      if (lock.recoveredStaleLock) {
        const restoredFiles = await restoreFileTransactionJournal(transactionPath);
        await refreshGitIndexForRestoredFiles(cwd, restoredFiles);

        console.warn(
          restoredFiles.length > 0
            ? "Detected a stale Shopify extension prepare lock. Restored previous injections and cleaned it automatically."
            : "Detected a stale Shopify extension prepare lock. Cleaned it automatically.",
        );
      }

      const entries = await findManagedEntries(cwd, {
        entryFileName: config.entryFileName,
        extensionsRoot: config.extensionsRoot,
      });
      const hooks = await loadManagedEntryHooks(entries, { skipPlaceholders: true });
      printSkippedPlaceholderEntries(entries.length - hooks.length);
      const plans = await preparePlans(context, hooks);
      await validatePlans(context, plans);

      console.log(formatDeploySummary(context, plans.map((plan) => plan.entry), dryRun));

      await requireProductionConfirmation(configName, {
        confirmProduction: options.confirmProduction === true,
        dryRun,
        yes: options.yes === true,
      });

      if (!dryRun && options.yes !== true) {
        const shouldDeploy = await confirm({
          default: false,
          message: `Deploy ${context.env} with ${context.configPath}?`,
        });

        if (!shouldDeploy) {
          return 0;
        }
      }

      return await runInterruptible(async () => {
        const transaction = await createFileTransaction(transactionPath);
        const appliedInjections: AppliedInjection[] = [];
        const injectionWarnings: InjectionWarning[] = [];

        try {
          for (const plan of plans) {
            const result = await applyInjections(cwd, plan, transaction, {
              mode: dryRun ? "dryRun" : "deploy",
              restoreMarkers: false,
            });
            appliedInjections.push(...result.applied);
            injectionWarnings.push(...result.warnings);
          }

          const warningSummary = formatInjectionWarnings(injectionWarnings, { cwd });

          if (warningSummary !== undefined) {
            console.warn(warningSummary);
          }

          const injectionSummary = formatAppliedInjections(appliedInjections, {
            configName: getShopifyCliConfigName(context.configPath),
            cwd,
            mode: dryRun ? "dryRun" : "deploy",
          });

          if (injectionSummary !== undefined) {
            console.log(injectionSummary);
          }

          if (config.failOnUnresolvedPlaceholders) {
            await assertNoUnresolvedPlaceholders(cwd, config.extensionsRoot);
          }

          await refreshGitIndexForRestoredFiles(
            cwd,
            appliedInjections.map((injection) => injection.path),
          );

          if (currentInterruptSignal()?.aborted) {
            return 0;
          }

          await runBeforeDeployHooks(context, plans);

          let exitCode = 0;

          if (!dryRun) {
            // `__entry.js` files are not hidden during deploy: they are harmless
            // stray files to Shopify (extra files neither fail nor block a
            // deploy), and the injected target files are restored by the
            // transaction below.
            const runShopifyCommand = createShopifyDeployRunner(options.runShopifyCommand, cwd);
            console.log("");
            exitCode =
              (await runShopifyCommand([
                "app",
                "deploy",
                ...formatShopifyCliForwardedArgs(context.configPath, options.shopifyArgs ?? []),
              ])) ?? 0;
          }

          await runAfterDeployHooks(context, plans, {
            deployed: !dryRun,
            dryRun,
            exitCode,
          });

          return exitCode;
        } catch (error) {
          if (!isActiveInterrupt(error)) {
            await runOnErrorHooks(context, plans, error);
          }

          throw error;
        } finally {
          const restoredFiles = await transaction.restore();
          await refreshGitIndexForRestoredFiles(cwd, restoredFiles);

          if (appliedInjections.length > 0) {
            console.log(formatRestoreNotice(dryRun));
          }
        }
      });
    });
  } finally {
    await lock.release();
  }
}

function printSkippedPlaceholderEntries(count: number): void {
  const message = formatSkippedPlaceholderEntries(count);

  if (message !== undefined) {
    console.log(message);
  }
}

function createShopifyDeployRunner(
  runShopifyCommand: ShopifyCommandRunner | undefined,
  cwd: string,
): ShopifyCommandRunner {
  return runShopifyCommand ?? ((args) => runDefaultShopifyCommand(args, cwd));
}
