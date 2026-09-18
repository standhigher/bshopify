import { describe, expect, it, vi } from "vitest";
import {
  formatShopifyCliForwardedArgs,
  getShopifyCliConfigExclusiveFlag,
  getShopifyCliConfigName,
  withoutShopifyCliConfigArgs,
} from "../src/app/runner/shopify-args";

describe("getShopifyCliConfigName", () => {
  it("uses the Shopify environment name for shopify.app.<name>.toml", () => {
    expect(getShopifyCliConfigName("shopify.app.dev.toml")).toBe("dev");
    expect(getShopifyCliConfigName("shopify.app.preview.toml")).toBe("preview");
  });

  it("passes the default app file name through so Shopify CLI cannot fall back to last-used config", () => {
    expect(getShopifyCliConfigName("shopify.app.toml")).toBe("shopify.app.toml");
  });
});

describe("withoutShopifyCliConfigArgs", () => {
  it("removes --config / -c flags and their values", () => {
    expect(withoutShopifyCliConfigArgs(["--config", "test", "--reset"])).toEqual(["--reset"]);
    expect(withoutShopifyCliConfigArgs(["-c", "test", "--reset"])).toEqual(["--reset"]);
    expect(withoutShopifyCliConfigArgs(["--config=test", "--reset"])).toEqual(["--reset"]);
    expect(withoutShopifyCliConfigArgs(["-c=test", "--reset"])).toEqual(["--reset"]);
  });

  it("keeps unrelated flags", () => {
    expect(withoutShopifyCliConfigArgs(["--reset", "--verbose"])).toEqual(["--reset", "--verbose"]);
  });
});

describe("getShopifyCliConfigExclusiveFlag", () => {
  it("detects --reset and --client-id after stripping extra --config flags", () => {
    expect(getShopifyCliConfigExclusiveFlag(["--reset"])).toBe("--reset");
    expect(getShopifyCliConfigExclusiveFlag(["--reset=true"])).toBe("--reset");
    expect(getShopifyCliConfigExclusiveFlag(["--client-id", "gid://shopify/App/1"])).toBe(
      "--client-id",
    );
    expect(getShopifyCliConfigExclusiveFlag(["--config", "test", "--reset"])).toBe("--reset");
  });

  it("does not treat --reset=false as exclusive with --config", () => {
    expect(getShopifyCliConfigExclusiveFlag(["--reset=false", "--verbose"])).toBeUndefined();
  });
});

describe("formatShopifyCliForwardedArgs", () => {
  it("always forwards the mapped Shopify CLI config before extra args", () => {
    expect(formatShopifyCliForwardedArgs("shopify.app.dev.toml", ["--verbose"])).toEqual([
      "--config",
      "dev",
      "--verbose",
    ]);
    expect(formatShopifyCliForwardedArgs("shopify.app.toml", ["--verbose"])).toEqual([
      "--config",
      "shopify.app.toml",
      "--verbose",
    ]);
  });

  it("omits --config when extra args include Shopify CLI flags exclusive with it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      expect(formatShopifyCliForwardedArgs("shopify.app.dev.toml", ["--reset"])).toEqual(["--reset"]);
      expect(formatShopifyCliForwardedArgs("shopify.app.toml", ["--reset"])).toEqual(["--reset"]);
      expect(
        formatShopifyCliForwardedArgs("shopify.app.dev.toml", ["--client-id", "gid://shopify/App/1"]),
      ).toEqual(["--client-id", "gid://shopify/App/1"]);
      expect(formatShopifyCliForwardedArgs("shopify.app.dev.toml", ["--reset=true"])).toEqual([
        "--reset=true",
      ]);
      expect(warn.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
        "Omitted --config because Shopify CLI does not allow it with --reset / --client-id. Injections still used shopify.app.dev.toml",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("still forwards --config when --reset=false is passed", () => {
    expect(formatShopifyCliForwardedArgs("shopify.app.dev.toml", ["--reset=false"])).toEqual([
      "--config",
      "dev",
      "--reset=false",
    ]);
  });

  it("strips extra --config flags and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      expect(
        formatShopifyCliForwardedArgs("shopify.app.dev.toml", ["-c", "test", "--verbose"]),
      ).toEqual(["--config", "dev", "--verbose"]);
      expect(warn.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
        "Ignored --config / -c in extra Shopify args",
      );
    } finally {
      warn.mockRestore();
    }
  });
});
