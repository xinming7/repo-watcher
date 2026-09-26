# GitHub Repo Watcher

基于 Cloudflare Workers 的 GitHub 仓库更新监控工具，自动检测 Release、Commit、Actions、Issue、PR 等变化，通过 Telegram Bot / Discord / Slack / Webhook 推送通知。自带网页 Dashboard，所有配置可视化完成。

## 架构

```
┌──────────────────┐     ┌──────────────┐     ┌─────────────┐
│  GitHub Actions  │────▶│  Cloudflare  │────▶│  GitHub API │
│  (每30分钟 cron) │     │  Worker      │     └─────────────┘
│                  │     │  /api/cron/  │
│  check.yml       │     │  trigger     │────▶ Telegram Bot
│                  │     │              │────▶ Discord / Slack / Webhook
└──────────────────┘     │              │
                         │  Cloudflare  │
                         │  KV 存储     │────▶ Update Hub (可选)
                         │  (状态+配置)  │
                         └──────────────┘
                                │
                                ▼
                           Web Dashboard
                    (自定义域名访问)
```

**定时触发由 GitHub Actions 驱动**（`.github/workflows/check.yml`），通过调用 Worker 的 `/api/cron/trigger` 端点触发检查。不在 Cloudflare 侧注册 cron trigger，避免部署时被覆盖。

## 功能

### 监控类型
- ✅ **Release** — 新版本发布（支持 per-repo 级别跳过 Pre-release）
- ✅ **Commit** — 新提交推送（单条/多条自动合并通知）
- ✅ **Actions** — CI/CD 运行结果（可选仅通知失败）
- ✅ **Issue** — 新 Issue 创建（可按 label 过滤）
- ✅ **PR** — 新 Pull Request
- ✅ **PR Merge** — PR 合并通知
- ✅ **Fork** — Fork 数量变化
- ✅ **Star 里程碑** — 达到配置阈值时通知（如 100/500/1000）
- ✅ **关键词告警** — Commit 消息匹配关键词时告警

### 通知渠道
- ✅ Telegram Bot（HTML 格式，带 `#GitHub仓库更新` 等 hashtag 标签）
- ✅ Discord Webhook
- ✅ Slack Webhook
- ✅ 自定义 Webhook

### Dashboard 功能
- ✅ 运行状态面板（仓库数、通知数、API 配额、最后检查时间）
- ✅ Telegram / Discord / Slack / Webhook 配置
- ✅ 仓库管理（添加/删除/置顶/排序/监控项开关/**批量操作**）
- ✅ **仓库搜索**：按名称快速筛选
- ✅ ⭐ 从 GitHub Star 列表批量导入仓库
- ✅ 通知设置（Star 里程碑阈值、周报摘要开关）
- ✅ 关键词告警规则管理（仓库名自动补全已监控仓库）
- ✅ 通知历史记录（**类型筛选 / 关键词搜索 / 分页加载**，支持清空）
- ✅ 仓库对比（Stars / Forks / Issues / 语言 / 创建时间）
- ✅ ⭐ Stars 趋势（**SVG 多系列折线图 + 图例**）
- ✅ 周报摘要（每周一自动推送）
- ✅ **配置备份**：导出/导入配置（JSON 格式，不含密钥）
- ✅ 深色 / 浅色 / 跟随系统 主题切换
- ✅ **自动刷新**：每 60 秒刷新状态和历史，标签页不可见时暂停
- ✅ 访问密码保护（timingSafeEqual 防时序攻击）
- ✅ **登录限流**：per-IP 5 次失败 / 15 分钟锁定
- ✅ **Session 登出**：`POST /api/auth/logout` 撤销 session
- ✅ GitHub API 配额查看
- ✅ **移动端适配**：响应式布局、表格横向滚动

### 过滤器
- ✅ 全局忽略 Pre-release
- ✅ **Per-repo Pre-release 开关**：每个仓库独立的 `🚫 Pre` 按钮
- ✅ Actions 仅通知失败
- ✅ 忽略指定作者的 Commit
- ✅ 忽略指定 Label 的 Issue
- ✅ Release Tag 关键词过滤
- ✅ Commit 关键词过滤

### 批量操作
- ✅ 全选 / 反选
- ✅ 批量开启 / 关闭指定监控项
- ✅ 批量删除仓库

## 安全特性

- ✅ 访问密码使用 `timingSafeEqual` 防时序攻击
- ✅ 登录 per-IP 限流（5 次失败 / 15 分钟锁定）
- ✅ Cron Secret 使用 `timingSafeEqual` 比较
- ✅ RSS 订阅源需要 token 鉴权（设置了密码时）
- ✅ 配置返回时 Token/Webhook URL 掩码处理
- ✅ 导入配置时自动清除掩码占位符
- ✅ GitHub API 错误信息脱敏（不暴露上游错误详情）
- ✅ `escapeHTML` / `truncate` 防 null 输入
- ✅ 仓库名通过 `parseRepoInput` 验证（防路径注入）

## 部署步骤

### 1. 创建 Telegram Bot

1. 在 Telegram 搜索 `@BotFather`
2. 发送 `/newbot`，按提示创建 Bot
3. 记录返回的 `Bot Token`
4. 获取 Chat ID：
   - 私聊：给 Bot 发一条消息，访问 `https://api.telegram.org/bot<TOKEN>/getUpdates` 获取 chat_id
   - 群组：将 Bot 加入群组，同样访问 getUpdates 获取 chat_id

### 2. 初始化 Cloudflare 资源

```bash
cd github-repo-watcher
npm install

# 登录 Cloudflare
npx wrangler login

# 创建 KV 命名空间
npx wrangler kv:namespace create WATCHER_STATE
# 输出示例: { id = "xxxxxxxxxxxx" }
# 将 id 填入 wrangler.toml 对应位置
# ⚠️ 公开仓库请勿提交真实 namespace id：本地填好后不要 commit，
#    或部署时用 `wrangler deploy --var` / 私有配置注入
```

### 3. 配置 GitHub Secrets

在 GitHub 仓库 Settings → Secrets and variables → Actions 中添加：

| Secret | 说明 | 获取方式 |
|--------|------|----------|
| `CLOUDFLARE_API_TOKEN` | CF 部署 Token | https://dash.cloudflare.com/profile/api-tokens → Edit Cloudflare Workers 模板 |
| `CLOUDFLARE_ACCOUNT_ID` | CF 账户 ID | `npx wrangler whoami` 或 Dashboard 右侧栏 |
| `CRON_SECRET` | 定时触发鉴权 | 自定义随机字符串，需与 Worker 的 CRON_SECRET secret 一致 |

同时在 **Actions → Variables** 中添加：

| Variable | 说明 |
|----------|------|
| `WORKER_URL` | Worker 对外地址（如 `https://xxx.workers.dev` 或自定义域名），定时检查用；不写进仓库，避免硬编码个人域名 |

### 4. 部署

推送到 `main` 分支会自动通过 GitHub Actions 部署：

```bash
git push origin main
```

也可手动部署：

```bash
npx wrangler deploy
```

### 5. 设置 Cloudflare Secrets

首次部署后，通过 `wrangler secret put` 设置敏感配置：

```bash
# Update Hub 地址（可选）
echo "https://<your-update-hub-url>" | npx wrangler secret put UPDATE_HUB_URL

# Update Hub Token（可选）
echo "<your-token>" | npx wrangler secret put UPDATE_HUB_TOKEN

# 定时触发鉴权
echo "<your-random-secret>" | npx wrangler secret put CRON_SECRET

# Dashboard 回链地址（周报通知中的链接）
echo "https://<your-custom-domain>" | npx wrangler secret put DASHBOARD_URL
```

### 6. 配置自定义域名（可选）

```bash
npx wrangler custom-domain add <your-custom-domain>
```

### 安全须知

- **fail-closed**：未设置访问密码时，除 `/api/auth/password`（初始化密码）外所有 API 一律 401。首次访问网页会引导设置初始密码（至少 8 位）。
- 密码比较使用「先 SHA-256 再 `timingSafeEqual`」的恒定时间比较；登录失败按 IP 限速（5 次 / 15 分钟）。
- 通知渠道（Discord / Slack / Webhook）只允许 `https://` 地址；所有外发请求带 15s 超时。
- RSS 需要凭据：`/rss?token=<会话令牌或密码>`。URL 中的凭据会进访问日志，建议使用登录后获得的会话令牌而非密码。
- 上报 Update Hub 时若项目不存在会自动注册（`github-repo-watcher`），避免数据静默丢失。

### 7. 通过网页配置

访问 Worker URL，在 Dashboard 中完成所有配置：

1. **Telegram 设置**：填入 Bot Token 和 Chat ID
2. **添加仓库**：输入 `owner/repo` 格式或 GitHub URL
3. **测试连接**：点击「测试 Telegram」确认配置正确
4. **手动检查**：点击「立即检查」触发首次扫描

所有敏感配置自动保存到 KV，密钥在 API 返回时自动掩码。

## API 端点

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| GET | `/` | Dashboard 网页 | 否 |
| GET | `/api/status` | 运行状态 | 是 |
| GET | `/api/config` | 获取配置（Token 掩码） | 是 |
| POST | `/api/config` | 保存配置 | 是 |
| GET | `/api/repos` | 仓库列表 | 是 |
| POST | `/api/repos` | 添加仓库 | 是 |
| PUT | `/api/repos/{owner/repo}` | 更新仓库设置（含 per-repo 选项） | 是 |
| DELETE | `/api/repos/{owner/repo}` | 删除仓库 | 是 |
| GET | `/api/history` | 通知历史 | 是 |
| DELETE | `/api/history` | 清空通知历史 | 是 |
| POST | `/api/check` | 手动触发检查 | 是 |
| POST | `/api/test-telegram` | 测试 Telegram | 是 |
| GET | `/api/github/starred` | 获取 Star 列表 | 是 |
| GET | `/api/repos/activity` | 仓库最新动态 | 是 |
| GET | `/api/repos/compare` | 仓库对比数据 | 是 |
| GET | `/api/summary` | 周报摘要 | 是 |
| GET | `/api/quota` | GitHub API 配额 | 是 |
| POST | `/api/auth` | 登录验证 | 否 |
| POST | `/api/auth/password` | 设置/修改密码 | 否 |
| POST | `/api/auth/logout` | 撤销 session | 是 |
| POST | `/api/cron/trigger` | 定时触发检查 | Bearer Token（timingSafeEqual） |
| GET | `/rss` | RSS 订阅源 | Token 参数（设置了密码时） |

## 通知样式

### Release
```
🏷️ New Release
MetaCubeX/mihomo
v1.19.30
Tag: v1.19.30
Date: 2026/9/25
#GitHub仓库更新 #Release
View on GitHub →
```

### Commit
```
📝 New Commit
vercel/next.js
abc1234 Fix build error
By octocat · 2026/9/25 10:00:00
#GitHub仓库更新 #Commit
View on GitHub →
```

### 多条 Commit
```
📝 3 New Commits
vercel/next.js
• abc1234 Fix build error
• def5678 Add new feature
• ghi9012 Update docs
#GitHub仓库更新 #Commits
View changes →
```

### 关键词告警
```
🔔 Keyword Alert
MetaCubeX/mihomo
Keyword: CVE
abc1234 fix: patch CVE-2026-xxxx
#GitHub仓库更新 #关键词告警
View on GitHub →
```

### Star 里程碑
```
⭐ Star Milestone!
MetaCubeX/mihomo
Reached 500 stars!
Milestone: 500
#GitHub仓库更新 #Star
View on GitHub →
```

## 定时检查机制

- **触发方式**：GitHub Actions `check.yml`，每 30 分钟调用 `/api/cron/trigger`
- **防重复**：KV 存储每个仓库的最后检查 ID，只通知新增内容
- **防旧通知**：Release 检查有 24 小时发布时间过滤，超过 24 小时的旧 Release 不会通知
- **首次静默**：首次添加仓库时记录当前状态，不发送历史通知
- **自动刷新**：Dashboard 每 60 秒自动刷新状态和历史（标签页不可见时暂停）

## 项目结构

```
github-repo-watcher/
├── .github/workflows/
│   ├── check.yml          # 定时检查（每30分钟调用 /api/cron/trigger）
│   └── deploy.yml         # 自动部署（push to main）
├── src/
│   └── index.js           # Worker 主逻辑（后端 API + 前端 Dashboard HTML）
├── package.json
├── wrangler.toml          # Cloudflare Worker 配置（不含敏感信息）
└── README.md
```

### 配置存储

| 位置 | 内容 |
|------|------|
| `wrangler.toml [vars]` | `CRON_SCHEDULE`（非敏感） |
| Cloudflare Secrets | `UPDATE_HUB_URL`、`UPDATE_HUB_TOKEN`、`CRON_SECRET`、`DASHBOARD_URL` |
| GitHub Actions Secrets | `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`CRON_SECRET` |
| Cloudflare KV | Telegram Token/Chat ID、GitHub Token、Webhook URL、访问密码、仓库列表、通知历史 |

## License

MIT
