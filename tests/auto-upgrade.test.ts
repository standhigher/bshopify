import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultAutoUpgradeConfigPath,
  getAutoUpgradeEnabled,
  readLastAutoUpgradeAt,
  setAutoUpgradeEnabled,
  writeLastAutoUpgradeAt,
} from "../src/upgrade/auto-upgrade-state";
import { runUpgrade } from "../src/upgrade/commands";
import {
  autoUpgradeIntervalMs,
  maybeAutoUpgrade,
  spawnDetachedAutoUpgradeWorker,
  spawnDetachedUpdateCommand,
  triggerAutoUpgrade,
  type AutoUpgradeTriggerDependencies,
} from "../src/upgrade/trigger";
import { createCliProgram, runCli } from "../src/main";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("defaultAutoUpgradeConfigPath", () => {
  it("prefers XDG_CONFIG_HOME and falls back to ~/.config", () => {
    expect(defaultAutoUpgradeConfigPath({ XDG_CONFIG_HOME: "/tmp/xdg-config" })).toBe(
      join("/tmp/xdg-config", "bshopify", "config.json"),
    );
    expect(defaultAutoUpgradeConfigPath({})).toContain(".config");
    expect(defaultAutoUpgradeConfigPath({})).toContain(join("bshopify", "config.json"));
  });
});

describe("auto-upgrade state", () => {
  it("defaults to enabled with a missing config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bshopify-config-"));
    tempDirs.push(dir);

    expect(await getAutoUpgradeEnabled(join(dir, "nested", "config.json"))).toBe(true);
  });

  it("round-trips on/off and preserves lastAutoUpgradeAt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bshopify-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config.json");

    await writeLastAutoUpgradeAt(123, configPath);
    await setAutoUpgradeEnabled(false, configPath);

    expect(await getAutoUpgradeEnabled(configPath)).toBe(false);
    expect(await readLastAutoUpgradeAt(configPath)).toBe(123);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      autoUpgradeEnabled: false,
      lastAutoUpgradeAt: 123,
    });

    await setAutoUpgradeEnabled(true, configPath);
    expect(await getAutoUpgradeEnabled(configPath)).toBe(true);
  });

  it("treats corrupt config as default and never throws on read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bshopify-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config.json");
    await writeFile(configPath, "{ not valid json");

    expect(await getAutoUpgradeEnabled(configPath)).toBe(true);
    expect(await readLastAutoUpgradeAt(configPath)).toBeUndefined();

    await setAutoUpgradeEnabled(false, configPath);
    expect(await getAutoUpgradeEnabled(configPath)).toBe(false);
  });

  it("throws when the config path cannot be written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bshopify-config-"));
    tempDirs.push(dir);
    const blockingFile = join(dir, "not-a-dir");
    await writeFile(blockingFile, "x");
    const configPath = join(blockingFile, "config.json");

    await expect(setAutoUpgradeEnabled(false, configPath)).rejects.toThrow();
  });
});

describe("config autoupgrade command", () => {
  it("enables, disables, and reports status", async () => {
    let enabled = true;
    const getAutoUpgradeEnabled = vi.fn(async () => enabled);
    const setAutoUpgradeEnabled = vi.fn(async (value: boolean) => {
      enabled = value;
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const parse = (args: string[]) =>
      createCliProgram({ getAutoUpgradeEnabled, setAutoUpgradeEnabled }).parseAsync(args);

    try {
      await parse(["node", "bshopify", "config", "autoupgrade", "on"]);
      expect(setAutoUpgradeEnabled).toHaveBeenCalledWith(true);
      expect(log.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
        "Auto-upgrade on. bshopify will update automatically after each command.",
      );

      log.mockClear();
      await parse(["node", "bshopify", "config", "autoupgrade", "status"]);
      expect(log.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
        "Auto-upgrade is currently on.",
      );

      log.mockClear();
      await parse(["node", "bshopify", "config", "autoupgrade", "off"]);
      expect(setAutoUpgradeEnabled).toHaveBeenCalledWith(false);
      expect(log.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
        "Auto-upgrade off. You'll need to run `bs upgrade` to update manually.",
      );

      log.mockClear();
      await parse(["node", "bshopify", "config", "autoupgrade", "status"]);
      expect(log.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
        "Auto-upgrade is currently off.",
      );
    } finally {
      log.mockRestore();
    }
  });
});

describe("upgrade command", () => {
  it("prints already-latest when current is not older", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let output = "";

    try {
      await runUpgrade({
        currentVersion: "0.1.10",
        fetchLatestVersion: async () => "0.1.10",
      });
      output = log.mock.calls.map(([message]) => String(message)).join("\n");
    } finally {
      log.mockRestore();
    }

    expect(output).toContain("You're on the latest version, 0.1.10, no need to upgrade!");
  });

  it("installs and prints success when a newer version exists", async () => {
    const runInstall = vi.fn(async () => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let output = "";

    try {
      await runUpgrade({
        currentVersion: "0.1.10",
        fetchLatestVersion: async () => "0.2.0",
        resolveInstallCommand: () => "npm i -g @standhigher/bshopify@latest",
        runInstall,
      });
      output = log.mock.calls.map(([message]) => String(message)).join("\n");
    } finally {
      log.mockRestore();
    }

    expect(runInstall).toHaveBeenCalledWith("npm i -g @standhigher/bshopify@latest");
    expect(output).toContain("bshopify upgraded to 0.2.0.");
  });

  it("degrades gracefully when the fetch fails", async () => {
    const runInstall = vi.fn(async () => undefined);

    await runUpgrade({
      currentVersion: "0.1.10",
      fetchLatestVersion: async () => {
        throw new Error("offline");
      },
      runInstall,
    });

    expect(runInstall).not.toHaveBeenCalled();
  });

  it("throws a friendly error when the install fails", async () => {
    await expect(
      runUpgrade({
        currentVersion: "0.1.10",
        fetchLatestVersion: async () => "0.2.0",
        resolveInstallCommand: () => "npm i -g @standhigher/bshopify@latest",
        runInstall: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("Upgrade failed: boom");
  });
});

describe("auto-upgrade worker (maybeAutoUpgrade)", () => {
  it("spawns a detached install and records the timestamp when outdated", async () => {
    const result = await runWorker();

    expect(result.fetches).toEqual(["@standhigher/bshopify"]);
    expect(result.spawned).toEqual(["npm i -g @standhigher/bshopify@latest"]);
    expect(result.wroteTimestamps).toEqual([1_000_000]);
  });

  it("skips when disabled", async () => {
    const result = await runWorker({ getAutoUpgradeEnabled: async () => false });

    expect(result.spawned).toEqual([]);
    expect(result.fetches).toEqual([]);
    expect(result.wroteTimestamps).toEqual([]);
  });

  it("skips when not newer or when the fetch fails", async () => {
    const results = await Promise.all([
      runWorker({ fetchLatestVersion: async () => "0.1.10" }),
      runWorker({
        fetchLatestVersion: async () => {
          throw new Error("offline");
        },
      }),
    ]);

    for (const result of results) {
      expect(result.spawned).toEqual([]);
      expect(result.wroteTimestamps).toEqual([]);
    }
  });

  it("skips when the last auto-upgrade ran within the throttle window", async () => {
    const result = await runWorker({
      now: () => 1_000_000,
      readLastAutoUpgradeAt: async () => 1_000_000 - (autoUpgradeIntervalMs - 1_000),
    });

    expect(result.spawned).toEqual([]);
    expect(result.wroteTimestamps).toEqual([]);
  });

  it("runs again once the throttle window has passed", async () => {
    const result = await runWorker({
      now: () => 1_000_000,
      readLastAutoUpgradeAt: async () => 1_000_000 - autoUpgradeIntervalMs,
    });

    expect(result.spawned).toHaveLength(1);
  });
});

describe("auto-upgrade foreground trigger (triggerAutoUpgrade)", () => {
  it("spawns the worker when eligible", () => {
    expect(runTriggerForeground()).toEqual({ workers: 1 });
  });

  it("skips help, version, config, upgrade, help, and empty args", () => {
    const cases: string[][] = [
      ["--help"],
      ["-h"],
      ["--version"],
      ["-V"],
      ["config", "autoupgrade", "status"],
      ["upgrade"],
      ["help"],
      [],
    ];

    for (const args of cases) {
      expect(runTriggerForeground({ args })).toEqual({ workers: 0 });
    }
  });

  it("skips in CI and non-TTY sessions", () => {
    expect(runTriggerForeground({ env: { CI: "true" } })).toEqual({ workers: 0 });
    expect(runTriggerForeground({ isInteractive: false })).toEqual({ workers: 0 });
  });

  it("does not touch config or the network when skipping early", () => {
    const spawnWorker = vi.fn();

    triggerAutoUpgrade({
      args: ["--help"],
      isInteractive: true,
      spawnWorker,
    });

    expect(spawnWorker).not.toHaveBeenCalled();
  });
});

describe("spawnDetachedUpdateCommand", () => {
  it("spawns detached, through the shell, with ignored stdio, and unrefs the child", () => {
    const unref = vi.fn();
    const spawnChild = vi.fn(() => ({ unref })) as unknown as typeof spawn;

    spawnDetachedUpdateCommand("npm i -g @standhigher/bshopify@latest", spawnChild);

    expect(spawnChild).toHaveBeenCalledWith("npm i -g @standhigher/bshopify@latest", {
      detached: true,
      shell: true,
      stdio: "ignore",
    });
    expect(unref).toHaveBeenCalled();
  });
});

describe("spawnDetachedAutoUpgradeWorker", () => {
  it("spawns a detached, unref'd worker that re-enters the CLI", () => {
    const unref = vi.fn();
    const spawnChild = vi.fn(() => ({ unref }));

    spawnDetachedAutoUpgradeWorker(spawnChild as unknown as typeof spawn);

    const [execPath, args, options] = spawnChild.mock.calls[0] as unknown as [
      string,
      string[],
      unknown,
    ];
    expect(execPath).toBe(process.execPath);
    expect(args).toHaveLength(2);
    expect(args[1]).toBe("__auto-upgrade");
    expect(options).toEqual({ detached: true, stdio: "ignore" });
    expect(unref).toHaveBeenCalled();
  });
});

describe("runCli auto-upgrade wiring", () => {
  it("fires the trigger after a local command", async () => {
    const trigger = vi.fn();

    await runCli(["node", "bshopify", "app", "guard"], {
      notifyIfOutdated: async () => undefined,
      triggerAutoUpgrade: trigger,
    });

    expect(trigger).toHaveBeenCalledWith({ args: ["app", "guard"] });
  });

  it("fires the trigger after a Shopify passthrough command", async () => {
    const trigger = vi.fn();

    await runCli(["node", "bshopify", "theme", "dev"], {
      notifyIfOutdated: async () => undefined,
      runShopifyCommand: async () => 0,
      triggerAutoUpgrade: trigger,
    });

    expect(trigger).toHaveBeenCalledWith({ args: ["theme", "dev"] });
  });

  it("runs the worker for the hidden __auto-upgrade command", async () => {
    const worker = vi.fn(async () => undefined);
    const notifier = vi.fn(async () => undefined);

    await runCli(["node", "bshopify", "__auto-upgrade"], {
      maybeAutoUpgrade: worker,
      notifyIfOutdated: notifier,
    });

    expect(worker).toHaveBeenCalled();
    expect(notifier).not.toHaveBeenCalled();
  });
});

interface WorkerResult {
  fetches: string[];
  spawned: string[];
  wroteTimestamps: number[];
}

async function runWorker(
  overrides: AutoUpgradeTriggerDependencies = {},
): Promise<WorkerResult> {
  const fetches: string[] = [];
  const spawned: string[] = [];
  const wroteTimestamps: number[] = [];

  await maybeAutoUpgrade({
    cliPath: "/usr/local/lib/node_modules/@standhigher/bshopify/dist/cli.js",
    currentVersion: "0.1.10",
    cwd: "/tmp/shopify-app",
    env: {},
    fetchLatestVersion: async (packageName) => {
      fetches.push(packageName);
      return "0.2.0";
    },
    getAutoUpgradeEnabled: async () => true,
    now: () => 1_000_000,
    packageName: "@standhigher/bshopify",
    readLastAutoUpgradeAt: async () => undefined,
    spawnDetached: (command) => {
      spawned.push(command);
    },
    writeLastAutoUpgradeAt: async (timestamp) => {
      wroteTimestamps.push(timestamp);
    },
    ...overrides,
  });

  return { fetches, spawned, wroteTimestamps };
}

function runTriggerForeground(
  overrides: AutoUpgradeTriggerDependencies = {},
): { workers: number } {
  let workers = 0;

  triggerAutoUpgrade({
    args: ["app", "dev"],
    env: {},
    isInteractive: true,
    spawnWorker: () => {
      workers += 1;
    },
    ...overrides,
  });

  return { workers };
}
