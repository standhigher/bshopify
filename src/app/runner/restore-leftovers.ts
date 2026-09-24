import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNodeError } from "#/utils/node";
import { ansi, colorize } from "#/utils/output";
import { isInjectionMarkerFile } from "#/utils/markers";
import { hasRestoreMarkers, restoreInjectedMarkers } from "./restore-markers";

/**
 * Restores leftover bshopify injection markers directly from the working tree,
 * without relying on the transaction journal.
 *
 * A dev/deploy session normally reverses its injections from the journal when
 * it exits. That path depends on the journal (and, at startup, on a stale
 * lock) surviving; when either is lost, a file can keep its injected value
 * and self-describing `bshopify-restore:` marker. Since the marker embeds the
 * placeholder, the value, and a checksum, the file can be restored from its
 * own content alone. `dev` / `deploy` call this before planning so such
 * leftovers never block a fresh injection (the pattern would otherwise match
 * zero times and be skipped).
 */
export async function restoreLeftoverInjectionMarkers(
  cwd: string,
  extensionsRoot: string,
): Promise<string[]> {
  const files = await listFiles(join(cwd, extensionsRoot));
  const restored: string[] = [];

  for (const file of files) {
    let content: string;

    try {
      content = await readFile(file, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        continue;
      }

      throw error;
    }

    if (!hasRestoreMarkers(content)) {
      continue;
    }

    const next = restoreInjectedMarkers(content);

    if (next === content) {
      continue;
    }

    await writeFile(file, next);
    restored.push(file);
  }

  return restored;
}

export function formatLeftoverRestoreNotice(count: number): string {
  return colorize(
    `Restored ${count} leftover bshopify injection${count === 1 ? "" : "s"} found in the working tree.`,
    ansi.yellow,
  );
}

async function listFiles(root: string): Promise<string[]> {
  let entries;

  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  // `node_modules` and `dist` are always build/output directories. Rust's
  // `target` is only Cargo's build output when a `Cargo.toml` sits next to
  // it (the default `crate/target` layout); a directory named `target` in a
  // non-Rust extension is source and must still be scanned.
  const hasCargoToml = entries.some(
    (entry) => entry.isFile() && entry.name === "Cargo.toml",
  );

  const files: string[] = [];

  for (const entry of entries) {
    const path = join(root, entry.name);

    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules"
        || entry.name === "dist"
        || (entry.name === "target" && hasCargoToml)
      ) {
        continue;
      }

      files.push(...(await listFiles(path)));
    } else if (entry.isFile() && isInjectionMarkerFile(path)) {
      files.push(path);
    }
  }

  return files;
}
