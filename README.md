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
- ✅ **Release** — 新版本发布（含 Pre-release 标记）
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
- ✅ 仓库管理（添加/删除/置顶/排序/监控项开关）
- ✅ ⭐ 从 GitHub Star 列表批量导入仓库
- ✅ 通知设置（Star 里程碑阈值、周报摘要开关）
- ✅ 关键词告警规则管理
- ✅ 通知历史记录（支持清空）
- ✅ 仓库对比（Stars / Forks / Issues / 语言 / 创建时间）
- ✅ 周报摘要（每周一自动推送）
- ✅ 深色 / 浅色 / 跟随系统 主题切换
- ✅ 折叠展开动画
- ✅ 访问密码保护（timingSafeEqual 防时序攻击）
- ✅ GitHub API 配额查看

### 过滤器
- ✅ 忽略 Pre-release
- ✅ Actions 仅通知失败
- ✅ 忽略指定作者的 Commit
- ✅ 忽略指定 Label 的 Issue
- ✅ Release Tag 关键词过滤
- ✅ Commit 关键词过滤

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
```

### 3. 配置 GitHub Secrets

在 GitHub 仓库 Settings → Secrets and variables → Actions 中添加：

| Secret | 说明 | 获取方式 |
|--------|------|----------|
| `CLOUDFLARE_API_TOKEN` | CF 部署 Token | https://dash.cloudflare.com/profile/api-tokens → Edit Cloudflare Workers 模板 |
| `CLOUDFLARE_ACCOUNT_ID` | CF 账户 ID | `npx wrangler whoami` 或 Dashboard 右侧栏 |
| `CRON_SECRET` | 定时触发鉴权 | 自定义随机字符串，需与 Worker KV 中的 `CRON_SECRET` 一致 |

### 4. 部署

推送到 `main` 分支会自动通过 GitHub Actions 部署：

```bash
git push origin main
```

也可手动部署：

```bash
npx wrangler deploy
```

### 5. 设置 CRON_SECRET

首次部署后，通过 Dashboard 或 API 设置 `CRON_SECRET`：

```bash
# 通过 API 设置（需先在 Dashboard 中设置访问密码）
curl -X POST https://<your-worker-url>/api/config \
  -H "Authorization: Bearer <session-token>" \
  -H "Content-Type: application/json" \
  -d '{"cronSecret": "your-random-secret"}'
```

GitHub Actions 的 `check.yml` 会使用同一个 secret 调用 `/api/cron/trigger`。

### 6. 配置自定义域名（可选）

```bash
npx wrangler custom-domain add <your-custom-domain>
```

### 7. 通过网页配置

访问 Worker URL，在 Dashboard 中完成所有配置：

1. **Telegram 设置**：填入 Bot Token 和 Chat ID
2. **添加仓库**：输入 `owner/repo` 格式或 GitHub URL
3. **测试连接**：点击「测试 Telegram」确认配置正确
4. **手动检查**：点击「立即检查」触发首次扫描

## API 端点

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| GET | `/` | Dashboard 网页 | 否 |
| GET | `/api/status` | 运行状态 | 是 |
| GET | `/api/config` | 获取配置（Token 掩码） | 是 |
| POST | `/api/config` | 保存配置 | 是 |
| GET | `/api/repos` | 仓库列表 | 是 |
| POST | `/api/repos` | 添加仓库 | 是 |
| PUT | `/api/repos/{owner/repo}` | 更新仓库设置 | 是 |
| DELETE | `/api/repos/{owner/repo}` | 删除仓库 | 是 |
| GET | `/api/history` | 通知历史 | 是 |
| DELETE | `/api/history` | 清空通知历史 | 是 |
| GET | `/api/status` | 运行状态 | 是 |
| POST | `/api/check` | 手动触发检查 | 是 |
| POST | `/api/test-telegram` | 测试 Telegram | 是 |
| GET | `/api/github/starred` | 获取 Star 列表 | 是 |
| GET | `/api/repos/activity` | 仓库最新动态 | 是 |
| GET | `/api/repos/compare` | 仓库对比数据 | 是 |
| GET | `/api/summary` | 周报摘要 | 是 |
| GET | `/api/quota` | GitHub API 配额 | 是 |
| POST | `/api/auth` | 登录验证 | 否 |
| POST | `/api/auth/password` | 设置/修改密码 | 否 |
| POST | `/api/cron/trigger` | 定时触发检查 | Bearer Token |
| GET | `/rss` | RSS 订阅源 | 否 |

## 通知样式

### Release（带 hashtag）
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

## 定时检查机制

- **触发方式**：GitHub Actions `check.yml`，每 30 分钟调用 `/api/cron/trigger`
- **防重复**：KV 存储每个仓库的最后检查 ID，只通知新增内容
- **防旧通知**：Release 检查有 24 小时发布时间过滤，超过 24 小时的旧 Release 不会通知
- **首次静默**：首次添加仓库时记录当前状态，不发送历史通知

## 项目结构

```
github-repo-watcher/
├── .github/workflows/
│   ├── check.yml          # 定时检查（每30分钟调用 /api/cron/trigger）
│   └── deploy.yml         # 自动部署（push to main）
├── src/
│   └── index.js           # Worker 主逻辑（后端 API + 前端 Dashboard HTML）
├── package.json
├── wrangler.toml          # Cloudflare Worker 配置
└── README.md
```

## License

MIT
