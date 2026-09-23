# GitHub Repo Watcher

基于 Cloudflare Workers 的 GitHub 仓库更新监控工具，自动检测新 Release 和新 Commit，通过 Telegram Bot 推送通知。自带网页 Dashboard，所有配置可视化完成。

## 架构

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────┐
│  Cloudflare     │────▶│  GitHub API  │     │  Telegram    │
│  Worker/Cron    │     └──────────────┘     │  Bot API     │
│  (每30分钟)     │────▶ Cloudflare KV ──────▶└─────────────┘
│                 │      (状态+配置)           (通知推送)
└─────────────────┘
        │
        ▼
   Web Dashboard  ◀── 浏览器访问 Worker URL
   (设置 / 仓库管理 / 历史)
```

## 功能

- ✅ 监控新 Release 发布
- ✅ 监控新 Commit 推送（自动合并多条 commit 通知）
- ✅ **网页 Dashboard**：在线管理 Telegram 配置、仓库列表、查看状态
- ✅ 使用 Cloudflare KV 持久化配置与状态
- ✅ 支持 GitHub Token 提升 API 速率限制
- ✅ 通知历史记录（支持清空）
- ✅ 手动触发检查 / Telegram 连接测试
- ✅ Dashboard 访问密码保护（timingSafeEqual 防时序攻击）
- ✅ 首次添加仓库自动静默初始化（不发通知）
- ✅ 通过 GitHub Actions 推送自动部署

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

### 3. 推送到 GitHub 并自动部署

```bash
# 初始化 Git 仓库
git init
git add -A
git commit -m "Initial commit"

# 推送到 GitHub
git remote add origin https://github.com/<你的用户名>/github-repo-watcher.git
git push -u origin main
```

然后配置 GitHub Actions 自动部署：

1. **获取 Cloudflare API Token**：
   - 访问 https://dash.cloudflare.com/profile/api-tokens
   - 创建 Token → 使用「Edit Cloudflare Workers」模板

2. **获取 Account ID**：
   - Cloudflare Dashboard 右侧栏可见，或 `npx wrangler whoami` 查看

3. **在 GitHub 仓库设置 Secrets**：
   - 进入仓库 → Settings → Secrets and variables → Actions
   - 添加 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`

4. **推送到 `main` 分支即自动部署**，也可在 Actions 页面手动触发。

> 也可以跳过 GitHub，直接 `npx wrangler deploy` 手动部署。

### 4. 通过网页配置

部署完成后，直接访问 Worker URL（如 `https://github-repo-watcher.<your-subdomain>.workers.dev`），在 Dashboard 中完成：

1. **Telegram 设置**：填入 Bot Token 和 Chat ID
2. **添加仓库**：输入 `owner/repo` 格式的仓库名
3. **测试连接**：点击「测试 Telegram」确认配置正确
4. **手动检查**：点击「立即检查」触发首次扫描

所有配置自动保存到 KV，无需命令行操作。

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 访问 Dashboard 网页 |
| GET | `/api/status` | 运行状态（含 cron 频率） |
| GET | `/api/config` | 获取配置（Token 掩码返回） |
| POST | `/api/config` | 保存配置 |
| GET | `/api/repos` | 仓库列表 |
| POST | `/api/repos` | 添加仓库 |
| DELETE | `/api/repos/{owner/repo}` | 删除仓库 |
| GET | `/api/history` | 通知历史 |
| DELETE | `/api/history` | 清空通知历史 |
| POST | `/api/auth` | 登录验证 |
| POST | `/api/auth/password` | 设置/修改访问密码 |
| POST | `/api/check` | 手动触发检查 |
| POST | `/api/test-telegram` | 测试 Telegram 连接 |

## 通知样式

### 新 Release
```
🏷️ New Release
vercel/next.js
v14.0.0
Tag: v14.0.0
Date: 2024/1/15
View on GitHub →
```

### 新 Commit
```
📝 3 New Commits
vercel/next.js
• abc1234 Fix build error
• def5678 Add new feature
• ghi9012 Update docs
View changes →
```

## 调整检查频率

编辑 `wrangler.toml` 中的 cron 表达式，并同步修改 `[vars]` 中的 `CRON_SCHEDULE`（用于 Dashboard 显示）：

```toml
[triggers]
crons = ["*/15 * * * *"]  # 每 15 分钟

[vars]
CRON_SCHEDULE = "*/15 * * * *"
```

注意：Cloudflare Workers 免费版限制为每天 1000 次 Cron 触发。

## License

MIT
