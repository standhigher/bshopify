import { join } from "node:path";
import { bshopifyStateDir } from "#/app/runner/constants";
import {
  formatShopifyCliConfigArgs,
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
  validatePlans,
} from "#/extension/entries";
import {
  applyInjections,
  assertNoUnresolvedPlaceholders,
  formatAppliedInjections,
  formatInjectionWarnings,
} from "#/app/runner/injections";
import { acquireLock } from "#/app/runner/lock";
import { refreshGitIndexForRestoredFiles } from "#/app/runner/git-refresh";
import { currentInterruptSignal, runInterruptible } from "#/app/runner/interrupt";
import { runShopifyCommand as runDefaultShopifyCommand } from "#/app/runner/shopify";
import {
  createFileTransaction,
  restoreFileTransactionJournal,
} from "#/app/runner/transaction";
import { ansi, colorize } from "#/utils/output";
import type { AppliedInjection, InjectionWarning } from "#/app/runner/injections";
import type { DevOptions } from "#/app/runner/types";

export async function devProject(options: DevOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const configName = options.configName ?? "dev";
  const shopifyArgs = options.shopifyArgs ?? [];
  const shouldForwardCliConfig = options.configName !== undefined || shopifyArgs.length === 0;
  const config = await loadRunnerConfig(cwd);
  const { context, envFileSummary, envFileWarnings } = await createRunnerContext({
    configName,
    cwd,
    runnerConfig: config,
  });
  printEnvFilesOutput(envFileSummary, envFileWarnings);
  const lock = await acquireLock(cwd, bshopifyStateDir);
  const transactionPath = join(cwd, bshopifyStateDir, "extension-prepare.transaction.json");

  try {
    if (lock.recoveredStaleLock) {
      const restoredFiles = await restoreFileTransactionJournal(transactionPath);

      if (restoredFiles.length > 0) {
        await refreshGitIndexForRestoredFiles(cwd, restoredFiles);
      }

      console.warn(
        restoredFiles.length > 0
          ? "Detected a stale Shopify extension prepare lock, likely from a killed dev process. Restored previous injections and cleaned it automatically."
          : "Detected a stale Shopify extension prepare lock, likely from a killed dev process. Cleaned it automatically.",
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

    return await runInterruptible(async () => {
      const transaction = await createFileTransaction(transactionPath);
      const appliedInjections: AppliedInjection[] = [];
      const injectionWarnings: InjectionWarning[] = [];

      try {
        for (const plan of plans) {
          const result = await applyInjections(cwd, plan, transaction, {
            mode: "dev",
            restoreMarkers: config.restoreMarkers,
          });
          appliedInjections.push(...result.applied);
          injectionWarnings.push(...result.warnings);
        }

        const warningSummary = formatInjectionWarnings(injectionWarnings, { cwd });

        if (warningSummary !== undefined) {
          console.warn(warningSummary);
        }

        const injectionSummary = formatAppliedInjections(appliedInjections, {
          configName: shouldForwardCliConfig ? getShopifyCliConfigName(context.configPath) : undefined,
          cwd,
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

        const runShopifyCommand =
          options.runShopifyCommand ?? ((args) => runDefaultShopifyCommand(args, cwd));
        const exitCode = await runShopifyCommand([
          "app",
          "dev",
          ...(shouldForwardCliConfig ? formatShopifyCliConfigArgs(getShopifyCliConfigName(context.configPath)) : []),
          ...shopifyArgs,
        ]);

        return exitCode ?? 0;
      } finally {
        const restoredFiles = await transaction.restore();
        await refreshGitIndexForRestoredFiles(cwd, restoredFiles);

        if (appliedInjections.length > 0) {
          console.log(formatRestoreNotice());
        }
      }
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

function formatRestoreNotice(): string {
  return `\n${colorize(colorize("Dev extension files restored.", ansi.cyan), ansi.bold)}\n`;
}
