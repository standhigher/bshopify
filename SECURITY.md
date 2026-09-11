# Security Policy

**English** | [中文](#安全政策)

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| < 0.1   | No        |

Please upgrade to the latest published `@standhigher/bshopify` release when reporting issues.

## Reporting a vulnerability

Do **not** open a public issue for security reports.

Use [GitHub Private Vulnerability Reporting](https://github.com/standhigher/bshopify/security/advisories/new) instead.

Please include:

- Affected version (`bshopify --version`)
- Impact and a clear reproduction
- Whether you already have a suggested fix

We will acknowledge the report and keep you updated as we investigate. After a fix is released, we may publish a GitHub Security Advisory.

This project wraps Shopify CLI and injects config into local Shopify app / extension files. Reports that involve leaked tokens, unexpected file writes, or command injection in the runner are especially useful.

---

# 安全政策

## 支持的版本

| 版本  | 是否支持 |
| ----- | -------- |
| 0.1.x | 是       |
| < 0.1 | 否       |

报告问题前请先升级到最新发布的 `@standhigher/bshopify`。

## 如何报告漏洞

**不要**用公开 Issue 报告安全问题。

请使用 [GitHub Private Vulnerability Reporting](https://github.com/standhigher/bshopify/security/advisories/new)。

请尽量提供：

- 受影响版本（`bshopify --version`）
- 影响范围和可复现步骤
- 若已有修复思路，也可以一并附上

我们会确认收到报告，并在排查过程中同步进展。修复发布后，可能会公开 GitHub Security Advisory。
