import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { bshopifyStateDir } from "#/app/runner/constants";
import { isNodeError } from "#/utils/node";
import { isRecord } from "#/utils/objects";
import { configFileName } from "./constants";
import { manifestFileName } from "./manifest";
import { resolveProjectPath } from "./paths";

/**
 * `init` writes `.bshopify/bshopify.manifest.json` only after it finishes,
 * and that directory is gitignored. A committed `bshopify.config.mjs` alone
 * does not count: this checkout still needs the local manifest. A marker
 * file with no runner config does not count either, because dev and deploy
 * would otherwise fall back to built-in config paths.
 */
export function projectNotInitializedMessage(cwd: string): string {
  return `This project is not initialized. Run \`bshopify app init\` before using this command. Checked ${resolve(cwd)}.`;
}

export async function assertProjectInitialized(cwd: string): Promise<void> {
  const manifestPath = resolveProjectPath(cwd, join(bshopifyStateDir, manifestFileName));
  const configPath = resolveProjectPath(cwd, configFileName);

  if (!(await isInitializedManifest(manifestPath)) || !(await isRegularFile(configPath))) {
    throw new Error(projectNotInitializedMessage(cwd));
  }
}

async function isInitializedManifest(path: string): Promise<boolean> {
  let content: string;

  try {
    const info = await stat(path);

    if (!info.isFile() || info.size === 0) {
      return false;
    }

    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return false;
    }

    throw error;
  }

  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) && typeof parsed.version === "number";
  } catch {
    return false;
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return false;
    }

    throw error;
  }
}
