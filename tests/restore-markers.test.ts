import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import {
  findRestoreMarkers,
  hasRestoreMarkers,
  restoreInjectedMarkers,
} from "../src/app/runner/restore-markers";
import { composeInjection } from "../src/app/runner/compose-injection";
import {
  createFileMarker,
  createRestoreMarker,
  createValueChecksum,
  encodeBase64Url,
  restoreMarkerPrefix,
} from "../src/utils/markers";
import {
  createFileTransaction,
  restoreFileTransactionJournal,
} from "../src/app/runner/transaction";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true })));
});

/**
 * Mirrors how applyInjections composes the injected file content
 * (string-context-aware marker placement).
 */
function inject(source: string, filePath: string, pattern: string, value: string): string {
  return composeInjection(source, filePath, pattern, value, true).content;
}

describe("createRestoreMarker", () => {
  it("embeds the pattern, the value length, and a value checksum", () => {
    const marker = createRestoreMarker("__SHOPIFY_APP_PROXY_BASE__", "https://proxy.example.com");

    expect(marker.startsWith("bshopify-restore:")).toBe(true);
    expect(marker).toContain(encodeBase64Url("__SHOPIFY_APP_PROXY_BASE__"));
    expect(marker).toContain(":25:");
    expect(marker).toContain(`:${createValueChecksum("https://proxy.example.com")}:`);
    expect(marker).toMatch(/:[0-9a-f]{16}:/);
    expect(marker).toMatch(/:[0-9a-f-]{36}$/);
  });

  it("encodes patterns that would otherwise break comment syntax", () => {
    const marker = createRestoreMarker("*/__WEIRD__", "x");
    expect(marker).not.toContain("*/__WEIRD__");
    expect(restoreInjectedMarkers(`const a = "x${createFileMarker("a.js", marker)}";`)).toBe(
      'const a = "*/__WEIRD__";',
    );
  });

  it("round-trips emoji values (UTF-16 surrogate pairs)", () => {
    const filePath = "extensions/x/__entry.js";
    const source = 'const url = "__APP_URL__";\n';
    const injected = inject(source, filePath, "__APP_URL__", "https://例.com/😀");

    expect(restoreInjectedMarkers(injected)).toBe(source);
  });
});

describe("restoreInjectedMarkers", () => {
  const cases: Array<[string, string, string, string, string]> = [
    [
      "block comment syntax (js)",
      "extensions/x/__entry.js",
      'const proxyBase = "__SHOPIFY_APP_PROXY_BASE__";\n',
      "__SHOPIFY_APP_PROXY_BASE__",
      "https://proxy.example.com",
    ],
    [
      "liquid comment syntax",
      "extensions/x/blocks/app-embed.liquid",
      '{% assign base = "__SHOPIFY_APP_PROXY_BASE__" %}\n',
      "__SHOPIFY_APP_PROXY_BASE__",
      "https://proxy.example.com/app?x=1&y=2",
    ],
    [
      "html comment syntax",
      "extensions/x/blocks/embed.html",
      '<a href="__APP_URL__">go</a>\n',
      "__APP_URL__",
      "https://example.com",
    ],
    [
      "jsx comment syntax",
      "extensions/x/blocks/App.jsx",
      'const url = "__APP_URL__";\n',
      "__APP_URL__",
      "https://example.com",
    ],
    [
      "toml hash comment syntax",
      "extensions/x/shopify.extension.toml",
      'name = "__SHOPIFY_APP_PROXY_BASE__"\n',
      "__SHOPIFY_APP_PROXY_BASE__",
      "https://proxy.example.com",
    ],
    [
      "unicode pattern and value",
      "extensions/x/blocks/embed.liquid",
      "{{ '__代理__' }}\n",
      "__代理__",
      "https://例.com",
    ],
  ];

  it.each(cases)("%s", (_label, filePath, source, pattern, value) => {
    const injected = inject(source, filePath, pattern, value);

    expect(hasRestoreMarkers(injected)).toBe(true);
    expect(restoreInjectedMarkers(injected)).toBe(source);
  });

  it("restores multiple injections in the same file", () => {
    const filePath = "extensions/x/blocks/app-embed.liquid";
    const source = [
      '{{ "__PROXY_BASE__" }}',
      "|",
      '{{ "__APP_URL__" }}',
      "\n",
    ].join("");
    const first = inject(source, filePath, "__PROXY_BASE__", "https://proxy.example.com");
    const injected = inject(first, filePath, "__APP_URL__", "https://example.com");

    expect(restoreInjectedMarkers(injected)).toBe(source);
  });

  it("leaves content without markers untouched", () => {
    const source = "const x = 1;\n";

    expect(hasRestoreMarkers(source)).toBe(false);
    expect(restoreInjectedMarkers(source)).toBe(source);
  });

  it("skips malformed markers whose value length overruns the file", () => {
    const filePath = "extensions/x/__entry.js";
    const source = 'const url = "__APP_URL__";\n';
    const injected = inject(source, filePath, "__APP_URL__", "https://example.com");
    const broken = injected.replace(
      /bshopify-restore:([A-Za-z0-9_-]+):(\d+)/,
      "bshopify-restore:$1:1000",
    );

    expect(restoreInjectedMarkers(broken)).toBe(broken);
  });

  it("ignores marker-like text inside injected values", () => {
    const filePath = "extensions/x/__entry.js";
    const source = 'const url = "__APP_URL__";\n';
    const fakeMarkerInsideValue = "https://x.com/* bshopify-restore:YWJj:1:aaaa */tail";
    const injected = inject(source, filePath, "__APP_URL__", fakeMarkerInsideValue);

    expect(restoreInjectedMarkers(injected)).toBe(source);
  });

  it("leaves marker-like text outside any injected value untouched", () => {
    const filePath = "extensions/x/__entry.js";
    const plain = [
      "// user comment mentioning the format",
      "// /* bshopify-restore:YWJj:1:aaaaaaaaaaaaaaaa:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb */",
      "const x = 1;\n",
    ].join("\n");

    expect(restoreInjectedMarkers(plain)).toBe(plain);
  });

  it("skips a marker whose recorded value was edited mid-dev", () => {
    const filePath = "extensions/x/blocks/app-embed.liquid";
    const injected = inject(
      '{{ "__SHOPIFY_APP_PROXY_BASE__" }}\n',
      filePath,
      "__SHOPIFY_APP_PROXY_BASE__",
      "https://proxy.example.com",
    );
    // Simulate a developer editing the temporary injected value (different
    // length): restore must not misalign and corrupt the file.
    const edited = injected.replace(
      "https://proxy.example.com",
      "https://proxy.example.com/edited-path",
    );

    expect(restoreInjectedMarkers(edited)).toBe(edited);
  });

  it("reports a single marker for jsx comment wrappers", () => {
    const filePath = "extensions/x/App.jsx";
    const source = 'const url = "__APP_URL__";\n';
    const injected = inject(source, filePath, "__APP_URL__", "https://example.com");

    expect(findRestoreMarkers(injected)).toHaveLength(1);
    expect(restoreInjectedMarkers(injected)).toBe(source);
  });

  it("finds markers in document order with exact positions", () => {
    const filePath = "extensions/x/__entry.js";
    const injected = inject(
      'const a = "__A__";\nconst b = "__B__";\n',
      filePath,
      "__A__",
      "aaa",
    ).replace("__B__", `bbb${createFileMarker(filePath, createRestoreMarker("__B__", "bbb"))}`);
    const markers = findRestoreMarkers(injected);

    expect(markers).toHaveLength(2);
    expect(markers[0]?.pattern).toBe("__A__");
    expect(markers[1]?.pattern).toBe("__B__");
    expect(markers[0]!.fullStart).toBeLessThan(markers[1]!.fullStart);
  });
});

describe("toml markers", () => {
  it("keeps the marker as a # line comment so the file stays valid TOML", () => {
    const filePath = "shopify.app.dev.toml";
    const source = 'application_url = "__APP_URL__"\n';
    const injected = inject(source, filePath, "__APP_URL__", "https://example.com");

    // The marker must be a TOML comment, never a JS-style block comment.
    expect(injected).toContain('application_url = "https://example.com" # bshopify-restore:');
    expect(injected).not.toMatch(/\/\*|<!--|\{% comment %\}/);
    expect(parse(injected)).toEqual({ application_url: "https://example.com" });
    expect(restoreInjectedMarkers(injected)).toBe(source);
  });

  it("keeps bare (unquoted) value replacements valid TOML", () => {
    const filePath = "shopify.app.toml";
    const source = "port = __PORT__\n";
    const injected = inject(source, filePath, "__PORT__", "8080");

    expect(injected).toContain("port = 8080 # bshopify-restore:");
    expect(parse(injected)).toEqual({ port: 8080 });
    expect(restoreInjectedMarkers(injected)).toBe(source);
  });

  it("round-trips when a trailing user comment shares the line", () => {
    const filePath = "shopify.app.toml";
    const source = 'name = "__APP_NAME__" # keep me\n';
    const injected = inject(source, filePath, "__APP_NAME__", "prod");

    // The marker lands after the user comment, at the end of the line.
    expect(injected).toContain('name = "prod" # keep me # bshopify-restore:');
    expect(parse(injected)).toEqual({ name: "prod" });
    expect(restoreInjectedMarkers(injected)).toBe(source);
  });

  it("keeps a string element of a multi-line array valid (trailing comma)", () => {
    const filePath = "shopify.app.toml";
    const source = 'scopes = [\n  "__A__",\n  "write_products",\n]\n';
    const injected = inject(source, filePath, "__A__", "read_products");

    // The `#` comment must come after the comma, never swallow it.
    expect(injected).toContain('  "read_products", # bshopify-restore:');
    expect(parse(injected)).toEqual({ scopes: ["read_products", "write_products"] });
    expect(restoreInjectedMarkers(injected)).toBe(source);
  });

  it("keeps single-line arrays and inline tables valid when a bare value is replaced", () => {
    const filePath = "shopify.app.toml";
    const source = 'allowed = [__A__, 2]\nthreshold = { min = __B__ }\n';
    const first = inject(source, filePath, "__A__", "1");
    const injected = inject(first, filePath, "__B__", "0");

    expect(injected).toContain("allowed = [1, 2] # bshopify-restore:");
    expect(injected).toContain("threshold = { min = 0 } # bshopify-restore:");
    expect(parse(injected)).toEqual({ allowed: [1, 2], threshold: { min: 0 } });
    expect(restoreInjectedMarkers(injected)).toBe(source);
  });

  it("restores two placeholders inside one string on one line", () => {
    const filePath = "shopify.app.toml";
    const source = 'scopes = ["__A__ and __B__"]\n';
    const first = inject(source, filePath, "__A__", "aaa");
    const injected = inject(first, filePath, "__B__", "bbb");

    expect(parse(injected)).toEqual({ scopes: ["aaa and bbb"] });
    expect(restoreInjectedMarkers(injected)).toBe(source);
  });

  it("restores legacy toml markers written without a gap length", () => {
    const filePath = "shopify.app.toml";
    const source = 'name = "__APP_NAME__"\n';
    // Old marker core: bshopify-restore:<b64(pattern)>:<valueLength>:<checksum>:<nonce>
    const legacyMarker =
      ` # ${restoreMarkerPrefix}:${encodeBase64Url("__APP_NAME__")}:3:${createValueChecksum("abc")}:00000000-0000-0000-0000-000000000000`;
    const legacy = source.replace("__APP_NAME__", `abc${legacyMarker}`);

    expect(restoreInjectedMarkers(legacy)).toBe(source);
  });

  it("restores a hash marker that shares its line with later content", () => {
    const filePath = "shopify.app.toml";
    const source = 'name = "__APP_NAME__" # keep me\n';
    const injected = inject(source, filePath, "__APP_NAME__", "prod");
    const markers = findRestoreMarkers(injected);

    expect(markers).toHaveLength(1);
    expect(markers[0]?.pattern).toBe("__APP_NAME__");
  });
});

describe("string-context injections", () => {
  it("keeps the marker outside the string and restores the placeholder", () => {
    const filePath = "extensions/x/assets/app.js";
    const source = 'value: "REPLACE_WITH_CATALOG_API_URL",\n';
    const injected = inject(source, filePath, "REPLACE_WITH_CATALOG_API_URL", "Catalog API value");

    // The comment must sit after the closing quote, never inside the string.
    expect(injected).toContain('value: "Catalog API value"/* bshopify-restore:');
    expect(injected).not.toMatch(/"Catalog API value\/\* bshopify-restore:/);
    expect(restoreInjectedMarkers(injected)).toBe(source);
  });

  it("restores a placeholder in the middle of a string", () => {
    const filePath = "extensions/x/__entry.js";
    const source = 'const url = "https://example.com/__PATH__/x";\n';
    const injected = inject(source, filePath, "__PATH__", "products");

    expect(injected).toContain('const url = "https://example.com/products/x"/* bshopify-restore:');
    expect(restoreInjectedMarkers(injected)).toBe(source);
  });

  it("restores multiple placeholders inside one string", () => {
    const filePath = "extensions/x/__entry.js";
    const source = 'value: "__A__ and __B__",\n';
    const first = inject(source, filePath, "__A__", "aaa");
    const injected = inject(first, filePath, "__B__", "bbb");

    expect(injected).not.toMatch(/"aaa\/\*|bbb\/\*/);
    expect(restoreInjectedMarkers(injected)).toBe(source);
  });

  it("restores a quoted placeholder inside a Liquid output unit", () => {
    const filePath = "extensions/x/blocks/app-embed.liquid";
    const source = '{{ "__SHOPIFY_APP_PROXY_BASE__" }}\n';
    const injected = inject(
      source,
      filePath,
      "__SHOPIFY_APP_PROXY_BASE__",
      "https://proxy.example.com",
    );

    // The marker must sit after the whole {{ }} unit: comments are not
    // allowed inside Liquid output tags.
    expect(injected).toContain('{{ "https://proxy.example.com" }}{% comment %} bshopify-restore:');
    expect(restoreInjectedMarkers(injected)).toBe(source);
  });

  it("restores an unquoted placeholder inside a Liquid output unit", () => {
    const filePath = "extensions/x/blocks/app-embed.liquid";
    const source = "{{ __SHOPIFY_APP_PROXY_BASE__ }}\n";
    const injected = inject(
      source,
      filePath,
      "__SHOPIFY_APP_PROXY_BASE__",
      "https://proxy.example.com",
    );

    expect(injected).toContain("{{ https://proxy.example.com }}{% comment %} bshopify-restore:");
    expect(restoreInjectedMarkers(injected)).toBe(source);
  });

  it("restores a placeholder inside an HTML attribute value", () => {
    const filePath = "extensions/x/blocks/embed.html";
    const source = '<a href="__APP_URL__">go</a>\n';
    const injected = inject(source, filePath, "__APP_URL__", "https://example.com");

    expect(injected).toContain('<a href="https://example.com"<!-- bshopify-restore:');
    expect(restoreInjectedMarkers(injected)).toBe(source);
  });

  it("keeps markers inline in markup text content", () => {
    const filePath = "extensions/x/blocks/embed.html";
    const source = "<p>it's __URL__ fine</p>\n";
    const injected = inject(source, filePath, "__URL__", "https://example.com");

    // Text content is not a string literal: the marker stays inline (an
    // HTML comment in text renders nothing).
    expect(injected).toContain("https://example.com<!-- bshopify-restore:");
    expect(restoreInjectedMarkers(injected)).toBe(source);
  });

  it("skips a string-context marker whose value was edited mid-dev", () => {
    const filePath = "extensions/x/__entry.js";
    const source = 'const url = "__APP_URL__";\n';
    const injected = inject(source, filePath, "__APP_URL__", "https://example.com");
    const edited = injected.replace("https://example.com", "https://edited.example.com");

    expect(restoreInjectedMarkers(edited)).toBe(edited);
  });

  it("restores legacy markers written without a gap length", () => {
    const filePath = "extensions/x/__entry.js";
    const source = 'const url = "__APP_URL__";\n';
    // Old marker core: bshopify-restore:<b64(pattern)>:<valueLength>:<checksum>:<nonce>
    const legacyMarker =
      `/* ${restoreMarkerPrefix}:${encodeBase64Url("__APP_URL__")}:19:${createValueChecksum("https://example.com")}:00000000-0000-0000-0000-000000000000 */`;
    const legacy = source.replace("__APP_URL__", `https://example.com${legacyMarker}`);

    expect(restoreInjectedMarkers(legacy)).toBe(source);
  });
});

describe("transaction restore", () => {
  it("restores marker injections when the journal records no mapping", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bshopify-restore-"));
    tempDirs.push(cwd);
    const filePath = join(cwd, "blocks", "app-embed.liquid");
    await mkdir(join(cwd, "blocks"), { recursive: true });
    const source = '{{ "__SHOPIFY_APP_PROXY_BASE__" }}\n';
    await writeFile(filePath, source);

    const journalPath = join(cwd, "transaction.json");
    const transaction = await createFileTransaction(journalPath);
    await transaction.writeFile(
      filePath,
      inject(source, filePath, "__SHOPIFY_APP_PROXY_BASE__", "https://proxy.example.com"),
      {
        marker: createFileMarker(
          filePath,
          createRestoreMarker("__SHOPIFY_APP_PROXY_BASE__", "https://proxy.example.com"),
        ),
        pattern: "__SHOPIFY_APP_PROXY_BASE__",
        value: "https://proxy.example.com",
      },
    );

    // Crash: the journal survives but its mapping section was lost. The file
    // list still points at the injected file; markers carry the restore data.
    await writeJournalWithReplacements(journalPath, filePath, []);
    const restored = await restoreFileTransactionJournal(journalPath);

    expect(restored).toContain(filePath);
    await expect(readFile(filePath, "utf8")).resolves.toBe(source);
  });

  it("recovers the placeholder even when the journal mapping is stale", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bshopify-stale-"));
    tempDirs.push(cwd);
    const filePath = join(cwd, "blocks", "app-embed.liquid");
    await mkdir(join(cwd, "blocks"), { recursive: true });
    const source = '{{ "__SHOPIFY_APP_PROXY_BASE__" }}\n';
    await writeFile(filePath, source);

    const journalPath = join(cwd, "transaction.json");
    const transaction = await createFileTransaction(journalPath);
    await transaction.writeFile(
      filePath,
      inject(source, filePath, "__SHOPIFY_APP_PROXY_BASE__", "https://proxy.example.com"),
      {
        marker: createFileMarker(
          filePath,
          createRestoreMarker("__SHOPIFY_APP_PROXY_BASE__", "https://proxy.example.com"),
        ),
        pattern: "__SHOPIFY_APP_PROXY_BASE__",
        value: "https://proxy.example.com",
      },
    );

    // Simulate a stale journal: the recorded mapping no longer matches the
    // injected file, but the marker in the file still carries the truth.
    await writeJournalWithReplacements(journalPath, filePath, [
      {
        marker: "/* stale */",
        pattern: "__WRONG__",
        value: "stale-value",
      },
    ]);
    const restored = await restoreFileTransactionJournal(journalPath);

    expect(restored).toContain(filePath);
    await expect(readFile(filePath, "utf8")).resolves.toBe(source);
  });

  it("restores a markerless injection without rewriting a substring of the value", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bshopify-substr-"));
    tempDirs.push(cwd);
    const filePath = join(cwd, "shopify.extension.toml");
    const source = [
      'handle = "__CART_DRAWER_HANDLE__"',
      'path = "target/wasm32-unknown-unknown/release/bestupsell-cart-drawer-discount.wasm"',
      "",
    ].join("\n");
    await writeFile(filePath, source);

    const journalPath = join(cwd, "transaction.json");
    const transaction = await createFileTransaction(journalPath);
    const composed = composeInjection(
      source,
      filePath,
      "__CART_DRAWER_HANDLE__",
      "upsell-cart-drawer-discount",
      false,
    );
    await transaction.writeFile(filePath, composed.content, {
      pattern: "__CART_DRAWER_HANDLE__",
      value: "upsell-cart-drawer-discount",
    });

    const restored = await transaction.restore();

    expect(restored).toContain(filePath);
    await expect(readFile(filePath, "utf8")).resolves.toBe(source);
  });

  it("restores a markerless injection after later content is inserted above it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bshopify-shift-"));
    tempDirs.push(cwd);
    const filePath = join(cwd, "shopify.extension.toml");
    const source = [
      'handle = "__CART_DRAWER_HANDLE__"',
      'path = "target/wasm32-unknown-unknown/release/bestupsell-cart-drawer-discount.wasm"',
      "",
    ].join("\n");
    await writeFile(filePath, source);

    const journalPath = join(cwd, "transaction.json");
    const transaction = await createFileTransaction(journalPath);
    const composed = composeInjection(
      source,
      filePath,
      "__CART_DRAWER_HANDLE__",
      "upsell-cart-drawer-discount",
      false,
    );
    await transaction.writeFile(filePath, composed.content, {
      pattern: "__CART_DRAWER_HANDLE__",
      value: "upsell-cart-drawer-discount",
    });
    await writeFile(filePath, `uid = "gid://shopify/Function/1"\n${composed.content}`);

    await transaction.restore();

    await expect(readFile(filePath, "utf8")).resolves.toBe(
      `uid = "gid://shopify/Function/1"\n${source}`,
    );
  });

  it("restores a markerless injection on the rewritten line and keeps other edits", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bshopify-rewrite-"));
    tempDirs.push(cwd);
    const filePath = join(cwd, "shopify.extension.toml");
    const source = [
      'handle = "__CART_DRAWER_HANDLE__"',
      'path = "target/wasm32-unknown-unknown/release/bestupsell-cart-drawer-discount.wasm"',
      "",
    ].join("\n");
    await writeFile(filePath, source);

    const journalPath = join(cwd, "transaction.json");
    const transaction = await createFileTransaction(journalPath);
    const composed = composeInjection(
      source,
      filePath,
      "__CART_DRAWER_HANDLE__",
      "upsell-cart-drawer-discount",
      false,
    );
    await transaction.writeFile(filePath, composed.content, {
      pattern: "__CART_DRAWER_HANDLE__",
      value: "upsell-cart-drawer-discount",
    });
    await writeFile(
      filePath,
      [
        'uid = "gid://shopify/Function/1"',
        'handle = "upsell-cart-drawer-discount"  # rewritten surrounding text',
        'path = "target/wasm32-unknown-unknown/release/bestupsell-cart-drawer-discount.wasm"',
        "",
      ].join("\n"),
    );

    await transaction.restore();

    await expect(readFile(filePath, "utf8")).resolves.toBe(
      [
        'uid = "gid://shopify/Function/1"',
        'handle = "__CART_DRAWER_HANDLE__"  # rewritten surrounding text',
        'path = "target/wasm32-unknown-unknown/release/bestupsell-cart-drawer-discount.wasm"',
        "",
      ].join("\n"),
    );
  });

  it("restores two markerless injections when the later write sits earlier in the file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bshopify-order-"));
    tempDirs.push(cwd);
    const filePath = join(cwd, "shopify.extension.toml");
    const source = '__B__ = 1\n__A__ = 2\n';
    await writeFile(filePath, source);

    const journalPath = join(cwd, "transaction.json");
    const transaction = await createFileTransaction(journalPath);
    const first = composeInjection(source, filePath, "__A__", "aaa", false);
    await transaction.writeFile(filePath, first.content, {
      pattern: "__A__",
      value: "aaa",
    });
    const second = composeInjection(first.content, filePath, "__B__", "bbb", false);
    await transaction.writeFile(filePath, second.content, {
      pattern: "__B__",
      value: "bbb",
    });

    await transaction.restore();

    await expect(readFile(filePath, "utf8")).resolves.toBe(source);
  });

  it("does not rewrite a leftover substring after marker restore", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bshopify-marker-substr-"));
    tempDirs.push(cwd);
    const filePath = join(cwd, "shopify.extension.toml");
    const source = [
      'handle = "__CART_DRAWER_HANDLE__"',
      'path = "target/wasm32-unknown-unknown/release/bestupsell-cart-drawer-discount.wasm"',
      "",
    ].join("\n");
    await writeFile(filePath, source);

    const journalPath = join(cwd, "transaction.json");
    const transaction = await createFileTransaction(journalPath);
    const composed = composeInjection(
      source,
      filePath,
      "__CART_DRAWER_HANDLE__",
      "upsell-cart-drawer-discount",
      true,
    );
    await transaction.writeFile(filePath, composed.content, {
      marker: composed.marker,
      pattern: "__CART_DRAWER_HANDLE__",
      value: "upsell-cart-drawer-discount",
    });

    await transaction.restore();

    await expect(readFile(filePath, "utf8")).resolves.toBe(source);
  });

  it("does not rewrite a substring collision from a legacy markerless journal", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bshopify-legacy-substr-"));
    tempDirs.push(cwd);
    const filePath = join(cwd, "shopify.extension.toml");
    const source = [
      'handle = "__CART_DRAWER_HANDLE__"',
      'path = "target/wasm32-unknown-unknown/release/bestupsell-cart-drawer-discount.wasm"',
      "",
    ].join("\n");
    const composed = composeInjection(
      source,
      filePath,
      "__CART_DRAWER_HANDLE__",
      "upsell-cart-drawer-discount",
      false,
    );
    await writeFile(filePath, composed.content);
    const journalPath = join(cwd, "transaction.json");
    await writeJournalWithReplacements(journalPath, filePath, [
      {
        pattern: "__CART_DRAWER_HANDLE__",
        value: "upsell-cart-drawer-discount",
      },
    ]);

    await restoreFileTransactionJournal(journalPath);

    await expect(readFile(filePath, "utf8")).resolves.toBe(source);
  });

  it("restores an unparseable adjacent marker from the journal without a substring rewrite", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bshopify-stale-adj-"));
    tempDirs.push(cwd);
    const filePath = join(cwd, "blocks", "app-embed.liquid");
    await mkdir(join(cwd, "blocks"), { recursive: true });
    const marker = "{% comment %} bshopify-restore:stale {% endcomment %}";
    const source = '<div data-api-base="__SHOPIFY_APP_PROXY_BASE__"></div>\n';
    await writeFile(filePath, `<div data-api-base="/apps/fixture-dev${marker}"></div>\n`);
    const journalPath = join(cwd, "transaction.json");
    await writeJournalWithReplacements(journalPath, filePath, [
      {
        marker,
        pattern: "__SHOPIFY_APP_PROXY_BASE__",
        value: "/apps/fixture-dev",
      },
    ]);

    await restoreFileTransactionJournal(journalPath);

    await expect(readFile(filePath, "utf8")).resolves.toBe(source);
  });
});

async function writeJournalWithReplacements(
  journalPath: string,
  filePath: string,
  replacements: unknown[],
): Promise<void> {
  await writeFile(
    journalPath,
    `${JSON.stringify(
      {
        files: [
          {
            path: filePath,
            replacements,
          },
        ],
      },
      undefined,
      2,
    )}\n`,
  );
}
