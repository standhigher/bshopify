# @standhigher/bshopify

> Enhanced Shopify CLI · 基于官方 Shopify CLI 的上层封装，增加和扩展能力

[English](./README.md) | **中文**

## 产品定位

`bshopify` 是 **Enhanced Shopify CLI**：基于官方 Shopify CLI 的上层封装。未扩展的命令原样透传 `shopify`，在此之上按能力增加编排与扩展。

命令入口：`bshopify` 或短命令 `bs`。

## 实现功能

当前已落地的能力只有 Extension 环境感知；后续会按行往这张表里加。

| 能力 | 状态 | 说明 |
|-|-|-|
| Extension 环境感知 | 已实现 | 感知当前环境的 `shopify.app*.toml`，在 `dev` / `deploy` 时把配置注入到 extension |
| 多 Theme | 规划中 | 支持 Shopify 多 theme 工作流 |

## 环境要求

- Node.js >= 22.12.0
- 本机或项目内已安装 [Shopify CLI](https://shopify.dev/docs/api/shopify-cli)

## Built by standhigher

`@standhigher/bshopify` 由 standhigher 为 Shopify App 团队打造。欢迎访问
[standhigher Products](https://standhigher.github.io/shopify-polaris-charts/products/?utm_source=GitHub&utm_medium=social&utm_content=standhigher-bshopify)，
探索帮助商家增长的应用。

| App | 可帮助您 |
| --- | --- |
| [BestTrack](https://apps.shopify.com/besttrack?utm_source=GitHub&utm_medium=social) | 改善订单追踪与购后客户体验。 |
| [BestUpsell](https://apps.shopify.com/bestupsellapp?utm_source=GitHub&utm_medium=social) | 通过 Upsell 优惠提升客单价。 |
| [BestFeed AI](https://apps.shopify.com/bestfeed?locale=zh-CN&utm_source=GitHub&utm_medium=social) | 通过 AI 辅助商品 Feed，帮助商品在各渠道获得更好表现。 |
| [SonarFulfill](https://apps.shopify.com/sonarfulfill?locale=zh-CN&utm_source=GitHub&utm_medium=social) | 通过履约工作流帮助订单持续流转。 |

## 安装

在 Shopify app 项目里作为开发依赖安装（推荐）：

```bash
npm install -D @standhigher/bshopify
```

也可以全局安装：

```bash
npm install -g @standhigher/bshopify
```

## 基本使用

在 Shopify app 项目根目录初始化：

```bash
bshopify app init
```

`init` 会检查项目并补齐缺失文件：

- `bshopify.config.mjs` — runner 配置
- `extensions/*/__entry.js` — 每个扩展的注入入口
- `.gitignore` 追加 `.bshopify/`
- Git clean filter（`git add` 时还原注入值）和 pre-commit hook

`init` **不会改写 `package.json`**。自行接上脚本：

```json
{
  "scripts": {
    "dev": "bshopify app dev",
    "deploy": "bshopify app deploy"
  }
}
```

按项目需要改 `bshopify.config.mjs` 和 `__entry.js`，然后照常开发：

```bash
npm run dev
# 或
bshopify app dev --config test
```

部署：

```bash
bshopify app deploy                       # 交互选择环境
bshopify app deploy --config production   # 直接部署 production
```

### 命令一览

| 命令 | 用途 |
|-|-|
| `bshopify app init` | 接入项目。`--check` 只检查不写文件；`--cwd <path>` 指定目录 |
| `bshopify app dev` | 注入后执行 `shopify app dev`。`--config <key>` 选择 `configFiles` 环境，默认 `dev` |
| `bshopify app deploy` | 注入后执行 `shopify app deploy`。`--config`、`--dry-run`、`--yes`、`--confirm-production` |
| `bshopify app clear` | 删除 bshopify 生成文件，还原接入前状态。`--yes` 跳过确认 |
| 其它命令 | 原样透传本机 Shopify CLI |

## 配置示例

`init` 生成的 `bshopify.config.mjs` 大致如下，按环境改 TOML 路径即可：

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

  // 可选：把 JSON/TOML 注入到 __entry 的 ctx.<key>
  envFiles: {
    // urls: "config/urls.json",
    // extra: ["config/a.json", "config/a.toml"],
  },

  failOnUnresolvedPlaceholders: true,
};
```

常用字段：

- **`configFiles`**：环境名 → 项目根目录的 `shopify.app.toml` 或 `shopify.app.<name>.toml`。`dev` / `deploy` 的 `--config <key>` 按这里选。文件名会转成传给 Shopify CLI 的 `--config`，例如 `shopify.app.preview.toml` → `shopify app dev --config preview`；默认文件 `shopify.app.toml` 不传 `--config`。
- **`envFiles`**（可选）：key → 一个或多个相对项目根的 JSON/TOML。每个 key 成为 `ctx.<key>`；多个文件按顺序浅合并，后者覆盖同名键。文件缺失只警告并跳过。
- **`failOnUnresolvedPlaceholders`**：注入后若目标文件仍有未替换的占位符，是否直接失败。

TOML 暂时缺文件时，`init` 会复用已有的 `shopify.app*.toml`；一个都没有则调用一次 `shopify app config link` 生成默认文件，各环境先指向它。

## Extension Entry 示例

`init` 会在每个 `extensions/<name>/` 下生成 `__entry.js`。未改动的模板在 `dev` / `deploy` 时会被跳过；加上 injections 后才会执行。

目标文件里先放占位符，例如 `extensions/my-embed/blocks/app-embed.liquid`：

```liquid
<script src="__APP_URL__/widget.js" data-origin="__WIDGET_ORIGIN__"></script>
```

再在 `__entry.js` 里声明替换。`ctx.appConfig` 是当前环境 TOML 的解析结果；`envFiles` 里配置的 key 会出现在 `ctx` 上：

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

对应的 `envFiles` 示例：

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

`file` 相对当前 extension 目录；`pattern` 必须在目标文件中唯一匹配。可选钩子还有 `validate` / `beforeDeploy` / `afterDeploy` / `onError`，部署链路会按顺序调用。
