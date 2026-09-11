import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compareSemver, isNewerVersion } from "../src/utils/semver";
import {
  defaultUpdateCachePath,
  fetchLatestVersionFromNpm,
  npmLatestUrl,
  resolveUpdateCommand,
  type UpdateCheckCache,
} from "../src/utils/update-check";
import {
  formatUpdateNotice,
  notifyIfOutdated,
  type UpdateNotifierDependencies,
} from "../src/utils/update-notifier";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true })));
});

interface NotifyHarness {
  fetches: string[];
  notices: string[];
  scheduled: Array<() => Promise<void>>;
  writes: UpdateCheckCache[];
}

async function notify(
  overrides: UpdateNotifierDependencies = {},
): Promise<NotifyHarness> {
  const fetches: string[] = [];
  const notices: string[] = [];
  const scheduled: Array<() => Promise<void>> = [];
  const writes: UpdateCheckCache[] = [];

  await notifyIfOutdated({
    args: ["app", "dev"],
    cliPath: "/usr/local/lib/node_modules/@standhigher/bshopify/dist/cli.js",
    currentVersion: "0.1.6",
    cwd: "/tmp/shopify-app",
    env: {},
    fetchLatestVersion: async (packageName) => {
      fetches.push(packageName);
      return "0.1.6";
    },
    isInteractive: true,
    now: () => 1_000,
    packageName: "@standhigher/bshopify",
    readCache: async () => undefined,
    scheduleRefresh: (task) => {
      scheduled.push(task);
    },
    writeCache: async (cache) => {
      writes.push(cache);
    },
    writeNotice: (message) => {
      notices.push(message);
    },
    ...overrides,
  });

  return { fetches, notices, scheduled, writes };
}

describe("compareSemver", () => {
  it("orders major.minor.patch and treats stable as newer than the same core prerelease", () => {
    expect(compareSemver("0.2.0", "0.1.9")).toBe(1);
    expect(compareSemver("0.1.6", "0.1.6")).toBe(0);
    expect(compareSemver("0.1.5", "0.1.6")).toBe(-1);
    expect(compareSemver("0.2.0", "0.2.0-beta.1")).toBe(1);
    expect(compareSemver("0.2.0-beta.1", "0.2.0")).toBe(-1);
    expect(compareSemver("0.2.0-alpha", "0.2.0-beta")).toBe(-1);
    expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compareSemver("1.0.0-rc.1", "1.0.0-rc.1.2")).toBe(-1);
    expect(compareSemver("v0.2.0-beta.1", "0.1.9")).toBe(1);
    expect(isNewerVersion("0.1.7", "0.1.6")).toBe(true);
    expect(isNewerVersion("0.2.0", "0.2.0-beta.1")).toBe(true);
    expect(isNewerVersion("0.2.0-beta.1", "0.2.0")).toBe(false);
    expect(isNewerVersion("0.1.6", "0.1.6")).toBe(false);
  });
});

describe("formatUpdateNotice", () => {
  it("renders current and latest versions with the upgrade command", () => {
    expect(
      formatUpdateNotice({
        currentVersion: "0.1.6",
        latestVersion: "0.1.7",
        updateCommand: "npm i -D @standhigher/bshopify@latest",
      }),
    ).toBe(
      [
        "",
        "\u001B[1m\u001B[33mUpdate available\u001B[39m\u001B[22m \u001B[90m0.1.6\u001B[39m \u001B[90m→\u001B[39m \u001B[1m\u001B[32m0.1.7\u001B[39m\u001B[22m",
        "  \u001B[36mnpm i -D @standhigher/bshopify@latest\u001B[39m",
        "",
      ].join("\n"),
    );
  });
});

describe("resolveUpdateCommand", () => {
  it("suggests a local install when the CLI is running from node_modules", () => {
    const cwd = "/tmp/shopify-app";

    expect(
      resolveUpdateCommand(
        "@standhigher/bshopify",
        join(cwd, "node_modules", "@standhigher", "bshopify", "dist", "cli.js"),
        cwd,
        {},
      ),
    ).toBe("npm i -D @standhigher/bshopify@latest");
  });

  it("suggests a local install when the package is hoisted to a parent node_modules", () => {
    const repo = "/tmp/repo";
    const cwd = join(repo, "apps", "shopify-app");

    expect(
      resolveUpdateCommand(
        "@standhigher/bshopify",
        join(repo, "node_modules", "@standhigher", "bshopify", "dist", "cli.js"),
        cwd,
        {},
      ),
    ).toBe("npm i -D @standhigher/bshopify@latest");
  });

  it("suggests a local install for a pnpm nested node_modules path", () => {
    const cwd = "/tmp/shopify-app";

    expect(
      resolveUpdateCommand(
        "@standhigher/bshopify",
        join(
          cwd,
          "node_modules",
          ".pnpm",
          "@standhigher+bshopify@0.1.6",
          "node_modules",
          "@standhigher",
          "bshopify",
          "dist",
          "cli.js",
        ),
        cwd,
        {},
      ),
    ).toBe("npm i -D @standhigher/bshopify@latest");
  });

  it("suggests a global install otherwise", () => {
    expect(
      resolveUpdateCommand(
        "@standhigher/bshopify",
        "/usr/local/lib/node_modules/@standhigher/bshopify/dist/cli.js",
        "/tmp/shopify-app",
        {},
      ),
    ).toBe("npm i -g @standhigher/bshopify@latest");
  });

  it("uses the package manager from npm_config_user_agent", () => {
    const cwd = "/tmp/shopify-app";
    const cliPath = join(cwd, "node_modules", "@standhigher", "bshopify", "dist", "cli.js");

    expect(
      resolveUpdateCommand("@standhigher/bshopify", cliPath, cwd, {
        npm_config_user_agent: "pnpm/9.0.0 npm/? node/v22.12.0",
      }),
    ).toBe("pnpm add -D @standhigher/bshopify@latest");
    expect(
      resolveUpdateCommand(
        "@standhigher/bshopify",
        "/usr/local/lib/node_modules/@standhigher/bshopify/dist/cli.js",
        cwd,
        { npm_config_user_agent: "yarn/1.22.22 npm/? node/v22.12.0" },
      ),
    ).toBe("yarn global add @standhigher/bshopify@latest");
  });
});

describe("npm latest lookup", () => {
  it("encodes the scoped package name and reads the version field", async () => {
    const fetcher = vi.fn(async () => ({
      json: async () => ({ version: "0.2.0" }),
      ok: true,
    }));

    await expect(
      fetchLatestVersionFromNpm(
        "@standhigher/bshopify",
        fetcher as unknown as typeof fetch,
      ),
    ).resolves.toBe("0.2.0");
    expect(fetcher).toHaveBeenCalledWith(
      "https://registry.npmjs.org/%40standhigher%2Fbshopify/latest",
      expect.objectContaining({
        headers: { accept: expect.stringContaining("application/json") },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(npmLatestUrl("@standhigher/bshopify")).toBe(
      "https://registry.npmjs.org/%40standhigher%2Fbshopify/latest",
    );
  });

  it("returns undefined when the registry response is not ok", async () => {
    const fetcher = vi.fn(async () => ({
      json: async () => ({ version: "0.2.0" }),
      ok: false,
    }));

    await expect(
      fetchLatestVersionFromNpm(
        "@standhigher/bshopify",
        fetcher as unknown as typeof fetch,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("defaultUpdateCachePath", () => {
  it("prefers XDG_CACHE_HOME when set", () => {
    expect(defaultUpdateCachePath({ XDG_CACHE_HOME: "/tmp/xdg-cache" })).toBe(
      join("/tmp/xdg-cache", "bshopify", "update-check.json"),
    );
  });
});

describe("notifyIfOutdated", () => {
  it("does not treat VITEST as an opt-out flag", async () => {
    const result = await notify({
      env: { VITEST: "true" },
      now: () => 10_000,
      readCache: async () => ({ checkedAt: 1, latestVersion: "0.1.7" }),
    });

    expect(result.notices).toHaveLength(1);
  });

  it("skips CI, opt-out flags, help, version, and non-interactive sessions", async () => {
    const skipped = await Promise.all([
      notify({ env: { CI: "true" } }),
      notify({ env: { NO_UPDATE_NOTIFIER: "1" } }),
      notify({ env: { BSHOPIFY_NO_UPDATE_NOTIFIER: "true" } }),
      notify({ args: ["--help"] }),
      notify({ args: ["app", "dev", "-h"] }),
      notify({ args: ["--version"] }),
      notify({ args: [] }),
      notify({ args: ["help", "app", "dev"] }),
      notify({ isInteractive: false }),
    ]);

    for (const result of skipped) {
      expect(result.fetches).toEqual([]);
      expect(result.notices).toEqual([]);
      expect(result.scheduled).toEqual([]);
      expect(result.writes).toEqual([]);
    }
  });

  it("prints from a fresh cache once and does not contact the registry", async () => {
    const result = await notify({
      now: () => 10_000,
      readCache: async () => ({ checkedAt: 1, latestVersion: "0.1.7" }),
    });

    expect(result.fetches).toEqual([]);
    expect(result.scheduled).toEqual([]);
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toContain("0.1.6");
    expect(result.notices[0]).toContain("0.1.7");
    expect(result.notices[0]).toContain("npm i -g @standhigher/bshopify@latest");
    expect(result.writes).toEqual([
      { checkedAt: 1, latestVersion: "0.1.7", notifiedVersion: "0.1.7" },
    ]);
  });

  it("does not print again after the current latest has already been notified", async () => {
    const result = await notify({
      now: () => 10_000,
      readCache: async () => ({
        checkedAt: 1,
        latestVersion: "0.1.7",
        notifiedVersion: "0.1.7",
      }),
    });

    expect(result.fetches).toEqual([]);
    expect(result.scheduled).toEqual([]);
    expect(result.notices).toEqual([]);
    expect(result.writes).toEqual([]);
  });

  it("prints again when latest moves past the last notified version", async () => {
    const result = await notify({
      now: () => 10_000,
      readCache: async () => ({
        checkedAt: 1,
        latestVersion: "0.1.8",
        notifiedVersion: "0.1.7",
      }),
    });

    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toContain("0.1.8");
    expect(result.writes).toEqual([
      { checkedAt: 1, latestVersion: "0.1.8", notifiedVersion: "0.1.8" },
    ]);
  });

  it("does not wait for a registry refresh and only fetches when the scheduled task runs", async () => {
    const result = await notify();

    expect(result.fetches).toEqual([]);
    expect(result.notices).toEqual([]);
    expect(result.writes).toEqual([]);
    expect(result.scheduled).toHaveLength(1);

    await result.scheduled[0]!();

    expect(result.fetches).toEqual(["@standhigher/bshopify"]);
    expect(result.notices).toEqual([]);
    expect(result.writes).toEqual([{ checkedAt: 1_000, latestVersion: "0.1.6" }]);
  });

  it("prints from a stale cache and preserves the notified version when refreshing", async () => {
    const fetches: string[] = [];
    const result = await notify({
      fetchLatestVersion: async (packageName) => {
        fetches.push(packageName);
        return "0.1.7";
      },
      now: () => 24 * 60 * 60 * 1000 + 2,
      readCache: async () => ({ checkedAt: 1, latestVersion: "0.1.7" }),
    });

    expect(result.fetches).toEqual([]);
    expect(result.notices).toHaveLength(1);
    expect(result.writes).toEqual([
      { checkedAt: 1, latestVersion: "0.1.7", notifiedVersion: "0.1.7" },
    ]);
    expect(result.scheduled).toHaveLength(1);

    await result.scheduled[0]!();

    expect(fetches).toEqual(["@standhigher/bshopify"]);
    expect(result.writes).toEqual([
      { checkedAt: 1, latestVersion: "0.1.7", notifiedVersion: "0.1.7" },
      { checkedAt: 24 * 60 * 60 * 1000 + 2, latestVersion: "0.1.7", notifiedVersion: "0.1.7" },
    ]);
  });

  it("does not fetch when the cache is still fresh", async () => {
    const result = await notify({
      fetchLatestVersion: async () => {
        throw new Error("registry should not be contacted");
      },
      now: () => 24 * 60 * 60 * 1000,
      readCache: async () => ({ checkedAt: 1, latestVersion: "0.1.6" }),
    });

    expect(result.scheduled).toEqual([]);
    expect(result.writes).toEqual([]);
    expect(result.notices).toEqual([]);
  });

  it("swallows registry and cache errors", async () => {
    await expect(
      notify({
        fetchLatestVersion: async () => {
          throw new Error("offline");
        },
        readCache: async () => {
          throw new Error("unreadable cache");
        },
      }),
    ).resolves.toMatchObject({ notices: [], writes: [], scheduled: [] });
  });

  it("writes the cache file under the configured cache directory after refresh", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "bshopify-update-cache-"));
    tempDirs.push(cacheRoot);
    const env = { XDG_CACHE_HOME: cacheRoot };
    const scheduled: Array<() => Promise<void>> = [];

    await notifyIfOutdated({
      args: ["app", "init"],
      currentVersion: "0.1.6",
      env,
      fetchLatestVersion: async () => "0.1.8",
      isInteractive: true,
      now: () => 42,
      packageName: "@standhigher/bshopify",
      scheduleRefresh: (task) => {
        scheduled.push(task);
      },
      writeNotice: () => undefined,
    });

    expect(scheduled).toHaveLength(1);
    await scheduled[0]!();

    expect(JSON.parse(await readFile(defaultUpdateCachePath(env), "utf8"))).toEqual({
      checkedAt: 42,
      latestVersion: "0.1.8",
    });
  });
});
