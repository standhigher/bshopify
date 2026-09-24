import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeInjection } from "../src/app/runner/compose-injection";
import {
  formatLeftoverRestoreNotice,
  restoreLeftoverInjectionMarkers,
} from "../src/app/runner/restore-leftovers";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true })));
});

describe("restoreLeftoverInjectionMarkers", () => {
  it("restores a leftover marker without a journal and returns the path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bshopify-leftover-"));
    tempDirs.push(cwd);
    const filePath = join(cwd, "extensions", "discount", "shopify.extension.toml");
    await mkdir(join(cwd, "extensions", "discount"), { recursive: true });
    const source = 'handle = "CART-DRAWER-HANDLE"\n';
    const injected = composeInjection(
      source,
      filePath,
      "CART-DRAWER-HANDLE",
      "test-upsell-cart-drawer-discount",
      true,
    ).content;
    await writeFile(filePath, injected);

    const restored = await restoreLeftoverInjectionMarkers(cwd, "extensions");

    expect(restored).toEqual([filePath]);
    await expect(readFile(filePath, "utf8")).resolves.toBe(source);
  });

  it("leaves files without markers untouched", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bshopify-leftover-clean-"));
    tempDirs.push(cwd);
    const filePath = join(cwd, "extensions", "discount", "app.liquid");
    await mkdir(join(cwd, "extensions", "discount"), { recursive: true });
    const source = '<div data-api-base="https://example.com"></div>\n';
    await writeFile(filePath, source);

    const restored = await restoreLeftoverInjectionMarkers(cwd, "extensions");

    expect(restored).toEqual([]);
    await expect(readFile(filePath, "utf8")).resolves.toBe(source);
  });

  it("ignores marker-shaped text whose checksum does not verify", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bshopify-leftover-bad-"));
    tempDirs.push(cwd);
    const filePath = join(cwd, "extensions", "discount", "app.liquid");
    await mkdir(join(cwd, "extensions", "discount"), { recursive: true });
    const source =
      'handle = "test-upsell-cart-drawer-discount"/* bshopify-restore:Q0FSVC1EUkFXRVItSEFORExF:32:0:0000000000000000:b428b9df-e203-4654-9de0-f359e352090f */\n';
    await writeFile(filePath, source);

    const restored = await restoreLeftoverInjectionMarkers(cwd, "extensions");

    expect(restored).toEqual([]);
    await expect(readFile(filePath, "utf8")).resolves.toBe(source);
  });

  it("skips node_modules and dist directories", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bshopify-leftover-skip-"));
    tempDirs.push(cwd);
    const source = '<div data-api-base="__SHOPIFY_APP_PROXY_BASE__"></div>\n';
    const skippedFiles = [
      join(cwd, "extensions", "discount", "node_modules", "pkg", "app.liquid"),
      join(cwd, "extensions", "discount", "dist", "app.liquid"),
    ];

    for (const filePath of skippedFiles) {
      await mkdir(dirname(filePath), { recursive: true });
      const injected = composeInjection(
        source,
        filePath,
        "__SHOPIFY_APP_PROXY_BASE__",
        "https://proxy.example.com",
        true,
      ).content;
      await writeFile(filePath, injected);
    }

    const restored = await restoreLeftoverInjectionMarkers(cwd, "extensions");

    expect(restored).toEqual([]);
    for (const filePath of skippedFiles) {
      await expect(readFile(filePath, "utf8")).resolves.not.toBe(source);
    }
  });

  it("skips target only when a sibling Cargo.toml marks it as Cargo build output", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bshopify-leftover-target-"));
    tempDirs.push(cwd);
    const source = '<div data-api-base="__SHOPIFY_APP_PROXY_BASE__"></div>\n';
    const injectedContent = composeInjection(
      source,
      "app.liquid",
      "__SHOPIFY_APP_PROXY_BASE__",
      "https://proxy.example.com",
      true,
    ).content;

    // Rust crate: Cargo.toml + target/ -> build output, skipped.
    const rustTarget = join(cwd, "extensions", "discount", "target", "release", "app.liquid");
    await mkdir(dirname(rustTarget), { recursive: true });
    await writeFile(join(cwd, "extensions", "discount", "Cargo.toml"), '[package]\nname = "discount"\n');
    await writeFile(rustTarget, injectedContent);

    // Non-Rust extension: a directory named target with no Cargo.toml sibling.
    const plainTarget = join(cwd, "extensions", "theme", "target", "app.liquid");
    await mkdir(dirname(plainTarget), { recursive: true });
    await writeFile(plainTarget, injectedContent);

    const restored = await restoreLeftoverInjectionMarkers(cwd, "extensions");

    expect(restored).toEqual([plainTarget]);
    await expect(readFile(rustTarget, "utf8")).resolves.toBe(injectedContent);
    await expect(readFile(plainTarget, "utf8")).resolves.toBe(source);
  });

  it("returns empty when the extensions root is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bshopify-leftover-missing-root-"));
    tempDirs.push(cwd);

    await expect(restoreLeftoverInjectionMarkers(cwd, "extensions")).resolves.toEqual([]);
  });

  it("does not scan files outside the marker-capable extensions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bshopify-leftover-ext-"));
    tempDirs.push(cwd);
    const filePath = join(cwd, "extensions", "discount", "target", "release", "app.wasm");
    await mkdir(dirname(filePath), { recursive: true });
    const source = '<div data-api-base="__SHOPIFY_APP_PROXY_BASE__"></div>\n';
    const injected = composeInjection(
      source,
      "app.liquid",
      "__SHOPIFY_APP_PROXY_BASE__",
      "https://proxy.example.com",
      true,
    ).content;
    await writeFile(filePath, injected);

    const restored = await restoreLeftoverInjectionMarkers(cwd, "extensions");

    expect(restored).toEqual([]);
    await expect(readFile(filePath, "utf8")).resolves.toBe(injected);
  });
});

describe("formatLeftoverRestoreNotice", () => {
  it("pluralizes by count", () => {
    expect(formatLeftoverRestoreNotice(1)).toContain("1 leftover bshopify injection");
    expect(formatLeftoverRestoreNotice(2)).toContain("2 leftover bshopify injections");
  });
});
