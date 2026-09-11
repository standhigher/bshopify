# Contributing to bshopify

**English** | [中文](#贡献指南)

Thanks for helping improve `@standhigher/bshopify`. Please read this guide before opening an issue or pull request.

## Ways to contribute

- Report bugs with enough context to reproduce them
- Propose features that fit the Enhanced Shopify CLI positioning: wrap official `shopify`, do not reimplement it
- Fix bugs, add tests, or improve docs

Please open an issue before large refactors or new command surfaces.

## Development setup

Requirements:

- Node.js >= 22.12.0
- [Shopify CLI](https://shopify.dev/docs/api/shopify-cli) if you need to exercise `app dev` / `app deploy`

```bash
git clone https://github.com/standhigher/bshopify.git
cd bshopify
npm install
```

Useful commands:

```bash
npm run test          # vitest
npm run typecheck     # tsc --noEmit
npm run build         # tsup
npm run check         # typecheck + test + build + verify:dist
npm run dev -- --help # run the CLI from source
```

Please run `npm run check` before opening a pull request.

## Project conventions

- Keep the CLI an orchestration layer over official Shopify CLI. Unextended commands should keep passing through to `shopify`.
- Command entry files stay thin: parse args, inject dependencies, orchestrate. Put config, context, injections, locks, and subprocess calls in nearby responsibility files.
- Prefer existing module boundaries under `src/app`, `src/extension`, and `src/utils`.
- Add or update tests in `tests/` for behavior changes.
- Do not commit secrets, Shopify tokens, or generated `.bshopify/` state.

Commit messages follow Conventional Commits, for example:

```text
feat: ...
fix: ...
docs: ...
refactor: ...
```

## Pull requests

1. Keep the change focused. Split unrelated work into separate PRs.
2. Fill in the pull request template: what changed, why, and how you tested it.
3. Link related issues when they exist.

---

# 贡献指南

感谢帮助改进 `@standhigher/bshopify`。提 Issue 或 PR 前请先阅读本节。

## 可以怎么参与

- 用可复现的上下文报告缺陷
- 提出符合 Enhanced Shopify CLI 定位的功能：包装官方 `shopify`，不要重造轮子
- 修 bug、补测试、改文档

较大的重构或新增命令面，请先开 Issue 讨论。

## 本地开发

环境要求：

- Node.js >= 22.12.0
- 若要实际跑 `app dev` / `app deploy`，需要 [Shopify CLI](https://shopify.dev/docs/api/shopify-cli)

```bash
git clone https://github.com/standhigher/bshopify.git
cd bshopify
npm install
```

常用命令：

```bash
npm run test
npm run typecheck
npm run build
npm run check
npm run dev -- --help
```

提 PR 前请先跑 `npm run check`。

## 约定

- CLI 是官方 Shopify CLI 的编排层；未扩展命令继续透传 `shopify`。
- 命令入口保持薄：参数解析、依赖注入和编排；配置、上下文、注入、锁、子进程放到邻近职责文件。
- 优先沿用 `src/app`、`src/extension`、`src/utils` 现有边界。
- 行为变化请在 `tests/` 补测试。
- 不要提交密钥、Shopify token，或生成的 `.bshopify/` 状态。

提交信息使用 Conventional Commits，例如 `feat:`、`fix:`、`docs:`、`refactor:`。
