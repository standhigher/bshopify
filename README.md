# @standhigher/bshopify

> Enhanced Shopify CLI · an upper-layer wrapper around the official Shopify CLI that adds and extends capabilities

**English** | [中文](./README.zh-CN.md)

## Positioning

`bshopify` is an **Enhanced Shopify CLI**: an upper-layer wrapper around the official Shopify CLI. Unextended commands pass through to `shopify`; extra capabilities are layered on top.

Entrypoints: `bshopify` or the short alias `bs`.

## Features

Only extension environment awareness is available today. New capabilities will be added as rows in this table.

| Capability | Status | Description |
|-|-|-|
| Extension environment awareness | Available | Reads the current `shopify.app*.toml` and injects it into extensions during `dev` / `deploy` |
| Multi-theme | Planned | Shopify multi-theme workflows |

## Requirements

- Node.js >= 22.12.0
- [Shopify CLI](https://shopify.dev/docs/api/shopify-cli) installed globally or in the project

## Built by standhigher

`@standhigher/bshopify` is built by standhigher for Shopify app teams. Explore
[standhigher Products](https://standhigher.github.io/shopify-polaris-charts/products/?utm_source=GitHub&utm_medium=social&utm_content=standhigher-bshopify)
to discover apps that help merchants grow.

| App | What it helps with |
| --- | --- |
| [BestTrack](https://apps.shopify.com/besttrack?utm_source=GitHub&utm_medium=social) | Order tracking and post-purchase customer experience. |
| [BestUpsell](https://apps.shopify.com/bestupsellapp?utm_source=GitHub&utm_medium=social) | Upsell offers designed to increase average order value. |
| [BestFeed AI](https://apps.shopify.com/bestfeed?locale=zh-CN&utm_source=GitHub&utm_medium=social) | AI-assisted product feeds that help products perform across channels. |
| [SonarFulfill](https://apps.shopify.com/sonarfulfill?locale=zh-CN&utm_source=GitHub&utm_medium=social) | Fulfillment workflows that help keep orders moving. |

## Install

Install as a local dependency inside a Shopify app project (recommended):

```bash
npm install -D @standhigher/bshopify
```

Or globally:

```bash
npm install -g @standhigher/bshopify
```

## Basic usage

From the root of a Shopify app project:

```bash
bshopify app init
```

`init` checks the project and fills in whatever is missing:

- `bshopify.config.mjs` — runner config
- `extensions/*/__entry.js` — per-extension injection entry
- `.gitignore` appends `.bshopify/`
- Git clean filter (restores injected values on `git add`) and a pre-commit hook

`init` **never rewrites `package.json`**. Wire the scripts yourself:

```json
{
  "scripts": {
    "dev": "bshopify app dev",
    "deploy": "bshopify app deploy"
  }
}
```

Edit `bshopify.config.mjs` and `__entry.js` as needed, then develop as usual:

```bash
npm run dev
# or
bshopify app dev --config test
```

Deploy:

```bash
bshopify app deploy                       # pick an environment interactively
bshopify app deploy --config production   # deploy production directly
```

### Commands

| Command | Purpose |
|-|-|
| `bshopify app init` | Bootstrap. `--check` is read-only; `--cwd <path>` targets a directory |
| `bshopify app dev` | Inject, then run `shopify app dev`. `-c` / `--config <key>` selects a `configFiles` environment (default `dev`) |
| `bshopify app deploy` | Inject, then run `shopify app deploy`. `-c` / `--config`, `--dry-run`, `--yes`, `--confirm-production` |
| `bshopify app clear` | Remove generated files and restore the pre-bootstrap state. `--yes` skips confirmation |
| Any other command | Passed through to the local Shopify CLI |

## Configuration example

`init` writes a `bshopify.config.mjs` like this — adjust the TOML paths per environment:

```js
// @ts-check
/**
 * @typedef {Object} BshopifyRunnerConfig
 * @property {Record<string, string>} [configFiles]
 * @property {Record<string, string | string[]>} [envFiles]
 * @property {boolean} [failOnUnresolvedPlaceholders]
 */

/** @type {BshopifyRunnerConfig} */
export default {
  configFiles: {
    dev: "shopify.app.dev.toml",
    test: "shopify.app.test.toml",
    production: "shopify.app.production.toml",
  },

  // Optional: inject JSON/TOML into __entry as ctx.<key>
  envFiles: {
    // urls: "config/urls.json",
    // extra: ["config/a.json", "config/a.toml"],
  },

  failOnUnresolvedPlaceholders: true,
};
```

Fields:

- **`configFiles`**: environment name → a root-level `shopify.app.toml` or `shopify.app.<name>.toml`. `--config <key>` on `dev` / `deploy` selects by this key. The file name becomes the Shopify CLI `--config`, e.g. `shopify.app.preview.toml` → `shopify app dev --config preview`; `shopify.app.toml` is passed as `--config shopify.app.toml`.
- **`envFiles`** (optional): key → one or more JSON/TOML files relative to the project root. Each key becomes `ctx.<key>`; multiple files are shallow-merged in order, later files winning. A missing file only warns and is skipped.
- **`failOnUnresolvedPlaceholders`**: fail when an injection leaves unresolved placeholders in a target file.

If the mapped TOML files are missing, `init` reuses any existing `shopify.app*.toml`. If none exist, it runs `shopify app config link` once to create a default file and points every environment at it.

## Extension Entry example

`init` writes `extensions/<name>/__entry.js` under each extension. Untouched templates are skipped during `dev` / `deploy`; they run only after you add injections.

Put placeholders in the target file, e.g. `extensions/my-embed/blocks/app-embed.liquid`:

```liquid
<script src="__APP_URL__/widget.js" data-origin="__WIDGET_ORIGIN__"></script>
```

Then declare replacements in `__entry.js`. `ctx.appConfig` is the parsed TOML for the current environment; keys from `envFiles` show up on `ctx`:

```js
// @ts-check
/** @type {BshopifyExtensionLifecycle} */
export default {
  async prepare(ctx) {
    return {
      injections: [
        {
          file: "blocks/app-embed.liquid",
          strategy: "replace",
          pattern: "__APP_URL__",
          value: ctx.appConfig.application_url,
        },
        {
          file: "blocks/app-embed.liquid",
          strategy: "replace",
          pattern: "__WIDGET_ORIGIN__",
          value: ctx.urls?.widgetOrigin,
        },
      ],
    };
  },
};
```

Matching `envFiles` setup:

```js
export default {
  configFiles: {
    dev: "shopify.app.dev.toml",
    production: "shopify.app.production.toml",
  },
  envFiles: {
    urls: "config/urls.json",
  },
};
```

```json
{
  "widgetOrigin": "https://cdn.example.com"
}
```

`file` is relative to the current extension directory; `pattern` must match uniquely in the target file. Optional hooks `validate` / `beforeDeploy` / `afterDeploy` / `onError` run on the deploy path in that order.

## Changelog

See [0.1.x](./docs/changelog/0.1.md).
