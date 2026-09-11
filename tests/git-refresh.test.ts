import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { devProject } from "../src";
import { cleanFilterScript } from "../src/app/commands/init/constants";
import { composeInjection } from "../src/app/runner/compose-injection";
import { refreshGitIndexForRestoredFiles } from "../src/app/runner/git-refresh";
import { createFileTransaction } from "../src/app/runner/transaction";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true })));
});

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: unknown; stderr?: unknown; stdout?: unknown };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stderr: String(e.stderr ?? ""),
      stdout: String(e.stdout ?? ""),
    };
  }
}

/**
 * Creates a git repo wired exactly like `bshopify app init` does: the
 * generated clean/smudge filter on `extensions/**`, and a committed
 * placeholder liquid file.
 */
async function createFilteredRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "bshopify-git-refresh-"));
  tempDirs.push(cwd);
  const scriptPath = join(cwd, ".bshopify", "git-add-cleaner.js");
  await mkdir(dirname(scriptPath), { recursive: true });
  await writeFile(scriptPath, cleanFilterScript);
  await git(cwd, ["init", "-q"]);
  await git(cwd, ["config", "user.email", "t@t.co"]);
  await git(cwd, ["config", "user.name", "t"]);
  await git(cwd, ["config", "core.autocrlf", "false"]);
  await git(cwd, ["config", "filter.bshopify.clean", `node ${scriptPath}`]);
  await git(cwd, ["config", "filter.bshopify.smudge", `node ${scriptPath} --smudge`]);
  await git(cwd, ["config", "filter.bshopify.required", "false"]);
  await writeFile(join(cwd, ".gitattributes"), "# bshopify cli\nextensions/** filter=bshopify\n");
  await writeFile(join(cwd, ".gitignore"), ".bshopify/\n");
  return cwd;
}

const source = '{{ "__SHOPIFY_APP_PROXY_BASE__" }}\n';
const relTarget = join("extensions", "x", "blocks", "app-embed.liquid");

function injectedContent(): string {
  return composeInjection(
    source,
    relTarget,
    "__SHOPIFY_APP_PROXY_BASE__",
    "https://proxy.example.com",
    true,
  ).content;
}

describe("refreshGitIndexForRestoredFiles", () => {
  it("hides live injections from git status without staging injected values", async () => {
    const cwd = await createFilteredRepo();
    const targetPath = join(cwd, relTarget);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, source);
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-qm", "placeholder"]);
    const headBlob = (
      await git(cwd, ["rev-parse", `HEAD:${relTarget}`])
    ).stdout.trim();

    const injected = injectedContent();
    await writeFile(targetPath, injected);
    expect((await git(cwd, ["status", "--porcelain"])).stdout).toContain(` M ${relTarget}`);

    await refreshGitIndexForRestoredFiles(cwd, [targetPath]);

    expect((await git(cwd, ["status", "--porcelain"])).stdout).toBe("");
    expect((await git(cwd, ["diff", "--cached", "--stat"])).stdout).toBe("");
    const stagedBlob = (
      await git(cwd, ["ls-files", "-s", "--", relTarget])
    ).stdout.trim().split(/\s+/)[1];
    expect(stagedBlob).toBe(headBlob);
    await expect(readFile(targetPath, "utf8")).resolves.toBe(injected);
  });

  it("clears a stale index.lock leftover and still hides live injections", async () => {
    const cwd = await createFilteredRepo();
    const targetPath = join(cwd, relTarget);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, source);
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-qm", "placeholder"]);

    const injected = injectedContent();
    await writeFile(targetPath, injected);
    await writeFile(join(cwd, ".git", "index.lock"), "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await refreshGitIndexForRestoredFiles(cwd, [targetPath]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }

    expect((await git(cwd, ["status", "--porcelain"])).stdout).toBe("");
    expect((await git(cwd, ["diff", "--cached", "--stat"])).stdout).toBe("");
    await expect(readFile(targetPath, "utf8")).resolves.toBe(injected);
    await expect(readFile(join(cwd, ".git", "index.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not stage real user edits mixed into a live injection", async () => {
    const cwd = await createFilteredRepo();
    const targetPath = join(cwd, relTarget);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, source);
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-qm", "placeholder"]);

    await writeFile(targetPath, `${injectedContent()}const devEdit = true;\n`);
    await refreshGitIndexForRestoredFiles(cwd, [targetPath]);

    const status = (await git(cwd, ["status", "--porcelain"])).stdout;
    expect(status).toContain(` M ${relTarget}`);
    expect((await git(cwd, ["diff", "--cached", "--stat"])).stdout).toBe("");
    expect((await git(cwd, ["diff", "--", relTarget])).stdout).toContain("devEdit");
  });

  it("clears the phantom change left by a git add during injection", async () => {
    const cwd = await createFilteredRepo();
    const targetPath = join(cwd, relTarget);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, source);
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-qm", "placeholder"]);
    const headBlob = (
      await git(cwd, ["rev-parse", `HEAD:${relTarget}`])
    ).stdout.trim();

    // Dev session: the placeholder is replaced by the real value + marker.
    await writeFile(targetPath, injectedContent());

    // The developer runs git add while the injection is live: the clean
    // filter must keep the placeholder in the index (nothing real staged)
    // and, because the index stat cache now describes the injected file,
    // git reports no change at all.
    await git(cwd, ["add", "--", relTarget]);
    const stagedBlob = (
      await git(cwd, ["ls-files", "-s", "--", relTarget])
    ).stdout.trim().split(/\s+/)[1];
    expect(stagedBlob).toBe(headBlob);
    expect((await git(cwd, ["status", "--porcelain"])).stdout).toBe("");

    // Dev exits: the file is restored to the placeholder bytes.
    await writeFile(targetPath, source);
    expect((await git(cwd, ["hash-object", targetPath])).stdout.trim()).toBe(headBlob);

    // Precondition: git still reports the file as modified with no real
    // change (the phantom), because its stat cache still describes the
    // injected file and git never re-hashes on a size change.
    const before = await git(cwd, ["status", "--porcelain"]);
    expect(before.stdout).toContain(` M ${relTarget}`);

    // The fix refreshes the index stat cache for the restored file.
    await refreshGitIndexForRestoredFiles(cwd, [targetPath]);

    const after = await git(cwd, ["status", "--porcelain"]);
    expect(after.stdout).toBe("");
    expect((await git(cwd, ["diff", "--cached", "--stat"])).stdout).toBe("");
  });

  it("never stages files that carry a real unstaged user change", async () => {
    const cwd = await createFilteredRepo();
    const targetPath = join(cwd, relTarget);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, source);
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-qm", "placeholder"]);

    // Poison the stat cache with a git add during the injected state.
    await writeFile(targetPath, injectedContent());
    await git(cwd, ["add", "--", relTarget]);

    // Restore, then the developer keeps an unstaged edit in the same file.
    await writeFile(targetPath, `${source}const devEdit = true;\n`);

    await refreshGitIndexForRestoredFiles(cwd, [targetPath]);

    const status = (await git(cwd, ["status", "--porcelain"])).stdout;
    expect(status).toContain(` M ${relTarget}`);
    // The real edit must still be unstaged: nothing was auto-added.
    expect((await git(cwd, ["diff", "--cached", "--stat"])).stdout).toBe("");
    expect((await git(cwd, ["diff", "--", relTarget])).stdout).toContain("devEdit");
  });

  it("does not stage untracked files", async () => {
    const cwd = await createFilteredRepo();
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-qm", "base"]);

    // The target file is not tracked by git yet.
    const targetPath = join(cwd, relTarget);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, injectedContent());
    await writeFile(targetPath, source);

    await refreshGitIndexForRestoredFiles(cwd, [targetPath]);

    const status = (await git(cwd, ["status", "--porcelain"])).stdout;
    // Porcelain collapses a lone untracked file into its directory entry.
    expect(status).toContain("?? extensions");
    expect(status).not.toContain("A ");
    expect((await git(cwd, ["ls-files", "--", relTarget])).stdout).toBe("");
    expect((await git(cwd, ["diff", "--cached", "--stat"])).stdout).toBe("");
  });

  it("does nothing when there is no git repository", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bshopify-not-git-"));
    tempDirs.push(cwd);
    const targetPath = join(cwd, "app.liquid");
    await writeFile(targetPath, source);

    await expect(refreshGitIndexForRestoredFiles(cwd, [targetPath])).resolves.toBeUndefined();
    await expect(readFile(targetPath, "utf8")).resolves.toBe(source);
  });

  it("clears a leftover index.lock even when there are no files to refresh", async () => {
    const cwd = await createFilteredRepo();
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-qm", "base"]);
    await writeFile(join(cwd, ".git", "index.lock"), "");

    await refreshGitIndexForRestoredFiles(cwd, []);

    await expect(readFile(join(cwd, ".git", "index.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("transaction restore path reporting", () => {
  it("returns the paths of the restored files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bshopify-txn-paths-"));
    tempDirs.push(cwd);
    const filePath = join(cwd, "app.liquid");
    await writeFile(filePath, source);
    const journalPath = join(cwd, "transaction.json");
    const transaction = await createFileTransaction(journalPath);
    await transaction.writeFile(filePath, injectedContent(), {
      marker: "/* marker */",
      pattern: "__SHOPIFY_APP_PROXY_BASE__",
      value: "https://proxy.example.com",
    });

    const restored = await transaction.restore();

    expect(restored).toEqual([filePath]);
    await expect(readFile(filePath, "utf8")).resolves.toBe(source);
  });
});

describe("app dev git status while injections are live", () => {
  it("keeps Source Control clean during shopify app dev and after restore", async () => {
    const cwd = await createFilteredRepo();
    const targetRel = join("extensions", "theme-extension", "blocks", "app-embed.liquid");
    const targetPath = join(cwd, targetRel);
    const placeholder = '<div data-api-base="__SHOPIFY_APP_PROXY_BASE__"></div>\n';
    await writeFile(join(cwd, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
    await writeFile(
      join(cwd, "shopify.app.dev.toml"),
      [
        'name = "fixture"',
        'client_id = "client-id"',
        "",
        "[app_proxy]",
        'prefix = "apps"',
        'subpath = "fixture-dev"',
        'url = "https://example.test/proxy"',
        "",
      ].join("\n"),
    );
    await writeFile(
      join(cwd, "bshopify.config.mjs"),
      'export default { configFiles: { dev: "shopify.app.dev.toml" } };\n',
    );
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, placeholder);
    await writeFile(
      join(cwd, "extensions", "theme-extension", "__entry.js"),
      [
        "export default {",
        "  async prepare(ctx) {",
        "    return {",
        "      injections: [",
        "        {",
        '          file: "blocks/app-embed.liquid",',
        '          strategy: "replace",',
        '          pattern: "__SHOPIFY_APP_PROXY_BASE__",',
        "          value: ctx.appConfig.app_proxy ? `/${ctx.appConfig.app_proxy.prefix}/${ctx.appConfig.app_proxy.subpath}` : undefined,",
        "        },",
        "      ],",
        "    };",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-qm", "dev fixture"]);
    const headBlob = (await git(cwd, ["rev-parse", `HEAD:${targetRel}`])).stdout.trim();
    // Leftover from a crashed `git add` during a previous session, matching
    // the editor-visible "index.lock: File exists" failure.
    await writeFile(join(cwd, ".git", "index.lock"), "");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const runShopifyCommand = vi.fn(async () => {
        const live = await readFile(targetPath, "utf8");
        expect(live).toContain("/apps/fixture-dev");
        expect(live).toContain("bshopify-restore:");
        expect((await git(cwd, ["status", "--porcelain"])).stdout).toBe("");
        expect((await git(cwd, ["diff", "--cached", "--stat"])).stdout).toBe("");
        const stagedBlob = (
          await git(cwd, ["ls-files", "-s", "--", targetRel])
        ).stdout.trim().split(/\s+/)[1];
        expect(stagedBlob).toBe(headBlob);
        return 0;
      });

      await expect(devProject({ cwd, runShopifyCommand })).resolves.toBe(0);
      expect(runShopifyCommand).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }

    await expect(readFile(targetPath, "utf8")).resolves.toBe(placeholder);
    expect((await git(cwd, ["status", "--porcelain"])).stdout).toBe("");
    expect((await git(cwd, ["diff", "--cached", "--stat"])).stdout).toBe("");
  });
});
