import { readFile, rm, writeFile } from "node:fs/promises";
import { isRecord } from "#/utils/objects";
import { isNodeError } from "#/utils/node";
import { restoreJournalReplacement } from "./restore-journal";
import { restoreInjectedMarkers } from "./restore-markers";
import type { FileTransaction, ReverseReplacement, TrackedFile } from "./types";

interface FileTransactionJournal {
  files: TrackedFile[];
}

export async function createFileTransaction(journalPath?: string): Promise<FileTransaction> {
  const tracked = new Map<string, TrackedFile>();

  return {
    async restore() {
      const restored = await restoreTrackedFiles([...tracked.values()]);

      if (journalPath !== undefined) {
        await rm(journalPath, { force: true });
      }

      return restored;
    },
    async writeFile(path, content, replacement) {
      const trackedFile = tracked.get(path) ?? { path, replacements: [] };
      trackedFile.replacements.push(replacement);
      tracked.set(path, trackedFile);
      await writeJournal(journalPath, [...tracked.values()]);
      await writeFile(path, content);
    },
  };
}

/**
 * Restores the pending injections recorded in a transaction journal (a killed
 * dev/deploy process) and returns the paths of the restored files. An empty
 * result means there was no journal to restore.
 */
export async function restoreFileTransactionJournal(journalPath: string): Promise<string[]> {
  const journal = await readJournal(journalPath);

  if (journal === undefined) {
    return [];
  }

  const restored = await restoreTrackedFiles(journal.files);
  await rm(journalPath, { force: true });
  return restored;
}

async function restoreTrackedFiles(files: TrackedFile[]): Promise<string[]> {
  const restored: string[] = [];

  for (const file of files.slice().reverse()) {
    let content = await readFile(file.path, "utf8");

    // Marker path: reverse the injections recorded in the file itself. This
    // works even when the journal is lost or stale, because the marker
    // carries the full record. User edits outside the injected span are kept.
    content = restoreInjectedMarkers(content);

    // Markerless path (deploy): restore complete tokens on each line so a
    // wasm path that contains the injected handle is left untouched, while
    // uid lines and rewritten spacing around the handle are kept.
    for (const replacement of file.replacements.slice().reverse()) {
      content = restoreJournalReplacement(content, replacement);
    }

    await writeFile(file.path, content);
    restored.push(file.path);
  }

  return restored;
}

async function writeJournal(
  journalPath: string | undefined,
  files: TrackedFile[],
): Promise<void> {
  if (journalPath === undefined) {
    return;
  }

  const journal: FileTransactionJournal = { files };
  await writeFile(journalPath, `${JSON.stringify(journal, undefined, 2)}\n`);
}

async function readJournal(journalPath: string): Promise<FileTransactionJournal | undefined> {
  let content;

  try {
    content = await readFile(journalPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }

  const value = JSON.parse(content) as unknown;

  if (!isRecord(value) || !Array.isArray(value.files)) {
    throw new Error("Invalid bshopify dev transaction journal.");
  }

  return {
    files: value.files.map(parseTrackedFile),
  };
}

function parseTrackedFile(value: unknown): TrackedFile {
  if (!isRecord(value) || typeof value.path !== "string" || !Array.isArray(value.replacements)) {
    throw new Error("Invalid bshopify dev transaction journal.");
  }

  return {
    path: value.path,
    replacements: value.replacements.map(parseReverseReplacement),
  };
}

function parseReverseReplacement(value: unknown): ReverseReplacement {
  if (
    !isRecord(value) ||
    typeof value.pattern !== "string" ||
    typeof value.value !== "string" ||
    (value.marker !== undefined && typeof value.marker !== "string")
  ) {
    throw new Error("Invalid bshopify dev transaction journal.");
  }

  return {
    marker: value.marker,
    pattern: value.pattern,
    value: value.value,
  };
}
