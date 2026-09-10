import { describe, expect, it, vi } from "vitest";
import {
  formatShopifyCliForwardedArgs,
  getShopifyCliConfigName,
  withoutShopifyCliConfigArgs,
} from "../src/app/runner/config";

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

describe("formatShopifyCliForwardedArgs", () => {
  it("always forwards the mapped Shopify CLI config before extra args", () => {
    expect(formatShopifyCliForwardedArgs("shopify.app.dev.toml", ["--reset"])).toEqual([
      "--config",
      "dev",
      "--reset",
    ]);
    expect(formatShopifyCliForwardedArgs("shopify.app.toml", ["--reset"])).toEqual([
      "--config",
      "shopify.app.toml",
      "--reset",
    ]);
  });

  it("strips extra --config flags and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      expect(
        formatShopifyCliForwardedArgs("shopify.app.dev.toml", ["-c", "test", "--reset"]),
      ).toEqual(["--config", "dev", "--reset"]);
      expect(warn.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
        "Ignored --config / -c in extra Shopify args",
      );
    } finally {
      warn.mockRestore();
    }
  });
});
