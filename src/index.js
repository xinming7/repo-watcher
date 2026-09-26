// GitHub Repo Watcher - Cloudflare Worker with Dashboard

export default {
  // Cron trigger handler
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAllRepos(env));
  },

  // HTTP handler
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Auth check for all API routes (except auth itself and public pages)
      const config = await getConfig(env);
      const isAuthRoute = path === "/api/auth" || path === "/api/auth/password";
      const isCronRoute = path === "/api/cron/trigger";
      const isAPIRoute = path.startsWith("/api/");
      if (isAPIRoute && !isAuthRoute && !isCronRoute) {
        // fail-closed：未设置访问密码时只开放密码初始化接口，其余一律拒绝
        if (!config.authPassword) {
          return jsonResponse({ error: "Access password not set. POST /api/auth/password to set the initial password first." }, corsHeaders, 401);
        }
        if (!await checkAuth(request, config, env)) {
          return jsonResponse({ error: "Unauthorized" }, corsHeaders, 401);
        }
      }

      // API Routes
      if (path === "/api/auth" && method === "POST") {
        const body = await request.json();
        const isPasswordAttempt = !body.token && !!body.password;
        const rl = await getRateLimitInfo(request, env);
        if (isPasswordAttempt && rl.blocked) {
          return jsonResponse({ error: "Too many failed attempts, try again later" }, corsHeaders, 429);
        }
        let ok = false;
        if (!config.authPassword) {
          // 未设置密码：提示前端进入初始化流程，而不是无条件放行
          return jsonResponse({ authenticated: false, setupRequired: true }, corsHeaders);
        }
        if (body.token) {
          const stored = await env.WATCHER_STATE.get("session:" + body.token);
          ok = stored === "valid";
        } else {
          try {
            ok = await constantTimeEquals(body.password || "", config.authPassword);
          } catch { ok = false; }
          if (!ok && body.password) await recordAuthFailure(request, env);
        }
        if (ok && config.authPassword) {
          await clearAuthFailures(request, env);
          const token = body.token || Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2,'0')).join('');
          if (!body.token) await env.WATCHER_STATE.put("session:" + token, "valid", { expirationTtl: 604800 });
          return jsonResponse({ authenticated: true, token }, corsHeaders);
        }
        return jsonResponse({ authenticated: ok }, corsHeaders, ok ? 200 : 401);
      }
      if (path === "/api/auth/password" && method === "POST") {
        const body = await request.json();
        // Require current password to change (unless setting for first time)
        if (config.authPassword) {
          if (!body.currentPassword) {
            return jsonResponse({ error: "Current password required" }, corsHeaders, 403);
          }
          const rl = await getRateLimitInfo(request, env);
          if (rl.blocked) {
            return jsonResponse({ error: "Too many failed attempts, try again later" }, corsHeaders, 429);
          }
          if (!await constantTimeEquals(body.currentPassword, config.authPassword)) {
            await recordAuthFailure(request, env);
            return jsonResponse({ error: "Current password incorrect" }, corsHeaders, 403);
          }
          await clearAuthFailures(request, env);
        }
        if (typeof body.password !== "string" || body.password.length < 8) {
          return jsonResponse({ error: "Password must be at least 8 characters" }, corsHeaders, 400);
        }
        config.authPassword = body.password;
        await env.WATCHER_STATE.put("config", JSON.stringify(config));
        return jsonResponse({ success: true }, corsHeaders);
      }
      if (path === "/api/auth/logout" && method === "POST") {
        const auth = request.headers.get("Authorization") || "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (token.length === 64 && /^[0-9a-f]+$/.test(token)) {
          await env.WATCHER_STATE.delete("session:" + token);
        }
        return jsonResponse({ success: true }, corsHeaders);
      }
      if (path === "/api/config" && method === "GET") {
        return jsonResponse(maskConfigTokens(config), corsHeaders);
      }
      if (path === "/api/config" && method === "POST") {
        const body = await request.json();
        return jsonResponse(await saveConfig(body, env, config), corsHeaders);
      }
      if (path === "/api/repos" && method === "GET") {
        return jsonResponse(await getRepos(env, config), corsHeaders);
      }
      if (path === "/api/repos" && method === "POST") {
        const body = await request.json();
        return jsonResponse(await addRepo(body.repo, body.watch, env, config), corsHeaders);
      }
      if (path.startsWith("/api/repos/") && method === "DELETE") {
        const repo = decodeURIComponent(path.replace("/api/repos/", ""));
        return jsonResponse(await removeRepo(repo, env, config), corsHeaders);
      }
      if (path.startsWith("/api/repos/") && method === "PUT") {
        const repo = decodeURIComponent(path.replace("/api/repos/", ""));
        const body = await request.json();
        return jsonResponse(await updateRepo(repo, body, env, config), corsHeaders);
      }
      if (path === "/api/history" && method === "GET") {
        const limit = parseInt(url.searchParams.get("limit") || "50");
        return jsonResponse(await getHistory(limit, env), corsHeaders);
      }
      if (path === "/api/history" && method === "DELETE") {
        await env.WATCHER_STATE.put("history", JSON.stringify([]));
        return jsonResponse({ success: true }, corsHeaders);
      }
      if (path === "/api/status" && method === "GET") {
        return jsonResponse(await getStatus(env, config), corsHeaders);
      }
      if (path === "/api/check" && method === "POST") {
        const result = await checkAllRepos(env);
        return jsonResponse(result, corsHeaders);
      }
      if (path === "/api/test-telegram" && method === "POST") {
        return jsonResponse(await testTelegram(env, config), corsHeaders);
      }
      if (path === "/api/github/starred" && method === "GET") {
        return jsonResponse(await getStarredRepos(config), corsHeaders);
      }
      if (path === "/api/stars/history" && method === "GET") {
        return jsonResponse(await getStarsHistory(config, env), corsHeaders);
      }
      if (path === "/api/repos/activity" && method === "GET") {
        return jsonResponse(await getReposActivity(config, env), corsHeaders);
      }
      if (path === "/api/summary" && method === "GET") {
        return jsonResponse(await getWeeklySummary(config, env), corsHeaders);
      }
      if (path === "/api/repos/compare" && method === "GET") {
        return jsonResponse(await getReposComparison(config, env), corsHeaders);
      }
      if (path === "/api/quota" && method === "GET") {
        try {
          const rateLimit = await githubAPI('/rate_limit', config);
          return jsonResponse(rateLimit, corsHeaders);
        } catch (e) {
          return jsonResponse({ error: e.message }, corsHeaders, 500);
        }
      }
      if (path === "/api/cron/trigger" && method === "POST") {
        const secret = env.CRON_SECRET;
        if (!secret) {
          return jsonResponse({ error: "CRON_SECRET not configured" }, corsHeaders, 503);
        }
        const authHeader = request.headers.get("Authorization") || "";
        const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        const provEnc = new TextEncoder().encode(provided);
        const secEnc = new TextEncoder().encode(String(secret));
        if (!provided || provEnc.length !== secEnc.length || !crypto.subtle.timingSafeEqual(provEnc, secEnc)) {
          return jsonResponse({ error: "Unauthorized" }, corsHeaders, 401);
        }
        const result = await checkAllRepos(env);
        return jsonResponse({ ok: true, ...result }, corsHeaders);
      }

      // RSS feed
      if (path === "/rss" || path === "/rss.xml") {
        // RSS exposes notification history: require the access password/session token when set
        if (config.authPassword && !await checkToken(url.searchParams.get("token"), config, env)) {
          return jsonResponse({ error: "Unauthorized" }, corsHeaders, 401);
        }
        const history = (await env.WATCHER_STATE.get("history", { type: "json" })) || [];
        const baseUrl = url.origin;
        return new Response(generateRSS(history, baseUrl), {
          headers: { "Content-Type": "application/rss+xml; charset=utf-8", ...corsHeaders },
        });
      }

      // Serve frontend
      return new Response(getHTML(), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          // 内联脚本/样式是单文件仪表盘的既有形态，靠转义 + 本 CSP 收敛注入面
          "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
        },
      });
    } catch (err) {
      // 细节只进日志，不回给客户端（避免泄漏内部实现）
      console.error("Request failed:", err);
      return jsonResponse({ error: "Internal error" }, corsHeaders, 500);
    }
  },
};

// ── Config API ──

async function getConfig(env) {
  const config = await env.WATCHER_STATE.get("config", { type: "json" });
  if (!config) return { telegramBotToken: "", telegramChatId: "", watchRepos: [], authPassword: "", filters: {}, keywordAlerts: [], notifySlack: "", starMilestones: [100, 500, 1000], weeklySummary: false };
  // Migrate old string format to object format
  if (config.watchRepos && config.watchRepos.length > 0 && typeof config.watchRepos[0] === "string") {
    config.watchRepos = config.watchRepos.map(r => ({
      repo: r,
      watch: normalizeWatch(),
    }));
    await env.WATCHER_STATE.put("config", JSON.stringify(config));
  }
  return config;
}

// A masked value round-trip ("••••") means "keep existing"; empty clears; anything else replaces.
function resolveSecret(incoming, existing) {
  if (incoming === undefined) return existing;
  if (typeof incoming === "string" && incoming.includes("••••") && existing) return existing;
  return incoming;
}

// Re-validate/normalize watchRepos on every write path (not just addRepo).
function sanitizeWatchRepos(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const raw = typeof item === "string" ? item : item && item.repo;
    const parsed = parseRepoInput(String(raw || ""));
    if (!parsed || seen.has(parsed)) continue;
    seen.add(parsed);
    if (typeof item === "string") {
      out.push({ repo: parsed, watch: normalizeWatch() });
    } else {
      out.push({ ...item, repo: parsed, watch: normalizeWatch(item.watch) });
    }
  }
  return out;
}

// 通知渠道 URL 必须是 https（空值表示清空；掩码值表示保持不变）
function validateChannelUrl(value) {
  if (value === undefined || value === null) return { ok: true, value };
  if (typeof value !== "string") return { ok: false, error: "channel url must be a string" };
  const v = value.trim();
  if (v === "" || v.includes("••••")) return { ok: true, value };
  if (!v.startsWith("https://")) return { ok: false, error: "channel url must be https://" };
  try { new URL(v); } catch { return { ok: false, error: "invalid channel url" }; }
  return { ok: true, value: v };
}

async function saveConfig(body, env, existingConfig) {
  const existing = existingConfig || await getConfig(env);
  for (const field of ["notifyDiscord", "notifySlack", "notifyWebhook"]) {
    const check = validateChannelUrl(body[field]);
    if (!check.ok) return { success: false, error: field + ": " + check.error };
  }
  const config = {
    telegramBotToken: resolveSecret(body.telegramBotToken, existing.telegramBotToken),
    telegramChatId: body.telegramChatId !== undefined ? body.telegramChatId : existing.telegramChatId,
    githubToken: resolveSecret(body.githubToken, existing.githubToken),
    watchRepos: body.watchRepos !== undefined ? sanitizeWatchRepos(body.watchRepos) : existing.watchRepos,
    authPassword: body.authPassword !== undefined ? body.authPassword : existing.authPassword,
    // Notification channels
    notifyDiscord: resolveSecret(body.notifyDiscord, existing.notifyDiscord),
    notifyWebhook: resolveSecret(body.notifyWebhook, existing.notifyWebhook),
    // Filters
    filters: body.filters !== undefined ? body.filters : (existing.filters || {}),
    // Keyword alerts
    keywordAlerts: body.keywordAlerts !== undefined ? body.keywordAlerts : (existing.keywordAlerts || []),
    notifySlack: resolveSecret(body.notifySlack, existing.notifySlack || ""),
    // Star milestones
    starMilestones: body.starMilestones !== undefined ? body.starMilestones : (existing.starMilestones || [100, 500, 1000]),
    // Weekly summary
    weeklySummary: body.weeklySummary !== undefined ? body.weeklySummary : (existing.weeklySummary || false),
    updatedAt: new Date().toISOString(),
  };
  await env.WATCHER_STATE.put("config", JSON.stringify(config));
  // Return config with masked tokens
  return { success: true, config: maskConfigTokens(config) };
}

// ── Repos API ──

async function getRepos(env, existingConfig) {
  const config = existingConfig || await getConfig(env);
  const repos = (config.watchRepos || []).map(r => {
    if (typeof r === "string") return { repo: r, watch: normalizeWatch(), pinned: false };
    return { ...r, pinned: !!r.pinned };
  });
  return { repos };
}

function normalizeWatch(w) {
  if (!w) return { releases: true, commits: true, actions: false, issues: false, prs: false, forks: false, prReviews: false, ignorePreRelease: false };
  return {
    releases: w.releases !== undefined ? w.releases : true,
    commits: w.commits !== undefined ? w.commits : true,
    actions: w.actions !== undefined ? w.actions : false,
    issues: w.issues !== undefined ? w.issues : false,
    prs: w.prs !== undefined ? w.prs : false,
    forks: w.forks !== undefined ? w.forks : false,
    prReviews: w.prReviews !== undefined ? w.prReviews : false,
    ignorePreRelease: w.ignorePreRelease !== undefined ? w.ignorePreRelease : false,
  };
}

function parseRepoInput(input) {
  const trimmed = input.trim();
  // Support full URLs: https://github.com/owner/repo or github.com/owner/repo
  const urlMatch = trimmed.match(/github\.com\/[\w.-]+\/[\w.-]+/);
  if (urlMatch) {
    const parts = urlMatch[0].split("/");
    return parts[1] + "/" + parts[2];
  }
  // Support owner/repo format
  if (trimmed.match(/^[\w.-]+\/[\w.-]+$/)) {
    return trimmed;
  }
  return null;
}

async function addRepo(repo, watch, env, existingConfig) {
  const parsed = parseRepoInput(repo);
  if (!parsed) {
    throw new Error("Invalid repo format. Use owner/repo or a GitHub URL");
  }
  repo = parsed;
  const config = existingConfig || await getConfig(env);
  if (!config.watchRepos) config.watchRepos = [];
  const exists = config.watchRepos.find(r => (typeof r === "string" ? r : r.repo) === repo);
  if (exists) {
    return { success: true, added: false, repos: config.watchRepos.map(r => typeof r === "string" ? { repo: r, watch: normalizeWatch() } : r) };
  }
  config.watchRepos.push({
    repo,
    watch: normalizeWatch(watch),
  });
  await env.WATCHER_STATE.put("config", JSON.stringify(config));
  return { success: true, added: true, repos: config.watchRepos.map(r => typeof r === "string" ? { repo: r, watch: normalizeWatch() } : r) };
}

async function removeRepo(repo, env, existingConfig) {
  const config = existingConfig || await getConfig(env);
  const before = (config.watchRepos || []).length;
  if (config.watchRepos) {
    config.watchRepos = config.watchRepos.filter((r) => (typeof r === "string" ? r : r.repo) !== repo);
  }
  const removed = (config.watchRepos || []).length < before;
  if (removed) {
    await env.WATCHER_STATE.put("config", JSON.stringify(config));
  }
  return { success: true, removed, repos: config.watchRepos };
}

async function updateRepo(repo, body, env, existingConfig) {
  const config = existingConfig || await getConfig(env);
  if (config.watchRepos) {
    const idx = config.watchRepos.findIndex((r) => (typeof r === "string" ? r : r.repo) === repo);
    if (idx !== -1) {
      const entry = config.watchRepos[idx];
      const current = typeof entry === "string" ? { repo: entry, watch: normalizeWatch() } : entry;
      if (body.watch) current.watch = { ...current.watch, ...body.watch };
      if (body.pinned !== undefined) current.pinned = !!body.pinned;
      config.watchRepos[idx] = current;
      await env.WATCHER_STATE.put("config", JSON.stringify(config));
    }
  }
  return { success: true };
}

// ── History API ──

async function getHistory(limit, env) {
  const history = await env.WATCHER_STATE.get("history", { type: "json" });
  return { history: (history || []).slice(0, limit) };
}

async function addHistoryEntry(entry, env) {
  const history = (await env.WATCHER_STATE.get("history", { type: "json" })) || [];
  history.unshift({
    ...entry,
    timestamp: new Date().toISOString(),
    priority: entry.priority || 'normal',
  });
  // Keep only last 200 entries
  await env.WATCHER_STATE.put("history", JSON.stringify(history.slice(0, 200)));
}

// ── Status API ──

async function getStatus(env, existingConfig) {
  const config = existingConfig || await getConfig(env);
  const history = (await env.WATCHER_STATE.get("history", { type: "json" })) || [];
  const lastCheck = history.length > 0 ? history[0].timestamp : null;

  // Fetch GitHub API rate limit (cached 5 min to avoid wasting API quota)
  let apiQuota = null;
  try {
    const cached = await env.WATCHER_STATE.get("rate_limit_cache", { type: "json" });
    if (cached && cached.ts && (Date.now() - cached.ts < 300000)) {
      apiQuota = cached.data;
    } else {
      const rateLimit = await githubAPI('/rate_limit', config);
      if (rateLimit && rateLimit.rate) {
        apiQuota = {
          limit: rateLimit.rate.limit,
          remaining: rateLimit.rate.remaining,
          reset: new Date(rateLimit.rate.reset * 1000).toISOString(),
        };
      }
      env.WATCHER_STATE.put("rate_limit_cache", JSON.stringify({ data: apiQuota, ts: Date.now() }), { expirationTtl: 600 }).catch(() => {});
    }
  } catch (e) { /* ignore */ }

  const channels = [];
  if (config.telegramBotToken && config.telegramChatId) channels.push('Telegram');
  if (config.notifyDiscord) channels.push('Discord');
  if (config.notifySlack) channels.push('Slack');
  if (config.notifyWebhook) channels.push('Webhook');

  return {
    reposCount: (config.watchRepos || []).length,
    notificationsSent: history.length,
    lastCheck,
    telegramConfigured: !!(config.telegramBotToken && config.telegramChatId),
    channels,
    cronSchedule: env.CRON_SCHEDULE || "*/30 * * * *",
    apiQuota,
  };
}

// ── Auth helpers ──

function maskConfigTokens(config) {
  const mask = (s) => {
    if (!s || s.length <= 8) return s ? "••••••••" : "";
    return s.slice(0, 4) + "••••" + s.slice(-4);
  };
  return {
    telegramBotToken: mask(config.telegramBotToken),
    telegramChatId: config.telegramChatId,
    githubToken: mask(config.githubToken),
    watchRepos: config.watchRepos,
    notifyDiscord: mask(config.notifyDiscord) || "",
    notifyWebhook: mask(config.notifyWebhook) || "", 
    filters: config.filters || {},
    keywordAlerts: config.keywordAlerts || [],
    notifySlack: mask(config.notifySlack) || "",
    starMilestones: config.starMilestones || [100, 500, 1000],
    weeklySummary: config.weeklySummary || false,
    updatedAt: config.updatedAt,
  };
}

function getClientKey(request) {
  return request.headers.get("CF-Connecting-IP") || "global";
}

async function getRateLimitInfo(request, env) {
  const key = "rl:fail:" + getClientKey(request);
  const count = parseInt(await env.WATCHER_STATE.get(key) || "0", 10);
  return { key, count, blocked: count >= 5 };
}

async function recordAuthFailure(request, env) {
  const { key, count } = await getRateLimitInfo(request, env);
  await env.WATCHER_STATE.put(key, String(count + 1), { expirationTtl: 900 });
}

async function clearAuthFailures(request, env) {
  await env.WATCHER_STATE.delete("rl:fail:" + getClientKey(request));
}

async function checkToken(token, config, env) {
  if (!token) return false;
  // Try session token first (64-char hex)
  if (token.length === 64 && /^[0-9a-f]+$/.test(token)) {
    const stored = await env.WATCHER_STATE.get("session:" + token);
    if (stored === "valid") return true;
  }
  // Fallback: compare as password
  try {
    return await constantTimeEquals(token, config.authPassword);
  } catch {
    return false;
  }
}

async function checkAuth(request, config, env) {
  if (!config.authPassword) return true;
  const auth = request.headers.get("Authorization");
  if (!auth) return false;
  const parts = auth.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return false;
  const token = parts[1];
  // Valid session tokens are always allowed; rate limiting only guards password guessing
  if (token.length === 64 && /^[0-9a-f]+$/.test(token)) {
    const stored = await env.WATCHER_STATE.get("session:" + token);
    if (stored === "valid") return true;
  }
  const rl = await getRateLimitInfo(request, env);
  if (rl.blocked) return false;
  const ok = await checkToken(token, config, env);
  // Count brute-force attempts that use the password as a bearer token
  if (!ok && !/^[0-9a-f]{64}$/.test(token)) await recordAuthFailure(request, env);
  return ok;
}

// ── Test Telegram ──

async function testTelegram(env, existingConfig) {
  const config = existingConfig || await getConfig(env);
  if (!config.telegramBotToken || !config.telegramChatId) {
    throw new Error("Telegram not configured");
  }

  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text: "✅ GitHub Repo Watcher 连接测试成功！",
      parse_mode: "HTML",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Telegram API error: ${err}`);
  }

  return { success: true, message: "Test message sent" };
}

async function getReposActivity(config, env) {
  // Check KV cache (5 min TTL)
  const cached = await env.WATCHER_STATE.get("activity_cache", { type: "json" });
  if (cached && cached.data && cached.ts && (Date.now() - cached.ts < 300000)) {
    return cached.data;
  }
  const repos = config.watchRepos || [];
  if (repos.length === 0) return { activity: [] };
  const results = await Promise.allSettled(
    repos.map(async (entry) => {
      const repoName = typeof entry === "string" ? entry : entry.repo;
      const watch = typeof entry === "string" ? { releases: true, commits: true } : (entry.watch || {});
      const result = { repo: repoName };
      try {
        if (watch.releases) {
          const rel = await githubAPI(`/repos/${repoName}/releases?per_page=1`, config);
          if (rel && Array.isArray(rel) && rel.length > 0) {
            const r = rel[0];
            result.latestRelease = {
              tag: r.tag_name,
              name: r.name || r.tag_name,
              date: r.published_at,
              url: r.html_url,
              prerelease: r.prerelease,
            };
          }
        }
      } catch (e) { /* ignore */ }
      try {
        if (watch.commits) {
          const commits = await githubAPI(`/repos/${repoName}/commits?per_page=1`, config);
          if (commits && Array.isArray(commits) && commits.length > 0) {
            const c = commits[0];
            result.latestCommit = {
              message: c.commit.message.split("\n")[0],
              sha: c.sha.slice(0, 7),
              date: c.commit.author?.date,
              url: c.html_url,
              author: c.commit.author?.name || "unknown",
            };
          }
        }
      } catch (e) { /* ignore */ }
      return result;
    })
  );
  const result = { activity: results.filter(r => r.status === "fulfilled").map(r => r.value) };
  // Write cache (fire-and-forget)
  env.WATCHER_STATE.put("activity_cache", JSON.stringify({ data: result, ts: Date.now() }), { expirationTtl: 600 }).catch(() => {});
  return result;
}



async function getStarsHistory(config, env) {
  const repos = config.watchRepos || [];
  if (repos.length === 0) return { stars: [] };
  // Reuse compare_cache to avoid duplicate /repos/{repo} API calls
  let repoDataMap = {};
  const cached = await env.WATCHER_STATE.get("compare_cache", { type: "json" });
  if (cached && cached.data && cached.ts && (Date.now() - cached.ts < 300000)) {
    (cached.data.repos || []).forEach(r => { repoDataMap[r.repo] = r; });
  }
  const results = [];
  // Parallel fetch star counts for repos not in cache
  const uncached = repos.slice(0, 20).filter(entry => {
    const name = typeof entry === "string" ? entry : entry.repo;
    return !repoDataMap[name];
  });
  const starFetches = await Promise.allSettled(
    uncached.map(async (entry) => {
      const name = typeof entry === "string" ? entry : entry.repo;
      const data = await githubAPI(`/repos/${name}`, config);
      return { name, stars: data.stargazers_count };
    })
  );
  starFetches.forEach(r => {
    if (r.status === "fulfilled") repoDataMap[r.value.name] = { stars: r.value.stars };
  });
  // Sequential KV reads/writes (KV doesn't support batch)
  for (const entry of repos.slice(0, 20)) {
    const repoName = typeof entry === "string" ? entry : entry.repo;
    try {
      const stars = repoDataMap[repoName]?.stars ?? 0;
      const kvKey = `stars:${repoName}`;
      const history = (await env.WATCHER_STATE.get(kvKey, { type: "json" })) || [];
      const current = { stars, date: new Date().toISOString().slice(0, 10) };
      if (history.length === 0 || history[history.length - 1].date !== current.date) {
        history.push(current);
        await env.WATCHER_STATE.put(kvKey, JSON.stringify(history.slice(-90)));
      }
      results.push({ repo: repoName, stars, history: history.slice(-30) });
    } catch (e) { /* ignore */ }
  }
  return { stars: results };
}

async function getStarredRepos(config) {
  if (!config.githubToken) {
    throw new Error("GitHub Token 未配置，请在「通知渠道」中设置。");
  }
  const data = await githubAPI("/user/starred?per_page=100&sort=updated", config);
  if (!data || !Array.isArray(data)) return { starred: [] };
  const existingRepos = (config.watchRepos || []).map(r => typeof r === "string" ? r : r.repo);
  const starred = data.map(r => ({
    repo: r.full_name,
    description: r.description || "",
    stars: r.stargazers_count,
    language: r.language || "",
    alreadyWatching: existingRepos.includes(r.full_name),
  }));
  return { starred };
}

// ── Main check logic ──

// 检查互斥锁：防止 cron / 手动触发 / Actions 重叠执行导致重复通知
// （KV 为最终一致存储，这里是 best-effort；严格互斥可换 Durable Object）
const CHECK_LOCK_TTL_SEC = 600;
async function acquireCheckLock(env) {
  const key = "lock:check";
  const now = Date.now();
  const cur = await env.WATCHER_STATE.get(key);
  if (cur && now - Number(cur) < 300000) return false;
  await env.WATCHER_STATE.put(key, String(now), { expirationTtl: CHECK_LOCK_TTL_SEC });
  return true;
}

async function releaseCheckLock(env) {
  await env.WATCHER_STATE.delete("lock:check");
}

async function checkAllRepos(env) {
  if (!await acquireCheckLock(env)) {
    return { checked: 0, notifications: 0, message: "Another check is already running" };
  }
  try {
    return await doCheckAllRepos(env);
  } finally {
    await releaseCheckLock(env);
  }
}

async function doCheckAllRepos(env) {
  const config = await getConfig(env);
  const repos = config.watchRepos || [];

  if (repos.length === 0) {
    return { checked: 0, notifications: 0, message: "No repos configured" };
  }

  let notifications = 0;

  for (const entry of repos) {
    const repoName = typeof entry === "string" ? entry : entry.repo;
    const watch = typeof entry === "string" ? normalizeWatch() : normalizeWatch(entry.watch);
    try {
      const count = await checkRepo(repoName, watch, config, env);
      notifications += count;
    } catch (err) {
      console.error(`Error checking ${repoName}:`, err.message);
      await addHistoryEntry({ type: "error", repo: repoName, message: err.message }, env);
    }
  }

  // Weekly summary push: check if today is Monday (UTC+8) and weeklySummary is enabled
  if (config.weeklySummary) {
    const now = new Date();
    const bjTime = new Date(now.getTime() + 8 * 3600 * 1000); // UTC+8
    if (bjTime.getUTCDay() === 1) { // Monday in Beijing time
      const lastSummaryKey = 'weekly_summary:last';
      const lastSent = await env.WATCHER_STATE.get(lastSummaryKey);
      const thisMonday = bjTime.toISOString().slice(0, 10);
      if (lastSent !== thisMonday) {
        await env.WATCHER_STATE.put(lastSummaryKey, thisMonday, { expirationTtl: 604800 });
        const summary = await getWeeklySummary(config, env);
        const repos = Object.keys(summary.summary);
        if (repos.length > 0) {
          let lines = repos.map(r => {
            const s = summary.summary[r];
            const parts = [];
            if (s.releases) parts.push(`${s.releases}个Release`);
            if (s.commits) parts.push(`${s.commits}个Commit`);
            if (s.issues) parts.push(`${s.issues}个Issue`);
            if (s.prs) parts.push(`${s.prs}个PR`);
            if (s.prMerges) parts.push(`${s.prMerges}个合并`);
            if (s.forks) parts.push(`${s.forks}个Fork`);
            if (s.starMilestones) parts.push(`Star里程碑`);
            return `• <b>${escapeHTML(r)}</b>: ${parts.join(', ')}`;
          }).join('\n');
          const message =
            `📋 <b>Weekly Summary</b>\n` +
            `本周共 ${summary.totalEvents} 条事件\n` +
            lines + '\n' +
            `#GitHub仓库更新 #周报\n` +
      `<a href="${env.DASHBOARD_URL || 'https://github.com/xinming7/repo-watcher'}">View Dashboard →</a>`;
          await sendNotification(message, config);
          await addHistoryEntry({ type: "weekly_summary", eventCount: summary.totalEvents, repoCount: repos.length }, env);
          notifications++;
        }
      }
    }
  }
  return { checked: repos.length, notifications };
}

async function checkRepo(repo, watch, config, env) {
  let sent = 0;
  const filters = config.filters || {};
  if (watch.releases) sent += await checkReleases(repo, config, env, filters, watch);
  // Fetch commits once, share between checkCommits and checkKeywordAlerts
  let commitsData = null;
  if (watch.commits || (config.keywordAlerts || []).length > 0) {
    try { commitsData = await githubAPI(`/repos/${repo}/commits?per_page=10`, config); } catch {}
  }
  if (watch.commits) sent += await checkCommits(repo, config, env, filters, commitsData);
  if (watch.actions) sent += await checkActions(repo, config, env, filters);
  if (watch.issues) sent += await checkIssues(repo, config, env, filters);
  if (watch.prs) sent += await checkPRs(repo, config, env, filters);
  if (watch.forks || (config.starMilestones || []).length > 0) {
    sent += await checkRepoMeta(repo, watch, config, env);
  }
  if (watch.prReviews) sent += await checkPRMerges(repo, config, env);
  if ((config.keywordAlerts || []).length > 0) {
    sent += await checkKeywordAlerts(repo, config, env, commitsData);
  }
  return sent;
}

async function checkReleases(repo, config, env, filters, watch) {
  const data = await githubAPI(`/repos/${repo}/releases?per_page=5`, config);
  if (!data || !Array.isArray(data) || data.length === 0) return 0;

  const kvKey = `release:${repo}`;
  const lastId = await env.WATCHER_STATE.get(kvKey);

  // First run: always record state silently, never notify
  if (!lastId) {
    await env.WATCHER_STATE.put(kvKey, String(data[0].id));
    return 0;
  }

  const lastIdNum = parseInt(lastId, 10);
  const newReleases = data.filter((r) => r.id > lastIdNum);
  if (newReleases.length === 0) return 0;

  // Always update state to the newest release ID to prevent re-notifying
  await env.WATCHER_STATE.put(kvKey, String(data[0].id));

  // Only notify for releases published within the last 24 hours
  // to avoid flooding with old releases when state is stale
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;

  let notified = 0;
  for (const release of newReleases.reverse()) {
    // Skip releases older than 24 hours (state was stale, not truly new)
    if (new Date(release.published_at).getTime() < cutoff) continue;

    const tag = release.tag_name || "unknown";
    const name = release.name || tag;
    const url = release.html_url;
    const isPre = release.prerelease ? " (Pre-release)" : "";
    const date = new Date(release.published_at).toLocaleDateString("zh-CN");

    // Filter: skip pre-release if configured (global filter OR per-repo setting)
    if ((filters.ignorePreRelease || (watch && watch.ignorePreRelease)) && release.prerelease) continue;
    // Filter: tag keyword
    if (filters.tagKeyword && !tag.toLowerCase().includes(filters.tagKeyword.toLowerCase())) continue;

    const message =
      `🏷️ <b>New Release</b>\n` +
      `<b>${escapeHTML(repo)}</b>\n` +
      `<b>${escapeHTML(name)}</b>${escapeHTML(isPre)}\n` +
      `Tag: <code>${escapeHTML(tag)}</code>\n` +
      `Date: ${date}\n` +
      `#GitHub仓库更新 #Release\n` +
      `<a href="${url}">View on GitHub →</a>`;

    await sendNotification(message, config);
    await addHistoryEntry({ type: "release", repo, tag, name, url }, env);
    await reportToUpdateHub(env, {
      version: tag,
      title: `${repo} Release: ${name}`,
      body: release.body ? release.body.slice(0, 500) : '',
      status: 'changed',
      diff_url: url,
      extra: { prerelease: release.prerelease },
    });
    notified++;
  }

  return notified;
}

async function checkCommits(repo, config, env, filters, preFetchedData) {
  const data = preFetchedData || await githubAPI(`/repos/${repo}/commits?per_page=10`, config);
  if (!data || !Array.isArray(data) || data.length === 0) return 0;

  const kvKey = `commit:${repo}`;
  const lastSha = await env.WATCHER_STATE.get(kvKey);

  // First run: always record state silently, never notify
  if (!lastSha) {
    await env.WATCHER_STATE.put(kvKey, data[0].sha);
    return 0;
  }

  let newCommits;
  const idx = data.findIndex((c) => c.sha === lastSha);
  newCommits = idx === -1 ? data.slice(0, 3) : data.slice(0, idx);
  if (newCommits.length > 0) {
    await env.WATCHER_STATE.put(kvKey, data[0].sha);
  }

  if (newCommits.length === 0) return 0;

  let notified = 0;
  if (newCommits.length === 1) {
    const c = newCommits[0];
    const msg = c.commit.message.split("\n")[0];
    const author = c.commit.author?.name || "unknown";
    const date = new Date(c.commit.author?.date).toLocaleString("zh-CN");
    const shortSha = c.sha.slice(0, 7);

    // Filter: ignore authors
    if (filters.ignoreAuthors && filters.ignoreAuthors.some(a => author.toLowerCase().includes(a.toLowerCase()))) { return 0; }
    // Filter: commit keyword
    if (filters.commitKeyword && !msg.toLowerCase().includes(filters.commitKeyword.toLowerCase())) { return 0; }

    const message =
      `📝 <b>New Commit</b>\n` +
      `<b>${escapeHTML(repo)}</b>\n` +
      `<code>${shortSha}</code> ${escapeHTML(msg)}\n` +
      `By ${escapeHTML(author)} · ${date}\n` +
      `#GitHub仓库更新 #Commit\n` +
      `<a href="${c.html_url}">View on GitHub →</a>`;

    await sendNotification(message, config);
    await addHistoryEntry({ type: "commit", repo, sha: shortSha, message: msg, author }, env);
    await reportToUpdateHub(env, {
      title: `${repo} Commit: ${shortSha}`,
      body: msg,
      status: 'changed',
      diff_url: c.html_url,
      extra: { author, sha: shortSha },
    });
    notified = 1;
  } else {
    // Filter: apply ignoreAuthors and commitKeyword to each commit
    const filtered = newCommits.filter(c => {
      const msg = c.commit.message.split("\n")[0];
      const author = c.commit.author?.name || "unknown";
      if (filters.ignoreAuthors && filters.ignoreAuthors.some(a => author.toLowerCase().includes(a.toLowerCase()))) return false;
      if (filters.commitKeyword && !msg.toLowerCase().includes(filters.commitKeyword.toLowerCase())) return false;
      return true;
    });
    if (filtered.length === 0) return 0;

    const reversed = [...filtered].reverse();
    const lines = reversed
      .map((c) => {
        const msg = c.commit.message.split("\n")[0];
        const sha = c.sha.slice(0, 7);
        return `• <code>${sha}</code> ${escapeHTML(truncate(msg, 60))}`;
      })
      .join("\n");

    const compareUrl = `https://github.com/${repo}/compare/${filtered[filtered.length - 1].sha.slice(0, 7)}...${filtered[0].sha.slice(0, 7)}`;

    const message =
      `📝 <b>${filtered.length} New Commits</b>\n` +
      `<b>${escapeHTML(repo)}</b>\n${lines}\n` +
      `#GitHub仓库更新 #Commits\n` +
      `<a href="${compareUrl}">View changes →</a>`;

    await sendNotification(message, config);
    await addHistoryEntry({ type: "commits", repo, count: filtered.length }, env);
    await reportToUpdateHub(env, {
      title: `${repo} ${filtered.length} new commit(s)`,
      body: filtered.map(c => c.commit.message.split('\n')[0]).join('\n').slice(0, 500),
      status: 'changed',
      diff_url: compareUrl,
      extra: { count: filtered.length },
    });
    notified = 1;
  }

  return notified;
}

async function checkActions(repo, config, env, filters) {
  const data = await githubAPI(`/repos/${repo}/actions/runs?per_page=5&status=completed`, config);
  if (!data || !data.workflow_runs || data.workflow_runs.length === 0) return 0;

  const kvKey = `action:${repo}`;
  const lastId = await env.WATCHER_STATE.get(kvKey);

  if (!lastId) {
    await env.WATCHER_STATE.put(kvKey, String(data.workflow_runs[0].id));
    return 0;
  }

  const lastIdNum = parseInt(lastId, 10);
  const newRuns = data.workflow_runs.filter((r) => r.id > lastIdNum);
  if (newRuns.length === 0) return 0;

  await env.WATCHER_STATE.put(kvKey, String(data.workflow_runs[0].id));

  let notified = 0;
  for (const run of newRuns.reverse()) {
    // Filter: only failures
    if (filters.actionsOnlyFailures && run.conclusion === 'success') continue;

    const name = run.name || "workflow";
    const status = run.conclusion === "success" ? "✅" : run.conclusion === "failure" ? "❌" : "⚠️";
    const branch = run.head_branch || "";
    const date = new Date(run.updated_at).toLocaleString("zh-CN");

    const message =
      `${status} <b>Actions: ${escapeHTML(name)}</b>\n` +
      `<b>${escapeHTML(repo)}</b>\n` +
      `Branch: <code>${escapeHTML(branch)}</code>\n` +
      `Result: ${escapeHTML(run.conclusion || "completed")}\n` +
      `Date: ${date}\n` +
      `#GitHub仓库更新 #Actions\n` +
      `<a href="${run.html_url}">View on GitHub →</a>`;

    await sendNotification(message, config);
    await addHistoryEntry({ type: "action", repo, name, conclusion: run.conclusion, url: run.html_url }, env);
    await reportToUpdateHub(env, {
      title: `${repo} Actions: ${name}`,
      body: `Result: ${run.conclusion || 'completed'}`,
      status: run.conclusion === 'success' ? 'ok' : 'error',
      diff_url: run.html_url,
      extra: { conclusion: run.conclusion, branch: run.head_branch },
    });
    notified++;
  }

  return notified;
}



async function checkIssues(repo, config, env, filters) {
  const data = await githubAPI(`/repos/${repo}/issues?state=open&sort=created&direction=desc&per_page=5`, config);
  if (!data || !Array.isArray(data) || data.length === 0) return 0;

  const kvKey = `issue:${repo}`;
  const lastId = await env.WATCHER_STATE.get(kvKey);

  if (!lastId) {
    await env.WATCHER_STATE.put(kvKey, String(data[0].id));
    return 0;
  }

  const lastIdNum = parseInt(lastId, 10);
  const newIssues = data.filter((i) => i.id > lastIdNum && !i.pull_request);
  if (newIssues.length === 0) return 0;

  await env.WATCHER_STATE.put(kvKey, String(data[0].id));

  let notified = 0;
  for (const issue of newIssues.reverse()) {
    const title = issue.title || "untitled";
    const labels = (issue.labels || []).map(l => l.name);
    // Filter: ignore labels
    if (filters.ignoreLabels && filters.ignoreLabels.some(l => labels.includes(l))) continue;

    const message =
      `🆕 <b>New Issue</b>\n` +
      `<b>${escapeHTML(repo)}</b>\n` +
      `#${issue.number} ${escapeHTML(title)}\n` +
      `By ${escapeHTML(issue.user?.login || "unknown")}\n` +
      `#GitHub仓库更新 #Issue\n` +
      `<a href="${issue.html_url}">View on GitHub →</a>`;

    await sendNotification(message, config);
    await addHistoryEntry({ type: "issue", repo, number: issue.number, title, url: issue.html_url }, env);
    notified++;
  }

  return notified;
}

async function checkPRs(repo, config, env, filters) {
  const data = await githubAPI(`/repos/${repo}/pulls?state=open&sort=created&direction=desc&per_page=5`, config);
  if (!data || !Array.isArray(data) || data.length === 0) return 0;

  const kvKey = `pr:${repo}`;
  const lastId = await env.WATCHER_STATE.get(kvKey);

  if (!lastId) {
    await env.WATCHER_STATE.put(kvKey, String(data[0].id));
    return 0;
  }

  const lastIdNum = parseInt(lastId, 10);
  const newPRs = data.filter((p) => p.id > lastIdNum);
  if (newPRs.length === 0) return 0;

  await env.WATCHER_STATE.put(kvKey, String(data[0].id));

  for (const pr of newPRs.reverse()) {
    const title = pr.title || "untitled";
    const message =
      `🔀 <b>New Pull Request</b>\n` +
      `<b>${escapeHTML(repo)}</b>\n` +
      `#${pr.number} ${escapeHTML(title)}\n` +
      `By ${escapeHTML(pr.user?.login || "unknown")}\n` +
      `#GitHub仓库更新 #PR\n` +
      `<a href="${pr.html_url}">View on GitHub →</a>`;

    await sendNotification(message, config);
    await addHistoryEntry({ type: "pr", repo, number: pr.number, title, url: pr.html_url }, env);
  }

  return newPRs.length;
}

async function checkKeywordAlerts(repo, config, env, commitsData) {
  const alerts = config.keywordAlerts || [];
  if (alerts.length === 0) return 0;

  const repoAlerts = alerts.filter(a => a.repo === repo || a.repo === '*');
  if (repoAlerts.length === 0) return 0;

  // Use shared commits data if available, otherwise fetch
  const commits = commitsData || await githubAPI(`/repos/${repo}/commits?per_page=5`, config);
  if (!commits || !Array.isArray(commits)) return 0;

  const kvKey = `kw:${repo}`;
  const lastSha = await env.WATCHER_STATE.get(kvKey);
  if (!lastSha) {
    if (commits.length > 0) await env.WATCHER_STATE.put(kvKey, commits[0].sha);
    return 0;
  }

  const idx = commits.findIndex(c => c.sha === lastSha);
  const newCommits = idx === -1 ? commits.slice(0, 3) : commits.slice(0, idx);
  if (newCommits.length > 0) {
    await env.WATCHER_STATE.put(kvKey, commits[0].sha);
  }

  let sent = 0;
  for (const c of newCommits) {
    const msg = c.commit.message.toLowerCase();
    for (const alert of repoAlerts) {
      const keyword = (alert.keyword || '').toLowerCase();
      if (!keyword) continue;
      if (msg.includes(keyword)) {
        const shortSha = c.sha.slice(0, 7);
        const message =
          `🔔 <b>Keyword Alert</b>\n` +
          `<b>${escapeHTML(repo)}</b>\n` +
          `Keyword: <code>${escapeHTML(alert.keyword)}</code>\n` +
          `<code>${shortSha}</code> ${escapeHTML(c.commit.message.split("\n")[0])}\n` +
          `#GitHub仓库更新 #关键词告警\n` +
          `<a href="${c.html_url}">View on GitHub →</a>`;
        await sendNotification(message, config);
        await addHistoryEntry({ type: "keyword", repo, keyword: alert.keyword, sha: shortSha }, env);
        sent++;
      }
    }
  }
  return sent;
}


// ── Star Milestones + Fork Monitoring (shared API call) ──

async function checkRepoMeta(repo, watch, config, env) {
  const needStars = (config.starMilestones || []).length > 0;
  const needForks = watch.forks;
  if (!needStars && !needForks) return 0;

  try {
    const repoData = await githubAPI(`/repos/${repo}`, config);
    let sent = 0;

    // Star milestones
    if (needStars) {
      const currentStars = repoData.stargazers_count;
      const kvKey = `starMilestone:${repo}`;
      const lastNotifiedStr = await env.WATCHER_STATE.get(kvKey);
      const lastNotified = parseInt(lastNotifiedStr || "0", 10);
      const milestones = config.starMilestones || [];
      const crossed = milestones.filter(m => currentStars >= m && m > lastNotified);
      if (crossed.length > 0) {
        const highestCrossed = Math.max(...crossed);
        await env.WATCHER_STATE.put(kvKey, String(highestCrossed));
        const message =
          `⭐ <b>Star Milestone!</b>\n` +
          `<b>${escapeHTML(repo)}</b>\n` +
          `Reached <b>${currentStars}</b> stars!\n` +
          `Milestone: ${crossed.map(m => m.toLocaleString()).join(', ')}\n` +
          `#GitHub仓库更新 #Star\n` +
          `<a href="https://github.com/${repo}">View on GitHub →</a>`;
        await sendNotification(message, config, 'high');
        await addHistoryEntry({ type: "star_milestone", repo, stars: currentStars, milestones: crossed, priority: 'high' }, env);
        sent++;
      }
    }

    // Fork monitoring
    if (needForks) {
      const currentForks = repoData.forks_count;
      const kvKey = `fork:${repo}`;
      const lastForksStr = await env.WATCHER_STATE.get(kvKey);
      if (lastForksStr === null) {
        await env.WATCHER_STATE.put(kvKey, String(currentForks));
      } else {
        const lastForks = parseInt(lastForksStr, 10);
        if (currentForks > lastForks) {
          await env.WATCHER_STATE.put(kvKey, String(currentForks));
          const diff = currentForks - lastForks;
          const message =
            `🍴 <b>New Fork${diff > 1 ? 's' : ''}</b>\n` +
            `<b>${escapeHTML(repo)}</b>\n` +
            `Forks: ${lastForks} → <b>${currentForks}</b> (+${diff})\n` +
            `#GitHub仓库更新 #Fork\n` +
            `<a href="https://github.com/${repo}/network/members">View Forks →</a>`;
          await sendNotification(message, config);
          await addHistoryEntry({ type: "fork", repo, forks: currentForks, diff }, env);
          sent++;
        }
      }
    }

    return sent;
  } catch (e) {
    return 0;
  }
}

// ── PR Merge / Review Monitoring ──

async function checkPRMerges(repo, config, env) {
  try {
    const data = await githubAPI(`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=5`, config);
    if (!data || !Array.isArray(data) || data.length === 0) return 0;

    const kvKey = `prMerge:${repo}`;
    const lastId = await env.WATCHER_STATE.get(kvKey);

    if (!lastId) {
      await env.WATCHER_STATE.put(kvKey, String(data[0].id));
      return 0;
    }

    const lastIdNum = parseInt(lastId, 10);
    const merged = data.filter(p => p.id > lastIdNum && p.merged_at);
    if (merged.length === 0) return 0;

    await env.WATCHER_STATE.put(kvKey, String(data[0].id));

    for (const pr of merged.reverse()) {
      const message =
        `✅ <b>PR Merged</b>\n` +
        `<b>${escapeHTML(repo)}</b>\n` +
        `#${pr.number} ${escapeHTML(pr.title || "untitled")}\n` +
        `By ${escapeHTML(pr.user?.login || "unknown")}\n` +
        `#GitHub仓库更新 #PRMerge\n` +
        `<a href="${pr.html_url}">View on GitHub →</a>`;

      await sendNotification(message, config);
      await addHistoryEntry({ type: "pr_merge", repo, number: pr.number, title: pr.title, url: pr.html_url }, env);
    }

    return merged.length;
  } catch (e) {
    return 0;
  }
}

// ── Weekly Summary ──

async function getWeeklySummary(config, env) {
  const history = (await env.WATCHER_STATE.get("history", { type: "json" })) || [];
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekHistory = history.filter(h => new Date(h.timestamp).getTime() > weekAgo);

  const summary = {};
  for (const h of weekHistory) {
    if (!summary[h.repo]) summary[h.repo] = { releases: 0, commits: 0, actions: 0, issues: 0, prs: 0, prMerges: 0, forks: 0, starMilestones: 0, keywordAlerts: 0 };
    const s = summary[h.repo];
    if (h.type === 'release') s.releases++;
    else if (h.type === 'commit' || h.type === 'commits') s.commits += h.count || 1;
    else if (h.type === 'action') s.actions++;
    else if (h.type === 'issue') s.issues++;
    else if (h.type === 'pr') s.prs++;
    else if (h.type === 'pr_merge') s.prMerges++;
    else if (h.type === 'fork') s.forks++;
    else if (h.type === 'star_milestone') s.starMilestones++;
    else if (h.type === 'keyword') s.keywordAlerts++;
  }

  return { summary, totalEvents: weekHistory.length, period: '7d' };
}

// ── Repos Comparison ──

async function getReposComparison(config, env) {
  // Check KV cache (5 min TTL)
  const cached = await env.WATCHER_STATE.get("compare_cache", { type: "json" });
  if (cached && cached.data && cached.ts && (Date.now() - cached.ts < 300000)) {
    return cached.data;
  }

  const repos = config.watchRepos || [];
  if (repos.length === 0) return { repos: [] };

  const results = [];
  for (const entry of repos.slice(0, 20)) {
    const repoName = typeof entry === "string" ? entry : entry.repo;
    try {
      const data = await githubAPI(`/repos/${repoName}`, config);
      results.push({
        repo: repoName,
        stars: data.stargazers_count,
        forks: data.forks_count,
        openIssues: data.open_issues_count,
        watchers: data.subscribers_count,
        language: data.language,
        updatedAt: data.updated_at,
        createdAt: data.created_at,
      });
    } catch (e) { /* skip */ }
  }

  const result = { repos: results };
  // Write cache (fire-and-forget)
  env.WATCHER_STATE.put("compare_cache", JSON.stringify({ data: result, ts: Date.now() }), { expirationTtl: 600 }).catch(() => {});
  return result;
}

// ── GitHub API helper ──

async function githubAPI(path, config) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "github-repo-watcher",
  };

  if (config.githubToken) {
    headers.Authorization = `Bearer ${config.githubToken}`;
  }

  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) {
    const text = await res.text();
    // Keep raw upstream response out of client-visible error messages
    console.error(`GitHub API ${res.status} ${path}: ${text}`);
    throw new Error(`GitHub API ${res.status}`);
  }
  return res.json();
}

// ── Update Hub helper ──

async function reportToUpdateHub(env, { version, title, body, status, diff_url, extra }) {
  const hubUrl = env.UPDATE_HUB_URL;
  const hubToken = env.UPDATE_HUB_TOKEN;
  if (!hubUrl || !hubToken) return;
  if (!hubUrl.startsWith("https://")) {
    console.error("UPDATE_HUB_URL must be https:// (token would be sent in plaintext)");
    return;
  }
  const PROJECT = "github-repo-watcher";
  const headers = {
    Authorization: "Bearer " + hubToken,
    "Content-Type": "application/json",
  };
  const postUpdate = () => fetch(hubUrl + "/api/projects/" + PROJECT + "/updates", {
    method: "POST",
    headers,
    body: JSON.stringify({ version, title, body, status, diff_url, extra }),
    signal: AbortSignal.timeout(15000),
  });
  try {
    let res = await postUpdate();
    if (res.status === 404) {
      // 项目未注册：自动注册后重试一次，避免上报静默丢失
      await fetch(hubUrl + "/api/projects", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: PROJECT, label: "GitHub Repo Watcher", type: "version", icon: "🐙" }),
        signal: AbortSignal.timeout(15000),
      });
      res = await postUpdate();
    }
    const result = await res.json().catch(() => ({}));
    console.log("Update Hub: " + title + " → " + (result.recorded ? "OK" : result.error || "unknown"));
  } catch (err) {
    console.error("Update Hub report failed: " + err.message);
  }
}

// ── Multi-channel notification ──

async function sendNotification(text, config, priority) {
  const prefix = priority === 'high' ? '🔴 ' : '';
  const fullText = prefix + text;
  // Always try Telegram
  try {
    await sendTelegram(fullText, config);
  } catch (e) { console.error('Telegram notify failed:', e.message); }
  // Discord webhook
  if (config.notifyDiscord && config.notifyDiscord.startsWith('https://')) {
    try {
      await fetch(config.notifyDiscord, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: fullText.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') }),
      });
    } catch (e) { console.error('Discord notify failed:', e.message); }
  }
  // Slack webhook
  if (config.notifySlack && config.notifySlack.startsWith('https://')) {
    try {
      await fetch(config.notifySlack, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: fullText.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') }),
      });
    } catch (e) { console.error('Slack notify failed:', e.message); }
  }
  // Generic webhook
  if (config.notifyWebhook && config.notifyWebhook.startsWith('https://')) {
    try {
      await fetch(config.notifyWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: fullText, raw: fullText.replace(/<[^>]*>/g, ''), priority: priority || 'normal' }),
      });
    } catch (e) { console.error('Webhook notify failed:', e.message); }
  }
}

// ── Telegram helper ──

async function sendTelegram(text, config) {
  if (!config.telegramBotToken || !config.telegramChatId) {
    console.log("Telegram not configured, skipping notification");
    return;
  }

  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Telegram API ${res.status}: ${err}`);
  }
  return res.json();
}



// ── RSS Feed ──

function generateRSS(history, baseUrl) {
  const items = history.slice(0, 50).map(h => {
    const title = h.type === 'release' ? `${h.repo} Release: ${h.name || h.tag}` :
                  h.type === 'commit' ? `${h.repo} Commit: ${h.sha}` :
                  h.type === 'commits' ? `${h.repo} ${h.count} new commits` :
                  h.type === 'action' ? `${h.repo} Actions: ${h.name}` :
                  h.type === 'issue' ? `${h.repo} Issue #${h.number}: ${h.title}` :
                  h.type === 'pr' ? `${h.repo} PR #${h.number}: ${h.title}` :
                  h.type === 'pr_merge' ? `${h.repo} PR Merged #${h.number}: ${h.title}` :
                  h.type === 'star_milestone' ? `${h.repo} ⭐ ${h.stars} Stars!` :
                  h.type === 'fork' ? `${h.repo} New Fork (+${h.diff})` :
                  h.type === 'keyword' ? `${h.repo} Keyword Alert: ${h.keyword}` :
                  `${h.repo} Update`;
    const link = h.url || h.diff_url || `${baseUrl}`;
    const pubDate = new Date(h.timestamp).toUTCString();
    return `    <item>
      <title>${escapeXML(title)}</title>
      <link>${escapeXML(link)}</link>
      <guid isPermaLink="false">${h.timestamp}-${h.type}-${h.repo}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${escapeXML(h.message || h.name || h.tag || h.title || '')}</description>
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>GitHub Repo Watcher</title>
  <link>${baseUrl}</link>
  <description>GitHub repository update notifications</description>
  <language>zh-cn</language>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
  <atom:link href="${baseUrl}/rss" rel="self" type="application/rss+xml"/>
${items}
</channel>
</rss>`;
}

function escapeXML(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Utilities ──

/** 恒定时间字符串比较：双方先 SHA-256 对齐长度，再用 timingSafeEqual 比较 */
async function constantTimeEquals(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(a))),
    crypto.subtle.digest("SHA-256", enc.encode(String(b))),
  ]);
  return crypto.subtle.timingSafeEqual(new Uint8Array(ha), new Uint8Array(hb));
}

function escapeHTML(str) {
  str = str == null ? "" : String(str);
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function truncate(str, max) {
  str = str == null ? "" : String(str);
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

function jsonResponse(data, corsHeaders, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

// ── HTML Frontend ──

function getHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GitHub Repo Watcher</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg-gradient: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      --text-primary: #e0e0e0;
      --text-secondary: #aaa;
      --text-muted: #888;
      --text-dim: #666;
      --accent: #00d9ff;
      --accent-green: #00ff88;
      --accent-gradient: linear-gradient(90deg, #00d9ff, #00ff88);
      --btn-primary-color: #000;
      --link-color: #00d9ff;
      --checkbox-accent: #00d9ff;
      --label-color: #aaa;
      --card-bg: rgba(255, 255, 255, 0.05);
      --card-border: rgba(255, 255, 255, 0.1);
      --card-border-light: rgba(255, 255, 255, 0.08);
      --input-bg: rgba(255, 255, 255, 0.08);
      --input-border: rgba(255, 255, 255, 0.15);
      --input-focus-bg: rgba(0, 217, 255, 0.05);
      --btn-secondary-bg: rgba(255, 255, 255, 0.1);
      --btn-secondary-border: rgba(255, 255, 255, 0.2);
      --btn-secondary-hover: rgba(255, 255, 255, 0.15);
      --btn-danger-bg: rgba(255, 59, 48, 0.2);
      --btn-danger-color: #ff3b30;
      --btn-danger-border: rgba(255, 59, 48, 0.3);
      --btn-danger-hover: rgba(255, 59, 48, 0.3);
      --toggle-bg: rgba(255,255,255,0.05);
      --toggle-border: rgba(255,255,255,0.15);
      --toggle-on-bg: rgba(0,217,255,0.2);
      --toggle-on-color: var(--accent);
      --toggle-on-border: rgba(0,217,255,0.4);
      --history-bg: rgba(255, 255, 255, 0.03);
      --modal-overlay: rgba(0,0,0,0.6);
      --modal-bg: #1a1a2e;
      --starred-hover: rgba(255,255,255,0.06);
      --starred-selected-bg: rgba(0,217,255,0.08);
      --starred-selected-border: rgba(0,217,255,0.4);
      --btn-primary-hover-shadow: rgba(0, 217, 255, 0.3);
      --toast-success-bg: linear-gradient(90deg, #00ff88, #00d9ff);
      --toast-success-color: #000;
      --history-release: #00ff88;
      --history-commit: #00d9ff;
      --history-commits: #ff9500;
      --history-action: #a855f7;
      --history-error: #ff3b30;
      --toast-error: #ff3b30;
    }
    [data-theme="light"] {
      --bg-gradient: linear-gradient(135deg, #e8edf5 0%, #d5dde8 100%);
      --text-primary: #1a1a2e;
      --text-secondary: #555;
      --text-muted: #666;
      --text-dim: #999;
      --accent: #0077cc;
      --accent-green: #00aa55;
      --accent-gradient: linear-gradient(90deg, #0077cc, #00aa55);
      --btn-primary-color: #fff;
      --link-color: #0077cc;
      --checkbox-accent: #0077cc;
      --label-color: #555;
      --card-bg: rgba(255, 255, 255, 0.85);
      --card-border: rgba(0, 0, 0, 0.1);
      --card-border-light: rgba(0, 0, 0, 0.06);
      --input-bg: rgba(0, 0, 0, 0.04);
      --input-border: rgba(0, 0, 0, 0.12);
      --input-focus-bg: rgba(0, 119, 204, 0.05);
      --btn-secondary-bg: rgba(0, 0, 0, 0.06);
      --btn-secondary-border: rgba(0, 0, 0, 0.15);
      --btn-secondary-hover: rgba(0, 0, 0, 0.1);
      --btn-danger-bg: rgba(255, 59, 48, 0.1);
      --btn-danger-color: #d32f2f;
      --btn-danger-border: rgba(255, 59, 48, 0.25);
      --btn-danger-hover: rgba(255, 59, 48, 0.18);
      --toggle-bg: rgba(0,0,0,0.04);
      --toggle-border: rgba(0,0,0,0.12);
      --toggle-on-bg: rgba(0,119,204,0.15);
      --toggle-on-color: #0077cc;
      --toggle-on-border: rgba(0,119,204,0.35);
      --history-bg: rgba(0, 0, 0, 0.03);
      --modal-overlay: rgba(0,0,0,0.3);
      --modal-bg: #fff;
      --starred-hover: rgba(0,0,0,0.04);
      --starred-selected-bg: rgba(0,119,204,0.06);
      --starred-selected-border: rgba(0,119,204,0.35);
      --btn-primary-hover-shadow: rgba(0, 119, 204, 0.3);
      --toast-success-bg: linear-gradient(90deg, #00aa55, #0077cc);
      --toast-success-color: #fff;
      --history-release: #00aa55;
      --history-commit: #0077cc;
      --history-commits: #e67e00;
      --history-action: #7c3aed;
      --history-error: #d32f2f;
      --toast-error: #d32f2f;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg-gradient);
      min-height: 100vh;
      color: var(--text-primary);
      padding: 20px;
      transition: background 0.3s, color 0.3s;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
    }
    .header {
      text-align: center;
      padding: 40px 20px;
      margin-bottom: 30px;
    }
    .header h1 {
      font-size: 2.5em;
      background: var(--accent-gradient);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 10px;
    }
    .header p {
      color: var(--text-muted);
      font-size: 1.1em;
    }
    .card {
      background: var(--card-bg);
      border-radius: 16px;
      padding: 30px;
      margin-bottom: 24px;
      backdrop-filter: blur(10px);
      border: 1px solid var(--card-border);
    }
    .card h2 {
      font-size: 1.3em;
      margin-bottom: 20px;
      color: var(--accent);
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .form-group {
      margin-bottom: 20px;
    }
    label {
      display: block;
      margin-bottom: 8px;
      font-weight: 500;
      color: var(--text-secondary);
    }
    label:has(input[type="checkbox"]) {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      margin-bottom: 0;
    }
    .filter-row label:has(input[type="checkbox"]) {
      padding: 10px 14px;
      border-radius: 10px;
      background: var(--card-bg);
      border: 1px solid var(--card-border-light);
      transition: border-color 0.2s;
      width: 100%;
      box-sizing: border-box;
    }
    .filter-row label:has(input[type="checkbox"]):hover {
      border-color: var(--accent);
    }
    .filter-row label:has(input[type="checkbox"]) input[type="checkbox"] {
      width: 18px;
      height: 18px;
      accent-color: var(--accent);
      flex-shrink: 0;
    }
    input, textarea {
      width: 100%;
      padding: 12px 16px;
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      border-radius: 10px;
      color: var(--text-primary);
      font-size: 14px;
      transition: all 0.3s;
    }
    input:focus, textarea:focus {
      outline: none;
      border-color: var(--accent);
      background: var(--input-focus-bg);
    }
    textarea { min-height: 100px; resize: vertical; }
    .btn {
      padding: 12px 24px;
      border: none;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s;
    }
    .btn-primary {
      background: var(--accent-gradient);
      color: var(--btn-primary-color);
    }
    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 25px var(--btn-primary-hover-shadow);
    }
    .btn-secondary {
      background: var(--btn-secondary-bg);
      color: var(--text-primary);
      border: 1px solid var(--btn-secondary-border);
    }
    .btn-secondary:hover {
      background: var(--btn-secondary-hover);
    }
    .btn-danger {
      background: var(--btn-danger-bg);
      color: var(--btn-danger-color);
      border: 1px solid var(--btn-danger-border);
    }
    .btn-danger:hover {
      background: var(--btn-danger-hover);
    }
    .btn-group {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    .repo-list {
      list-style: none;
    }
    .repo-item.pinned { border-color: var(--accent); background: var(--toggle-on-bg); }
    .repo-item.pinned .repo-name a { font-weight: 700; }
    .pin-btn { background: none; border: none; cursor: pointer; font-size: 16px; padding: 2px 6px; border-radius: 6px; transition: all 0.2s; }
    .pin-btn:hover { background: var(--btn-secondary-hover); }
    .pin-btn.pinned { color: #ffd700; }
    .pin-btn:not(.pinned) { color: var(--text-dim); }
    .pagination { display: flex; justify-content: center; align-items: center; gap: 8px; margin-top: 16px; padding: 12px 0; }
    .pagination button { padding: 6px 14px; border-radius: 8px; border: 1px solid var(--btn-secondary-border); background: var(--btn-secondary-bg); color: var(--text-primary); font-size: 13px; cursor: pointer; transition: all 0.2s; }
    .pagination button:hover:not(:disabled) { background: var(--btn-secondary-hover); }
    .pagination button:disabled { opacity: 0.4; cursor: not-allowed; }
    .pagination button.active { background: var(--accent); color: var(--btn-primary-color); border-color: var(--accent); font-weight: 600; }
    .pagination .page-info { color: var(--text-muted); font-size: 13px; }
    .sort-bar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
    .sort-bar label { font-size: 13px; color: var(--text-muted); margin-bottom: 0; }
    .sort-bar select { padding: 6px 10px; background: var(--input-bg); border: 1px solid var(--input-border); border-radius: 8px; color: var(--text-primary); font-size: 13px; }
    .repo-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 14px 18px;
      background: var(--card-bg);
      border-radius: 10px;
      margin-bottom: 10px;
      border: 1px solid var(--card-border-light);
      flex-wrap: wrap;
      gap: 8px;
    }
    .repo-item a {
      color: var(--link-color);
      text-decoration: none;
      font-weight: 500;
    }
    .repo-item a:hover { text-decoration: underline; }
    .add-repo {
      display: flex;
      gap: 12px;
      margin-top: 20px;
    }
    .add-repo input { flex: 1; }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 20px;
    }
    .stat-card {
      background: var(--card-bg);
      border-radius: 12px;
      padding: 20px;
      text-align: center;
      border: 1px solid var(--card-border-light);
    }
    .stat-value {
      font-size: 1.6em;
      font-weight: 700;
      background: var(--accent-gradient);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      word-break: break-all;
      max-width: 100%;
    }
    .stat-label {
      color: var(--text-muted);
      margin-top: 8px;
      font-size: 0.9em;
    }
    .history-item {
      padding: 16px 18px;
      background: var(--history-bg);
      border-radius: 10px;
      margin-bottom: 10px;
      border-left: 3px solid;
      font-size: 14px;
    }
    .history-item.release { border-color: var(--history-release); }
    .history-item.commit { border-color: var(--history-commit); }
    .history-item.commits { border-color: var(--history-commits); }
    .history-item.action { border-color: var(--history-action); }
    .history-item.error { border-color: var(--history-error); }
    .history-item.issue { border-color: #ff9500; }
    .history-item.pr { border-color: #a855f7; }
    .history-item.keyword { border-color: #ff3b30; }
    .quota-bar { height: 8px; border-radius: 4px; background: var(--input-bg); margin-top: 8px; overflow: hidden; }
    .quota-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
    .quota-fill.ok { background: var(--accent-green); }
    .quota-fill.warn { background: #ff9500; }
    .quota-fill.danger { background: #ff3b30; }
    .filter-row { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
    .filter-row .form-group { flex: 1; min-width: 200px; margin-bottom: 0; }
    .keyword-list { list-style: none; margin-top: 10px; }
    .keyword-item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--card-bg); border-radius: 8px; margin-bottom: 6px; border: 1px solid var(--card-border-light); }
    .keyword-item .kw { font-weight: 600; color: var(--accent); }
    .keyword-item .repo-tag { font-size: 11px; color: var(--text-dim); background: var(--input-bg); padding: 2px 6px; border-radius: 4px; }
    .stars-chart { margin-top: 12px; }
    .stars-row { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--card-border-light); }
    .stars-row .repo-name { flex: 1; font-weight: 500; color: var(--accent); font-size: 14px; }
    .stars-row .stars-count { font-weight: 700; color: var(--accent-green); font-size: 16px; }
    .stars-row .stars-delta { font-size: 12px; color: var(--text-dim); }
    .channel-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; margin-right: 4px; }
    .channel-badge.tg { background: rgba(0,136,204,0.2); color: #0088cc; }
    .channel-badge.dc { background: rgba(88,101,242,0.2); color: #5865f2; }
    .channel-badge.wh { background: rgba(255,149,0,0.2); color: #ff9500; }
    .channel-badge.sl { background: rgba(74,21,75,0.2); color: #e01e5a; }
    .history-item.star_milestone { border-color: #ffd700; }
    .history-item.fork { border-color: #00aa55; }
    .history-item.pr_merge { border-color: #00d9ff; }
    .compare-table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
    .compare-table th { text-align: left; padding: 10px 12px; border-bottom: 2px solid var(--card-border); color: var(--accent); font-weight: 600; }
    .compare-table td { padding: 10px 12px; border-bottom: 1px solid var(--card-border-light); color: var(--text-primary); }
    .compare-table tr:hover td { background: var(--input-focus-bg); }
    .compare-table a { color: var(--link-color); text-decoration: none; }
    .compare-table a:hover { text-decoration: underline; }
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-top: 12px; }
    .summary-card { background: var(--card-bg); border-radius: 10px; padding: 16px; border: 1px solid var(--card-border-light); }
    .summary-card h3 { font-size: 14px; color: var(--accent); margin-bottom: 10px; }
    .summary-stat { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }
    .summary-stat .label { color: var(--text-muted); }
    .summary-stat .value { font-weight: 600; color: var(--text-primary); }
    .priority-badge { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; margin-left: 6px; }
    .priority-badge.high { background: rgba(255,59,48,0.2); color: #ff3b30; }
    .history-meta {
      color: var(--text-dim);
      font-size: 12px;
      margin-top: 6px;
    }
    .toast {
      position: fixed;
      bottom: 30px;
      right: 30px;
      padding: 16px 24px;
      border-radius: 12px;
      color: #fff;
      font-weight: 500;
      transform: translateY(100px);
      opacity: 0;
      transition: all 0.3s;
      z-index: 1000;
    }
    .toast.show { transform: translateY(0); opacity: 1; }
    .toast.success { background: var(--toast-success-bg); color: var(--toast-success-color); }
    .toast.error { background: var(--toast-error); }
    .loading { opacity: 0.5; pointer-events: none; }
    .empty-state {
      text-align: center;
      padding: 40px;
      color: var(--text-dim);
    }
    .btn-sm { padding: 8px 16px; font-size: 12px; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; pointer-events: none; }
    .login-page { display: flex; justify-content: center; align-items: center; min-height: 80vh; }
    .login-card { max-width: 400px; width: 100%; }
    .login-card .btn { width: 100%; margin-top: 10px; }
    
    .token-hint { font-size: 12px; color: var(--text-dim); margin-top: 4px; }
    .settings-row { display: flex; gap: 12px; margin-top: 15px; }
    .settings-row .btn { flex: 1; }
    .theme-switcher {
      display: flex; justify-content: center; gap: 6px; margin-top: 16px;
    }
    .theme-btn {
      width: 36px; height: 36px; border-radius: 10px; border: 1px solid var(--card-border);
      background: var(--card-bg); font-size: 16px; cursor: pointer; transition: all 0.2s;
      display: flex; align-items: center; justify-content: center;
    }
    .theme-btn:hover { background: var(--btn-secondary-hover); }
    .theme-btn.active { border-color: var(--accent); background: var(--toggle-on-bg); box-shadow: 0 0 8px rgba(0,217,255,0.2); }
    @media (max-width: 600px) {
      body { padding: 10px; }
      .header h1 { font-size: 1.8em; }
      .card { padding: 20px; }
      .btn-group { flex-direction: column; }
      .add-repo { flex-direction: column; }
      .sort-bar { flex-wrap: wrap; }
      .sort-bar select, .sort-bar input { flex: 1; min-width: 120px; }
      .batch-bar { flex-wrap: wrap; }
      .repo-row { flex-wrap: wrap; }
      .repo-name { min-width: 100%; }
      .repo-toggles { flex-wrap: wrap; }
      #compare-table { overflow-x: auto; -webkit-overflow-scrolling: touch; }
      #compare-table table { min-width: 560px; }
      .settings-row { flex-direction: column; }
      .filter-row { flex-direction: column; }
    }
    .batch-bar { display: flex; align-items: center; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
    .batch-bar label { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 14px; color: var(--text-secondary); }
    .batch-bar select { padding: 6px 10px; background: var(--input-bg); border: 1px solid var(--input-border); border-radius: 8px; color: var(--text-primary); font-size: 13px; }
    .repo-check { width: 18px; height: 18px; accent-color: var(--accent); cursor: pointer; flex-shrink: 0; }
    .stars-svg { width: 100%; height: auto; display: block; margin-bottom: 12px; color: var(--text-secondary); }
    .stars-legend { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 12px; }
    .stars-legend-item { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-secondary); }
    .stars-legend-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }

    details { margin-bottom: 24px; }
    details > summary {
      list-style: none;
      cursor: pointer;
      background: var(--card-bg);
      border-radius: 16px;
      padding: 20px 30px;
      border: 1px solid var(--card-border);
      backdrop-filter: blur(10px);
      display: flex;
      align-items: center;
      gap: 10px;
      transition: border-radius 0.3s;
    }
    details[open] > summary { border-radius: 16px 16px 0 0; }
    details > summary:hover { background: var(--btn-secondary-hover); }
    details > summary::-webkit-details-marker { display: none; }
    details > summary::after {
      content: '▸';
      margin-left: auto;
      transition: transform 0.3s;
      color: var(--text-muted);
      font-size: 1.2em;
    }
    details[open] > summary::after { transform: rotate(90deg); }
    details > summary h2 { margin: 0; font-size: 1.3em; color: var(--accent); display: flex; align-items: center; gap: 10px; }
    details > .card-inner {
      background: var(--card-bg);
      border-radius: 0 0 16px 16px;
      border: 1px solid var(--card-border);
      border-top: none;
      margin-top: -1px;
      padding: 30px;
      overflow: hidden;
    }
    details > .card-inner.collapsing {
      transition: max-height 0.3s ease, opacity 0.25s ease;
      opacity: 0;
    }
    details > .card-inner.expanding {
      transition: max-height 0.3s ease, opacity 0.25s ease;
      opacity: 1;
    }
    .repo-name { flex: 1; min-width: 200px; }
    .repo-toggles { display: flex; gap: 6px; align-items: center; }
    .toggle-btn {
      padding: 3px 8px; border-radius: 6px; font-size: 11px; font-weight: 600;
      border: 1px solid var(--toggle-border); cursor: pointer; transition: all 0.2s;
      background: var(--toggle-bg); color: var(--text-dim);
    }
    .toggle-btn.on { background: var(--toggle-on-bg); color: var(--toggle-on-color); border-color: var(--toggle-on-border); }
    .toggle-btn:hover { background: var(--btn-secondary-hover); }
    .add-repo-options { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; align-items: center; }
    .add-repo-options label { display: flex; align-items: center; gap: 4px; font-size: 13px; color: var(--label-color); cursor: pointer; margin: 0; }
    .add-repo-options input[type="checkbox"] { width: 14px; height: 14px; accent-color: var(--checkbox-accent); }
    .starred-item {
      display: flex; align-items: center; gap: 12px; padding: 12px 16px;
      background: var(--card-bg); border-radius: 10px; margin-bottom: 8px;
      border: 1px solid var(--card-border-light); cursor: pointer; transition: all 0.2s;
    }
    .starred-item:hover { background: var(--starred-hover); }
    .starred-item.selected { border-color: var(--starred-selected-border); background: var(--starred-selected-bg); }
    .starred-item.already { opacity: 0.4; pointer-events: none; }
    .starred-item input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--checkbox-accent); flex-shrink: 0; }
    .starred-info { flex: 1; min-width: 0; }
    .starred-info .name { font-weight: 600; color: var(--accent); font-size: 14px; }
    .starred-info .desc { color: var(--text-muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
    .starred-info .meta { color: var(--text-dim); font-size: 11px; margin-top: 4px; display: flex; gap: 12px; }
    .repo-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
    .repo-activity {
      width: 100%; display: flex; flex-wrap: wrap; gap: 8px 16px;
      padding-top: 8px; border-top: 1px solid var(--card-border-light); margin-top: 8px;
    }
    .repo-act-item {
      font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 4px;
    }
    .repo-act-item a { color: var(--link-color); text-decoration: none; font-weight: 500; }
    .repo-act-item a:hover { text-decoration: underline; }
    .starred-search { width: 100%; padding: 10px 14px; background: var(--input-bg); border: 1px solid var(--input-border); border-radius: 8px; color: var(--text-primary); font-size: 13px; margin-bottom: 12px; }
  </style>
</head>
<body>
  <!-- Login Page -->
  <div id="login-page" class="login-page" style="display:none">
    <div class="login-card card">
      <h2 style="justify-content:center">🔒 访问验证</h2>
      <div class="form-group">
        <label>密码</label>
        <input type="password" id="login-password" placeholder="请输入访问密码" onkeydown="if(event.key==='Enter')doLogin()">
      </div>
      <button class="btn btn-primary" id="btn-login" onclick="doLogin()">进入</button>
      <p id="login-error" style="color:#ff3b30;margin-top:10px;text-align:center;display:none">密码错误</p>
    </div>
  </div>

  <!-- Main App -->
  <div id="app" style="display:none">
  <div class="container">
    <div class="header">
      <h1>GitHub Repo Watcher</h1>
      <p>自动监控 GitHub 仓库更新，Telegram 实时通知</p>
      <div class="theme-switcher">
        <button class="theme-btn" data-theme="dark" onclick="setTheme('dark')" title="深色">🌙</button>
        <button class="theme-btn" data-theme="auto" onclick="setTheme('auto')" title="自动">💻</button>
        <button class="theme-btn" data-theme="light" onclick="setTheme('light')" title="浅色">☀️</button>
      </div>
    </div>

    <!-- 1. Repos Management -->
    <details open>
      <summary><h2>📦 监控仓库</h2></summary>
      <div class="card-inner">
        <div class="sort-bar">
          <label>排序：</label>
          <select id="repo-sort-field" onchange="onSortChange()">
            <option value="default">默认</option>
            <option value="name">名称</option>
            <option value="created">创建时间</option>
            <option value="updated">更新时间</option>
          </select>
          <select id="repo-sort-dir" onchange="onSortChange()">
            <option value="asc">正序 ↑</option>
            <option value="desc">倒序 ↓</option>
          </select>
          <select id="repo-sort-priority" onchange="onSortChange()">
            <option value="latest">取最新</option>
            <option value="release">🏷️ Release</option>
            <option value="commit">📝 Commit</option>
            <option value="action">⚡ Actions</option>
            <option value="issue">🆕 Issue</option>
            <option value="pr">🔀 PR</option>
            <option value="fork">🍴 Fork</option>
            <option value="pr_merge">✅ PR Merge</option>
          </select>
          <input type="text" id="repo-search" placeholder="🔍 搜索仓库…" oninput="onRepoSearch()" style="flex:1;min-width:140px">
        </div>
        <ul class="repo-list" id="repo-list">
          <li class="empty-state">加载中…</li>
        </ul>
        <div class="batch-bar">
          <label><input type="checkbox" id="batch-select-all" onchange="toggleSelectAll(this.checked)"> 全选</label>
          <select id="batch-watch-key">
            <option value="releases">🏷️ Release</option>
            <option value="ignorePreRelease">🚫 Pre-release</option>
            <option value="commits">📝 Commit</option>
            <option value="actions">⚡ Actions</option>
            <option value="issues">🆕 Issue</option>
            <option value="prs">🔀 PR</option>
            <option value="forks">🍴 Fork</option>
            <option value="prReviews">✅ PR Merge</option>
          </select>
          <button class="btn btn-secondary btn-sm" onclick="batchSetWatch(true)">批量开启</button>
          <button class="btn btn-secondary btn-sm" onclick="batchSetWatch(false)">批量关闭</button>
          <button class="btn btn-danger btn-sm" onclick="batchDelete()">批量删除</button>
        </div>
        <div class="add-repo">
          <input type="text" id="new-repo" placeholder="输入仓库名，如 facebook/react">
          <button class="btn btn-primary" id="btn-add-repo" onclick="addRepo()">➕ 添加</button>
        </div>
        <div class="add-repo-options">
          <label><input type="checkbox" id="opt-releases" checked> 🏷️ Release</label>
          <label><input type="checkbox" id="opt-ignore-pre"> 🚫 Pre</label>
          <label><input type="checkbox" id="opt-commits"> 📝 Commit</label>
          <label><input type="checkbox" id="opt-actions"> ⚡ Actions</label>
          <label><input type="checkbox" id="opt-issues"> 🆕 Issue</label>
          <label><input type="checkbox" id="opt-prs"> 🔀 PR</label>
          <label><input type="checkbox" id="opt-forks"> 🍴 Fork</label>
          <label><input type="checkbox" id="opt-pr-reviews"> ✅ PR Merge</label>
          <button class="btn btn-secondary btn-sm" id="btn-import-stars" onclick="showStarredModal()" style="margin-left:auto">⭐ 从 Star 导入</button>
        </div>
      </div>
    </details>

    <!-- 2. Status Stats -->
    <details>
      <summary><h2>📊 运行状态</h2></summary>
      <div class="card-inner">
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-value" id="stat-repos">-</div>
            <div class="stat-label">监控仓库</div>
          </div>
          <div class="stat-card">
            <div class="stat-value" id="stat-notifications">-</div>
            <div class="stat-label">已发送通知</div>
          </div>
          <div class="stat-card">
            <div class="stat-value" id="stat-telegram">-</div>
            <div class="stat-label">Telegram 状态</div>
          </div>
          <div class="stat-card">
            <div class="stat-value" id="stat-last-check">-</div>
            <div class="stat-label">最后检查</div>
          </div>
          <div class="stat-card">
            <div class="stat-value" id="stat-cron">-</div>
            <div class="stat-label">检查频率</div>
          </div>
          <div class="stat-card">
            <div class="stat-value" id="stat-quota">-</div>
            <div class="stat-label">API 配额</div>
            <div class="quota-bar"><div class="quota-fill ok" id="quota-bar-fill" style="width:0%"></div></div>
          </div>
        </div>
        <div style="margin-top:12px;color:var(--text-muted);font-size:13px" id="notify-channels"></div>
        <div class="btn-group" style="margin-top: 20px;">
          <button class="btn btn-secondary" id="btn-check-now" onclick="checkNow()">🔄 立即检查</button>
          <button class="btn btn-secondary" id="btn-test-tg" onclick="testTelegram()">💬 测试 Telegram</button>
        </div>
      </div>
    </details>

    <!-- 3. Notification Channels -->
    <details>
      <summary><h2>🔔 通知渠道</h2></summary>
      <div class="card-inner">
        <div class="form-group">
          <label>Telegram Bot Token</label>
          <input type="password" id="telegram-token" placeholder="从 @BotFather 获取">
        </div>
        <div class="form-group">
          <label>Telegram Chat ID</label>
          <input type="text" id="telegram-chat-id" placeholder="私聊或群组的 Chat ID">
        </div>
        <div class="form-group">
          <label>Discord Webhook URL（可选）</label>
          <input type="text" id="discord-webhook" placeholder="https://discord.com/api/webhooks/...">
        </div>
        <div class="form-group">
          <label>Slack Webhook URL（可选）</label>
          <input type="text" id="slack-webhook" placeholder="https://hooks.slack.com/services/...">
        </div>
        <div class="form-group">
          <label>自定义 Webhook URL（可选）</label>
          <input type="text" id="custom-webhook" placeholder="https://your-server.com/webhook">
        </div>
        <div class="form-group">
          <label>GitHub Token（可选）</label>
          <input type="password" id="github-token" placeholder="提升 API 速率限制">
          <div class="token-hint" id="github-token-hint"></div>
        </div>
        <button class="btn btn-primary" id="btn-save-config" onclick="saveConfig()">💾 保存设置</button>
      </div>
    </details>

    <!-- 4. Access Password -->
    <details>
      <summary><h2>🔐 访问密码</h2></summary>
      <div class="card-inner">
        <div class="form-group">
          <label>Dashboard 访问密码</label>
          <input type="password" id="access-password" placeholder="留空则不需要密码">
        </div>
        <div class="settings-row">
          <button class="btn btn-primary" id="btn-save-password" onclick="savePassword()">设置密码</button>
          <button class="btn btn-danger" id="btn-clear-password" onclick="clearPassword()">取消密码</button>
        </div>
      </div>
    </details>

    <!-- 5. Filters -->
    <details>
      <summary><h2>🔍 过滤规则</h2></summary>
      <div class="card-inner">
        <div class="filter-row">
          <div class="form-group">
            <label style="font-weight:normal"><input type="checkbox" id="filter-ignore-pre"> 忽略 Pre-release（跳过预发布版本）</label>
          </div>
          <div class="form-group">
            <label style="font-weight:normal"><input type="checkbox" id="filter-actions-fail"> 仅 Actions 失败通知（只通知失败的 workflow）</label>
          </div>
        </div>
        <div class="filter-row">
          <div class="form-group">
            <label>忽略的作者（逗号分隔）</label>
            <input type="text" id="filter-ignore-authors" placeholder="如 dependabot,renovate[bot]">
          </div>
          <div class="form-group">
            <label>忽略的标签（逗号分隔）</label>
            <input type="text" id="filter-ignore-labels" placeholder="如 duplicate,wontfix">
          </div>
        </div>
        <div class="filter-row">
          <div class="form-group">
            <label>Release 标签关键词</label>
            <input type="text" id="filter-tag-keyword" placeholder="只通知包含此关键词的 tag">
          </div>
          <div class="form-group">
            <label>Commit 消息关键词</label>
            <input type="text" id="filter-commit-keyword" placeholder="只通知包含此关键词的 commit">
          </div>
        </div>
        <button class="btn btn-primary" id="btn-save-filters" onclick="saveFilters()">💾 保存过滤规则</button>
      </div>
    </details>

    <!-- 6. Notification Settings -->
    <details>
      <summary><h2>⚙️ 通知设置</h2></summary>
      <div class="card-inner">
        <div class="filter-row">
          <div class="form-group">
            <label>Star 里程碑（逗号分隔）</label>
            <input type="text" id="star-milestones" placeholder="如 100,500,1000">
            <div class="token-hint">达到这些 Star 数时发送通知</div>
          </div>
          <div class="form-group">
            <label>周报摘要</label>
            <label style="font-weight:normal"><input type="checkbox" id="weekly-summary"> 启用每周摘要汇总</label>
          </div>
        </div>
        <button class="btn btn-primary" id="btn-save-notify-settings" onclick="saveNotifySettings()">💾 保存通知设置</button>
      </div>
    </details>

    <!-- 6.5 Config Backup -->
    <details>
      <summary><h2>💾 配置备份</h2></summary>
      <div class="card-inner">
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">导出仓库列表、过滤规则、告警等配置（不含 Token 密钥）。导入会覆盖对应配置项。</p>
        <div class="settings-row">
          <button class="btn btn-secondary" onclick="exportConfig()">⬇️ 导出配置</button>
          <button class="btn btn-secondary" onclick="triggerImport()">⬆️ 导入配置</button>
          <input type="file" id="import-file" accept="application/json" style="display:none" onchange="importConfig(this)">
        </div>
      </div>
    </details>

    <!-- 7. Keyword Alerts -->
    <details>
      <summary><h2>🔔 关键词告警</h2></summary>
      <div class="card-inner">
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">当 commit 消息包含指定关键词时发送告警通知。仓库填 * 表示所有仓库。</p>
        <ul class="keyword-list" id="keyword-list"><li class="empty-state">暂无告警规则</li></ul>
        <div class="add-repo" style="margin-top:12px">
          <input type="text" id="kw-repo" list="kw-repo-list" placeholder="仓库名或 *" style="flex:0.5">
          <datalist id="kw-repo-list"></datalist>
          <input type="text" id="kw-keyword" placeholder="如 CVE, security, breaking" style="flex:1">
          <button class="btn btn-primary" onclick="addKeywordAlert()">➕ 添加</button>
        </div>
      </div>
    </details>

    <!-- 7. Stars Trends -->
    <details>
      <summary><h2>⭐ Stars 趋势</h2></summary>
      <div class="card-inner">
        <div id="stars-chart"><div class="empty-state">加载中...</div></div>
      </div>
    </details>

    <!-- 8. Repo Comparison -->
    <details>
      <summary><h2>📊 仓库对比</h2></summary>
      <div class="card-inner">
        <div id="compare-table"><div class="empty-state">加载中...</div></div>
      </div>
    </details>

    <!-- 9. Weekly Summary -->
    <details>
      <summary><h2>📋 周报摘要</h2></summary>
      <div class="card-inner">
        <div id="summary-content"><div class="empty-state">加载中...</div></div>
      </div>
    </details>

    <!-- 10. History -->
    <details>
      <summary>
        <h2>📜 通知历史</h2>
        <button class="btn btn-danger btn-sm" id="btn-clear-history" onclick="event.stopPropagation();clearHistory()" style="margin-left:auto">🗑️ 清空</button>
      </summary>
      <div class="card-inner">
        <div class="sort-bar">
          <select id="history-time" onchange="setHistoryFilter(this.value)">
            <option value="all">全部时间</option>
            <option value="1">近 1 天</option>
            <option value="7">近 7 天</option>
            <option value="30">近 30 天</option>
          </select>
          <select id="history-type" onchange="onHistoryFilterChange()">
            <option value="all">全部类型</option>
            <option value="release">🏷️ Release</option>
            <option value="commit">📝 Commit</option>
            <option value="action">⚡ Actions</option>
            <option value="issue">🆕 Issue</option>
            <option value="pr">🔀 PR</option>
            <option value="pr_merge">✅ PR Merge</option>
            <option value="keyword">🔔 关键词</option>
            <option value="star_milestone">⭐ Star</option>
            <option value="fork">🍴 Fork</option>
            <option value="error">❌ 错误</option>
          </select>
          <input type="text" id="history-search" placeholder="🔍 搜索仓库 / 内容…" oninput="onHistoryFilterChange()" style="flex:1;min-width:140px">
        </div>
        <div id="history-list">
          <div class="empty-state">暂无通知记录</div>
        </div>
        <button class="btn btn-secondary btn-sm" id="btn-history-more" onclick="loadMoreHistory()" style="display:none;width:100%;margin-top:12px">加载更多</button>
      </div>
    </details>
  </div>
  </div>

  <!-- Starred Modal -->
  <div id="starred-modal" style="display:none;position:fixed;inset:0;z-index:999;background:var(--modal-overlay);backdrop-filter:blur(4px);justify-content:center;align-items:center" onclick="if(event.target===this)closeStarredModal()">
    <div style="background:var(--modal-bg);border:1px solid var(--card-border);border-radius:16px;width:90%;max-width:700px;max-height:80vh;display:flex;flex-direction:column">
      <div style="padding:20px 24px;border-bottom:1px solid var(--card-border);display:flex;justify-content:space-between;align-items:center">
        <h2 style="margin:0;color:var(--accent);font-size:1.2em">⭐ GitHub Starred Repos</h2>
        <button class="btn btn-secondary btn-sm" onclick="closeStarredModal()">✕</button>
      </div>
      <div id="starred-list" style="padding:16px 24px;overflow-y:auto;flex:1">
        <div class="empty-state">加载中...</div>
      </div>
      <div style="padding:16px 24px;border-top:1px solid var(--card-border);display:flex;justify-content:space-between;align-items:center">
        <span id="starred-count" style="color:var(--text-muted);font-size:13px">已选 0 个</span>
        <button class="btn btn-primary" id="btn-add-starred" onclick="addStarredRepos()">➕ 添加选中</button>
      </div>
    </div>
  </div>

  <!-- Toast -->
  <div class="toast" id="toast"></div>

  <script>
    // Theme
    function setTheme(mode) {
      localStorage.setItem('grw_theme', mode);
      applyTheme(mode);
    }
    function applyTheme(mode) {
      const root = document.documentElement;
      if (mode === 'light') {
        root.setAttribute('data-theme', 'light');
      } else if (mode === 'dark') {
        root.removeAttribute('data-theme');
      } else {
        // auto: follow system
        if (window.matchMedia('(prefers-color-scheme: light)').matches) {
          root.setAttribute('data-theme', 'light');
        } else {
          root.removeAttribute('data-theme');
        }
      }
      document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === mode));
    }
    // Apply saved theme immediately
    applyTheme(localStorage.getItem('grw_theme') || 'auto');
    // Listen for system theme changes in auto mode
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (!localStorage.getItem('grw_theme') || localStorage.getItem('grw_theme') === 'auto') applyTheme('auto');
    });

    // Collapsible animation — only bind to <summary>, not the whole <details>
    document.querySelectorAll('details').forEach(detail => {
      const inner = detail.querySelector('.card-inner');
      if (!inner) return;
      if (!detail.open) {
        inner.style.maxHeight = '0';
        inner.style.opacity = '0';
      }
      const summary = detail.querySelector('summary');
      if (!summary) return;
      summary.addEventListener('click', e => {
        if (e.target.closest('button, input, textarea, select, label, a')) return;
        e.preventDefault();
        if (detail.open) {
          // Collapse
          inner.style.overflow = 'hidden';
          inner.style.maxHeight = inner.scrollHeight + 'px';
          inner.style.transition = 'max-height 0.3s ease, opacity 0.25s ease';
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              inner.style.maxHeight = '0';
              inner.style.opacity = '0';
            });
          });
          setTimeout(() => { detail.removeAttribute('open'); inner.style.transition = ''; }, 300);
        } else {
          // Expand
          detail.setAttribute('open', '');
          inner.style.overflow = 'hidden';
          inner.style.maxHeight = '0';
          inner.style.opacity = '0';
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              inner.style.transition = 'max-height 0.3s ease, opacity 0.25s ease';
              inner.style.maxHeight = inner.scrollHeight + 'px';
              inner.style.opacity = '1';
              setTimeout(() => { inner.style.maxHeight = ''; inner.style.overflow = ''; inner.style.transition = ''; }, 300);
            });
          });
        }
      });
    });

    const API = '';
    let authToken = sessionStorage.getItem('grw_token') || '';

    async function fetchAPI(path, options = {}) {
      const headers = { 'Content-Type': 'application/json', ...options.headers };
      if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
      const res = await fetch(API + path, { ...options, headers });
      if (res.status === 401) {
        authToken = '';
        sessionStorage.removeItem('grw_token');
        showLogin();
        throw new Error('需要重新登录');
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Request failed');
      }
      return res.json();
    }

    let _toastTimer = null;
    function showToast(msg, type = 'success') {
      const toast = document.getElementById('toast');
      if (_toastTimer) clearTimeout(_toastTimer);
      toast.textContent = msg;
      toast.className = 'toast show ' + type;
      _toastTimer = setTimeout(() => { toast.className = 'toast'; _toastTimer = null; }, 3000);
    }

    function setBtnLoading(id, loading) {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.disabled = loading;
      if (loading) btn.dataset.origText = btn.textContent;
      else if (btn.dataset.origText) btn.textContent = btn.dataset.origText;
    }

    function showLogin() {
      document.getElementById('login-page').style.display = 'flex';
      document.getElementById('app').style.display = 'none';
    }

    function showApp() {
      document.getElementById('login-page').style.display = 'none';
      document.getElementById('app').style.display = 'block';
    }

    async function doLogin() {
      const pw = document.getElementById('login-password').value;
      try {
        const r = await fetch(API + '/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pw }),
        });
        const data = await r.json();
        if (data.setupRequired) {
          // 首次使用：把输入的密码设置为初始访问密码，然后重新登录
          if (!pw || pw.length < 8) {
            const el = document.getElementById('login-error');
            el.textContent = '首次使用请设置至少 8 位的访问密码';
            el.style.display = 'block';
            return;
          }
          const set = await fetch(API + '/api/auth/password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pw }),
          });
          if (set.ok) {
            // 获取正式 session token，避免明文密码作为 Bearer Token
            const loginRes = await fetch(API + '/api/auth', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ password: pw }),
            });
            const loginData = await loginRes.json();
            if (loginData.authenticated) {
              authToken = loginData.token;
              sessionStorage.setItem('grw_token', authToken);
              document.getElementById('login-error').style.display = 'none';
              showApp();
              initApp();
              showToast('访问密码已设置，请妥善保存');
            }
            return;
          }
        }
        if (data.authenticated) {
          authToken = data.token || pw;
          sessionStorage.setItem('grw_token', authToken);
          document.getElementById('login-error').style.display = 'none';
          showApp();
          initApp();
        } else {
          document.getElementById('login-error').style.display = 'block';
        }
      } catch (e) {
        document.getElementById('login-error').style.display = 'block';
      }
    }

    async function loadStatus() {
      const status = await fetchAPI('/api/status');
      document.getElementById('stat-repos').textContent = status.reposCount;
      document.getElementById('stat-notifications').textContent = status.notificationsSent;
      document.getElementById('stat-telegram').textContent = status.telegramConfigured ? '✅ 已配置' : '❌ 未配置';
      document.getElementById('stat-last-check').textContent = status.lastCheck
        ? new Date(status.lastCheck).toLocaleString('zh-CN')
        : '从未';
      document.getElementById('stat-cron').textContent = status.cronSchedule || '*/30 * * * *';
      // API Quota
      if (status.apiQuota) {
        const q = status.apiQuota;
        const pct = Math.round((q.remaining / q.limit) * 100);
        document.getElementById('stat-quota').textContent = q.remaining + '/' + q.limit;
        const fill = document.getElementById('quota-bar-fill');
        fill.style.width = pct + '%';
        fill.className = 'quota-fill ' + (pct > 30 ? 'ok' : pct > 10 ? 'warn' : 'danger');
      }
      // Channels
      const ch = status.channels || [];
      if (ch.length > 0) {
        document.getElementById('notify-channels').innerHTML = '通知渠道: ' + ch.map(c =>
          '<span class="channel-badge ' + (c === 'Telegram' ? 'tg' : c === 'Discord' ? 'dc' : c === 'Slack' ? 'sl' : 'wh') + '">' + c + '</span>'
        ).join('');
      }
    }

    async function loadConfig() {
      const config = await fetchAPI('/api/config');
      const tokenInput = document.getElementById('telegram-token');
      const ghInput = document.getElementById('github-token');
      // Masked values round-trip unchanged (server keeps existing); clearing a field removes the value
      tokenInput.value = config.telegramBotToken || '';
      tokenInput.placeholder = '从 @BotFather 获取';
      document.getElementById('telegram-chat-id').value = config.telegramChatId || '';
      ghInput.value = config.githubToken || '';
      ghInput.placeholder = '提升 API 速率限制';
      // Discord & Webhook
      document.getElementById('discord-webhook').value = config.notifyDiscord || '';
      document.getElementById('custom-webhook').value = config.notifyWebhook || '';
      // Filters
      const f = config.filters || {};
      document.getElementById('filter-ignore-pre').checked = !!f.ignorePreRelease;
      document.getElementById('filter-actions-fail').checked = !!f.actionsOnlyFailures;
      document.getElementById('filter-ignore-authors').value = (f.ignoreAuthors || []).join(',');
      document.getElementById('filter-ignore-labels').value = (f.ignoreLabels || []).join(',');
      document.getElementById('filter-tag-keyword').value = f.tagKeyword || '';
      document.getElementById('filter-commit-keyword').value = f.commitKeyword || '';
      // Keyword alerts
      renderKeywordAlerts(config.keywordAlerts || []);
      // Slack
      document.getElementById('slack-webhook').value = config.notifySlack || '';
      // Notification settings
      document.getElementById('star-milestones').value = (config.starMilestones || [100, 500, 1000]).join(',');
      document.getElementById('weekly-summary').checked = !!config.weeklySummary;
    }

    async function saveConfig() {
      setBtnLoading('btn-save-config', true);
      try {
        const tokenVal = document.getElementById('telegram-token').value.trim();
        const ghVal = document.getElementById('github-token').value.trim();
        const body = {
          telegramChatId: document.getElementById('telegram-chat-id').value.trim(),
          telegramBotToken: tokenVal,
          githubToken: ghVal,
          notifyDiscord: document.getElementById('discord-webhook').value.trim(),
          notifySlack: document.getElementById('slack-webhook').value.trim(),
          notifyWebhook: document.getElementById('custom-webhook').value.trim(),
        };
        await fetchAPI('/api/config', { method: 'POST', body: JSON.stringify(body) });
        showToast('设置已保存');
        loadConfig();
        loadStatus();
      } catch (e) {
        showToast('保存失败: ' + e.message, 'error');
      } finally {
        setBtnLoading('btn-save-config', false);
      }
    }

    async function savePassword() {
      const pw = document.getElementById('access-password').value;
      if (!pw) { showToast('请输入新密码', 'error'); return; }
      const currentPw = prompt('请输入当前密码（首次设置请留空）：') || '';
      setBtnLoading('btn-save-password', true);
      try {
        const body = { password: pw };
        if (currentPw) body.currentPassword = currentPw;
        await fetchAPI('/api/auth/password', { method: 'POST', body: JSON.stringify(body) });
        showToast('密码已设置');
        document.getElementById('access-password').value = '';
      } catch (e) {
        showToast('设置失败: ' + e.message, 'error');
      } finally {
        setBtnLoading('btn-save-password', false);
      }
    }

    async function clearPassword() {
      if (!confirm('确定要取消访问密码吗？')) return;
      setBtnLoading('btn-clear-password', true);
      try {
        await fetchAPI('/api/auth/password', { method: 'POST', body: JSON.stringify({ password: '' }) });
        showToast('密码已取消');
      } catch (e) {
        showToast('操作失败: ' + e.message, 'error');
      } finally {
        setBtnLoading('btn-clear-password', false);
      }
    }

    function escapeHTML(s) { s = s == null ? '' : String(s); return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
    function truncate(s, max) { s = s == null ? '' : String(s); return s.length > max ? s.slice(0, max - 1) + '\u2026' : s; }

    function formatTimeAgo(dateStr) {
      if (!dateStr) return '';
      const diff = Date.now() - new Date(dateStr).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return '刚刚';
      if (mins < 60) return mins + ' 分钟前';
      const hours = Math.floor(mins / 60);
      if (hours < 24) return hours + ' 小时前';
      const days = Math.floor(hours / 24);
      if (days < 30) return days + ' 天前';
      return new Date(dateStr).toLocaleDateString('zh-CN');
    }

    let _sortField = localStorage.getItem('grw_sort_field') || 'updated';
    let _sortAsc = (localStorage.getItem('grw_sort_asc') || 'desc') === 'asc';
    let _sortPriority = localStorage.getItem('grw_sort_priority') || 'latest';
    let _repoPage = 1;
    let _repoSearch = '';
    const _pageSize = 10;

    function onRepoSearch() {
      _repoSearch = document.getElementById('repo-search').value.trim().toLowerCase();
      _repoPage = 1;
      loadRepos();
    }

    async function loadRepos() {
      // Sync select controls with current state
      const sf = document.getElementById('repo-sort-field');
      const sd = document.getElementById('repo-sort-dir');
      if (sf) sf.value = _sortField;
      if (sd) sd.value = _sortAsc ? 'asc' : 'desc';
      const sp = document.getElementById('repo-sort-priority');
      if (sp) sp.value = _sortPriority;
      let repos, actData;
      try {
        [{ repos }, actData] = await Promise.all([
          fetchAPI('/api/repos'),
          fetchAPI('/api/repos/activity').catch(() => ({ activity: [] })),
        ]);
      } catch (e) {
        document.getElementById('repo-list').innerHTML = '<li class="empty-state">加载失败</li>';
        return;
      }
      const actMap = {};
      (actData.activity || []).forEach(a => { actMap[a.repo] = a; });

      // Keep the keyword-alert repo datalist in sync with watched repos
      const dl = document.getElementById('kw-repo-list');
      if (dl) {
        dl.innerHTML = '<option value="*">所有仓库</option>' + repos.map(r => {
          const name = typeof r === 'string' ? r : r.repo;
          return '<option value="' + escapeHTML(name) + '">';
        }).join('');
      }

      // Search filter
      const visible = _repoSearch ? repos.filter(r => {
        const name = typeof r === 'string' ? r : r.repo;
        return name.toLowerCase().includes(_repoSearch);
      }) : repos;

      // Sort: pinned always first, then by chosen field
      const sorted = visible.slice().sort((a, b) => {
        const pa = a.pinned ? 1 : 0;
        const pb = b.pinned ? 1 : 0;
        if (pa !== pb) return pb - pa;
        if (_sortField === 'default') return 0;
        if (_sortField === 'name') {
          const ra = (typeof a === 'string' ? a : a.repo).toLowerCase();
          const rb = (typeof b === 'string' ? b : b.repo).toLowerCase();
          return _sortAsc ? ra.localeCompare(rb) : rb.localeCompare(ra);
        }
        if (_sortField === 'created') {
          const ca = actMap[(typeof a === 'string' ? a : a.repo)]?.latestCommit?.date || '';
          const cb = actMap[(typeof b === 'string' ? b : b.repo)]?.latestCommit?.date || '';
          return _sortAsc ? ca.localeCompare(cb) : cb.localeCompare(ca);
        }
        if (_sortField === 'updated') {
          const getUpdated = (entry) => {
            const act = actMap[(typeof entry === 'string' ? entry : entry.repo)] || {};
            if (_sortPriority === 'release') return act.latestRelease?.date || '';
            if (_sortPriority === 'commit') return act.latestCommit?.date || '';
            if (_sortPriority === 'action') return act.latestAction?.date || '';
            if (_sortPriority === 'issue') return act.latestIssue?.date || '';
            if (_sortPriority === 'pr') return act.latestPR?.date || '';
            if (_sortPriority === 'fork') return act.latestFork?.date || '';
            if (_sortPriority === 'pr_merge') return act.latestPRMerge?.date || '';
            // latest: 取所有中较新的
            const dates = [act.latestRelease?.date, act.latestCommit?.date, act.latestAction?.date, act.latestIssue?.date, act.latestPR?.date].filter(Boolean);
            return dates.sort().pop() || '';
          };
          const ua = getUpdated(a);
          const ub = getUpdated(b);
          return _sortAsc ? ua.localeCompare(ub) : ub.localeCompare(ua);
        }
        return 0;
      });

      const list = document.getElementById('repo-list');
      if (sorted.length === 0) {
        list.innerHTML = '<li class="empty-state">暂无监控仓库，请添加</li>';
        return;
      }
      // Pagination
      const totalPages = Math.ceil(sorted.length / _pageSize);
      if (_repoPage > totalPages) _repoPage = totalPages;
      if (_repoPage < 1) _repoPage = 1;
      const pageStart = (_repoPage - 1) * _pageSize;
      const pageItems = sorted.slice(pageStart, pageStart + _pageSize);
      list.innerHTML = pageItems.map(r => {
        const repo = typeof r === 'string' ? r : r.repo;
        const w = (typeof r === 'string' ? {} : r.watch) || {};
        const pinned = !!r.pinned;
        const safe = escapeHTML(repo);
        const act = actMap[repo];
        const mkBtn = (key, label) => '<button class="toggle-btn ' + (w[key] ? 'on' : '') + '" data-repo="' + safe + '" data-watch="' + key + '">' + label + '</button>';
        let activity = '';
        if (act) {
          const parts = [];
          if (act.latestRelease) {
            const r = act.latestRelease;
            const pre = r.prerelease ? ' (Pre)' : '';
            parts.push('<span class="repo-act-item" title="Latest Release">🏷️ <a href="' + escapeHTML(r.url) + '" target="_blank">' + escapeHTML(r.tag) + '</a>' + escapeHTML(pre) + ' · ' + formatTimeAgo(r.date) + '</span>');
          }
          if (act.latestCommit) {
            const c = act.latestCommit;
            parts.push('<span class="repo-act-item" title="Latest Commit">📝 <a href="' + escapeHTML(c.url) + '" target="_blank">' + escapeHTML(c.sha) + '</a> ' + escapeHTML(truncate(c.message, 40)) + ' · ' + formatTimeAgo(c.date) + '</span>');
          }
          if (parts.length > 0) {
            activity = '<div class="repo-activity">' + parts.join('') + '</div>';
          }
        }
        return '<li class="repo-item' + (pinned ? ' pinned' : '') + '">' +
          '<div class="repo-row">' +
            '<input type="checkbox" class="repo-check" data-repo-check="' + safe + '" title="选择">' +
            '<button class="pin-btn' + (pinned ? ' pinned' : '') + '" data-pin="' + safe + '" title="' + (pinned ? '取消置顶' : '置顶') + '">' + (pinned ? '📌' : '⬆️') + '</button>' +
            '<span class="repo-name"><a href="https://github.com/' + safe + '" target="_blank">' + safe + '</a></span>' +
            '<span class="repo-toggles">' +
              mkBtn('releases', '🏷️ Release') +
              mkBtn('ignorePreRelease', '🚫 Pre') +
              mkBtn('commits', '📝 Commit') +
              mkBtn('actions', '⚡ Actions') +
              mkBtn('issues', '🆕 Issue') +
              mkBtn('prs', '🔀 PR') +
              mkBtn('forks', '🍴 Fork') +
              mkBtn('prReviews', '✅ PR Merge') +
            '</span>' +
            '<button class="btn btn-danger btn-sm" data-remove="' + safe + '">删除</button>' +
          '</div>' +
          activity +
        '</li>';
      }).join('');
      // Render pagination
      if (totalPages > 1) {
        let pagHtml = '<div class="pagination">';
        pagHtml += '<button ' + (_repoPage <= 1 ? 'disabled' : '') + ' onclick="goRepoPage(' + (_repoPage - 1) + ')">‹ 上一页</button>';
        for (let i = 1; i <= totalPages; i++) {
          pagHtml += '<button class="' + (i === _repoPage ? 'active' : '') + '" onclick="goRepoPage(' + i + ')">' + i + '</button>';
        }
        pagHtml += '<button ' + (_repoPage >= totalPages ? 'disabled' : '') + ' onclick="goRepoPage(' + (_repoPage + 1) + ')">下一页 ›</button>';
        pagHtml += '<span class="page-info">' + sorted.length + ' 个仓库，第 ' + _repoPage + '/' + totalPages + ' 页</span>';
        pagHtml += '</div>';
        list.innerHTML += pagHtml;
      } else {
        list.innerHTML += '<div class="pagination"><span class="page-info">' + sorted.length + ' 个仓库</span></div>';
      }
    }

    function goRepoPage(page) {
      _repoPage = page;
      loadRepos();
      // Scroll to repo list top
      document.getElementById('repo-list').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function onSortChange() {
      _sortField = document.getElementById('repo-sort-field').value;
      _sortAsc = document.getElementById('repo-sort-dir').value === 'asc';
      _sortPriority = document.getElementById('repo-sort-priority').value;
      localStorage.setItem('grw_sort_field', _sortField);
      localStorage.setItem('grw_sort_asc', _sortAsc ? 'asc' : 'desc');
      localStorage.setItem('grw_sort_priority', _sortPriority);
      _repoPage = 1;
      loadRepos();
    }

    function getCheckedRepos() {
      return Array.from(document.querySelectorAll('.repo-check:checked')).map(cb => cb.dataset.repoCheck);
    }

    function toggleSelectAll(checked) {
      document.querySelectorAll('.repo-check').forEach(cb => { cb.checked = checked; });
    }

    async function batchSetWatch(enabled) {
      const repos = getCheckedRepos();
      if (repos.length === 0) { showToast('请先勾选仓库', 'error'); return; }
      const key = document.getElementById('batch-watch-key').value;
      const body = { watch: {} };
      body.watch[key] = !!enabled;
      let ok = 0;
      for (const repo of repos) {
        try {
          await fetchAPI('/api/repos/' + encodeURIComponent(repo), { method: 'PUT', body: JSON.stringify(body) });
          ok++;
        } catch (e) { /* skip */ }
      }
      showToast('已更新 ' + ok + ' 个仓库');
      loadRepos();
    }

    async function batchDelete() {
      const repos = getCheckedRepos();
      if (repos.length === 0) { showToast('请先勾选仓库', 'error'); return; }
      if (!confirm('确定删除选中的 ' + repos.length + ' 个仓库？')) return;
      let ok = 0;
      for (const repo of repos) {
        try {
          await fetchAPI('/api/repos/' + encodeURIComponent(repo), { method: 'DELETE' });
          ok++;
        } catch (e) { /* skip */ }
      }
      showToast('已删除 ' + ok + ' 个仓库');
      loadRepos();
      loadStatus();
    }

    // ── Config export / import (never moves secrets) ──

    async function exportConfig() {
      try {
        const config = await fetchAPI('/api/config');
        // Never export secrets — tokens/URLs/password stay on the server
        ['telegramBotToken', 'telegramChatId', 'githubToken', 'notifyDiscord', 'notifySlack', 'notifyWebhook', 'updatedAt'].forEach(k => delete config[k]);
        const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'repo-watcher-config-' + new Date().toISOString().slice(0, 10) + '.json';
        a.click();
        URL.revokeObjectURL(a.href);
        showToast('配置已导出（不含密钥）');
      } catch (e) {
        showToast('导出失败: ' + e.message, 'error');
      }
    }

    function triggerImport() {
      document.getElementById('import-file').click();
    }

    async function importConfig(input) {
      const file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        // Never write masked placeholders to the server
        Object.keys(data).forEach(k => {
          if (typeof data[k] === 'string' && data[k].includes('••••')) delete data[k];
        });
        delete data.updatedAt;
        await fetchAPI('/api/config', { method: 'POST', body: JSON.stringify(data) });
        showToast('配置已导入');
        loadConfig();
        loadRepos();
        loadStatus();
      } catch (e) {
        showToast('导入失败: ' + e.message, 'error');
      }
    }

    async function togglePin(repo) {
      try {
        const repos = await fetchAPI('/api/repos');
        const entry = repos.repos.find(r => (typeof r === 'string' ? r : r.repo) === repo);
        const currentPinned = entry && typeof entry === 'object' ? !!entry.pinned : false;
        await fetchAPI('/api/repos/' + encodeURIComponent(repo), { method: 'PUT', body: JSON.stringify({ pinned: !currentPinned }) });
        loadRepos();
      } catch (e) { showToast('操作失败: ' + e.message, 'error'); }
    }

    document.addEventListener('click', e => {
      const rmBtn = e.target.closest('[data-remove]');
      if (rmBtn) return removeRepo(rmBtn.dataset.remove);
      const pinBtn = e.target.closest('[data-pin]');
      if (pinBtn) return togglePin(pinBtn.dataset.pin);
      const tglBtn = e.target.closest('.toggle-btn[data-repo]');
      if (tglBtn) return toggleRepoWatch(tglBtn.dataset.repo, tglBtn.dataset.watch, tglBtn);
    });

    async function toggleRepoWatch(repo, key, btn) {
      const isOn = btn.classList.contains('on');
      const patch = {}; patch[key] = !isOn;
      try {
        await fetchAPI('/api/repos/' + encodeURIComponent(repo), { method: 'PUT', body: JSON.stringify({ watch: patch }) });
        btn.classList.toggle('on');
      } catch (e) { showToast('更新失败: ' + e.message, 'error'); }
    }

    async function addRepo() {
      const input = document.getElementById('new-repo');
      const repo = input.value.trim();
      if (!repo || !repo.includes('/')) {
        showToast('请输入正确的仓库格式，如 owner/repo', 'error');
        return;
      }
      const watch = {
        releases: document.getElementById('opt-releases').checked,
        ignorePreRelease: document.getElementById('opt-ignore-pre').checked,
        commits: document.getElementById('opt-commits').checked,
        actions: document.getElementById('opt-actions').checked,
        issues: document.getElementById('opt-issues').checked,
        prs: document.getElementById('opt-prs').checked,
        forks: document.getElementById('opt-forks').checked,
        prReviews: document.getElementById('opt-pr-reviews').checked,
      };
      setBtnLoading('btn-add-repo', true);
      try {
        const data = await fetchAPI('/api/repos', { method: 'POST', body: JSON.stringify({ repo, watch }) });
        input.value = '';
        if (data.added === false) {
          showToast('该仓库已在监控列表中');
        } else {
          showToast('仓库已添加');
        }
        loadRepos();
        loadStatus();
      } catch (e) {
        showToast('添加失败: ' + e.message, 'error');
      } finally {
        setBtnLoading('btn-add-repo', false);
      }
    }

    async function removeRepo(repo) {
      if (!confirm('确定要移除 ' + repo + ' 吗？此操作不可撤销。')) return;
      try {
        const data = await fetchAPI('/api/repos/' + encodeURIComponent(repo), { method: 'DELETE' });
        if (data.removed === false) {
          showToast('未找到该仓库');
        } else {
          showToast('仓库已移除');
        }
        loadRepos();
        loadStatus();
      } catch (e) {
        showToast('移除失败: ' + e.message, 'error');
      }
    }

    let _historyFilter = 'all';
    let _historyType = 'all';
    let _historySearch = '';
    let _historyShown = 30;
    let _historyCache = [];

    function setHistoryFilter(days) {
      _historyFilter = days;
      _historyShown = 30;
      renderHistory();
    }

    function onHistoryFilterChange() {
      _historyType = document.getElementById('history-type').value;
      _historySearch = document.getElementById('history-search').value.trim().toLowerCase();
      _historyShown = 30;
      renderHistory();
    }

    function loadMoreHistory() {
      _historyShown += 30;
      renderHistory();
    }

    async function loadHistory() {
      try {
        const { history } = await fetchAPI('/api/history?limit=200');
        _historyCache = history || [];
      } catch (e) {
        return;
      }
      renderHistory();
    }

    function renderHistory() {
      const list = document.getElementById('history-list');
      const moreBtn = document.getElementById('btn-history-more');
      // Time / type / search filters
      let filtered = _historyCache;
      if (_historyFilter !== 'all') {
        const cutoff = Date.now() - _historyFilter * 24 * 60 * 60 * 1000;
        filtered = filtered.filter(h => new Date(h.timestamp).getTime() > cutoff);
      }
      if (_historyType !== 'all') {
        filtered = filtered.filter(h => h.type === _historyType || (_historyType === 'commit' && h.type === 'commits'));
      }
      if (_historySearch) {
        filtered = filtered.filter(h => {
          const hay = [h.repo, h.name, h.tag, h.title, h.message, h.keyword, h.sha].filter(Boolean).join(' ').toLowerCase();
          return hay.includes(_historySearch);
        });
      }
      if (filtered.length === 0) {
        list.innerHTML = '<div class="empty-state">暂无匹配记录</div>';
        if (moreBtn) moreBtn.style.display = 'none';
        return;
      }
      if (moreBtn) moreBtn.style.display = filtered.length > _historyShown ? '' : 'none';
      list.innerHTML = filtered.slice(0, _historyShown).map(h => {
        const repo = escapeHTML(h.repo || '');
        const name = escapeHTML(h.name || h.tag || '');
        const sha = escapeHTML(h.sha || '');
        const msg = escapeHTML(h.message || '');
        let content = '';
        if (h.type === 'release') {
          content = '🏷️ <b>新版本发布</b> ' + repo + ' - ' + name;
        } else if (h.type === 'commit') {
          content = '📝 <b>新提交</b> ' + repo + ' - <code>' + sha + '</code> ' + msg;
        } else if (h.type === 'commits') {
          content = '📝 <b>' + escapeHTML(String(h.count)) + ' 个新提交</b> ' + repo;
        } else if (h.type === 'action') {
          const concl = h.conclusion === 'success' ? '✅' : h.conclusion === 'failure' ? '❌' : '⚠️';
          content = concl + ' <b>Actions</b> ' + repo + ' - ' + escapeHTML(h.name || '');
        } else if (h.type === 'issue') {
          content = '🆕 <b>New Issue</b> ' + repo + ' #' + escapeHTML(String(h.number || '')) + ' ' + escapeHTML(h.title || '');
        } else if (h.type === 'pr') {
          content = '🔀 <b>New PR</b> ' + repo + ' #' + escapeHTML(String(h.number || '')) + ' ' + escapeHTML(h.title || '');
        } else if (h.type === 'keyword') {
          content = '🔔 <b>关键词告警</b> ' + repo + ' <code>' + escapeHTML(h.keyword || '') + '</code> ' + escapeHTML(h.sha || '');
        } else if (h.type === 'star_milestone') {
          const ms = (h.milestones || []).map(m => m.toLocaleString()).join(', ');
          content = '⭐ <b>Star 里程碑</b> ' + repo + ' ' + escapeHTML(String(h.stars || '')) + ' ⭐ (' + escapeHTML(ms) + ')';
        } else if (h.type === 'fork') {
          content = '🍴 <b>Fork 变更</b> ' + repo + ' ' + escapeHTML(String(h.forks || '')) + ' (+' + escapeHTML(String(h.diff || '')) + ')';
        } else if (h.type === 'pr_merge') {
          content = '✅ <b>PR 已合并</b> ' + repo + ' #' + escapeHTML(String(h.number || '')) + ' ' + escapeHTML(h.title || '');
        } else if (h.type === 'error') {
          content = '❌ <b>错误</b> ' + repo + ': ' + msg;
        }
        return '<div class="history-item ' + escapeHTML(h.type || '') + '">' + content +
               '<div class="history-meta">' + new Date(h.timestamp).toLocaleString('zh-CN') + '</div></div>';
      }).join('');
    }

    async function clearHistory() {
      if (!confirm('确定要清空所有通知历史吗？')) return;
      setBtnLoading('btn-clear-history', true);
      try {
        await fetchAPI('/api/history', { method: 'DELETE' });
        showToast('历史已清空');
        loadHistory();
      } catch (e) {
        showToast('清空失败: ' + e.message, 'error');
      } finally {
        setBtnLoading('btn-clear-history', false);
      }
    }

    async function checkNow() {
      setBtnLoading('btn-check-now', true);
      try {
        const result = await fetchAPI('/api/check', { method: 'POST' });
        showToast('检查完成：' + result.notifications + ' 条新通知');
        loadHistory();
        loadStatus();
      } catch (e) {
        showToast('检查失败: ' + e.message, 'error');
      } finally {
        setBtnLoading('btn-check-now', false);
      }
    }

    async function testTelegram() {
      setBtnLoading('btn-test-tg', true);
      try {
        await fetchAPI('/api/test-telegram', { method: 'POST' });
        showToast('测试消息已发送，请查看 Telegram');
      } catch (e) {
        showToast('测试失败: ' + e.message, 'error');
      } finally {
        setBtnLoading('btn-test-tg', false);
      }
    }

    // Enter key support
    document.getElementById('new-repo').addEventListener('keypress', e => {
      if (e.key === 'Enter') addRepo();
    });

    // Starred repos modal
    async function showStarredModal() {
      const modal = document.getElementById('starred-modal');
      modal.style.display = 'flex';
      const list = document.getElementById('starred-list');
      list.innerHTML = '<div class="empty-state">加载中...</div>';
      try {
        const data = await fetchAPI('/api/github/starred');
        if (data.starred.length === 0) {
          list.innerHTML = '<div class="empty-state">未找到 Starred 仓库（需要配置 GitHub Token）</div>';
          return;
        }
        window._starredData = data.starred;
        renderStarredList('');
      } catch (e) {
        list.innerHTML = '<div class="empty-state">加载失败: ' + escapeHTML(e.message) + '</div>';
      }
    }

    function renderStarredList(filter) {
      const data = (window._starredData || []).filter(r => !filter || r.repo.toLowerCase().includes(filter.toLowerCase()) || (r.description || '').toLowerCase().includes(filter.toLowerCase()));
      const list = document.getElementById('starred-list');
      list.innerHTML = '<input class="starred-search" placeholder="搜索仓库..." oninput="renderStarredList(this.value)">' +
        data.map(r => {
          const checked = r.alreadyWatching ? 'checked disabled' : '';
          const cls = r.alreadyWatching ? 'starred-item already' : 'starred-item';
          return '<div class="' + cls + '" data-repo="' + escapeHTML(r.repo) + '">' +
            '<input type="checkbox" ' + checked + ' onchange="updateStarredCount()">' +
            '<div class="starred-info">' +
              '<div class="name">' + escapeHTML(r.repo) + (r.alreadyWatching ? ' ✅ 已添加' : '') + '</div>' +
              (r.description ? '<div class="desc">' + escapeHTML(r.description) + '</div>' : '') +
              '<div class="meta"><span>⭐ ' + r.stars + '</span>' + (r.language ? '<span>🔤 ' + escapeHTML(r.language) + '</span>' : '') + '</div>' +
            '</div>' +
          '</div>';
        }).join('');
      updateStarredCount();
    }

    function updateStarredCount() {
      const count = document.querySelectorAll('#starred-list .starred-item input:checked').length;
      document.getElementById('starred-count').textContent = '已选 ' + count + ' 个';
    }

    document.addEventListener('click', e => {
      const item = e.target.closest('.starred-item:not(.already)');
      if (item && !e.target.matches('input')) {
        const cb = item.querySelector('input[type="checkbox"]');
        cb.checked = !cb.checked;
        item.classList.toggle('selected', cb.checked);
        updateStarredCount();
      }
    });

    function closeStarredModal() {
      document.getElementById('starred-modal').style.display = 'none';
    }

    async function addStarredRepos() {
      const checked = document.querySelectorAll('#starred-list .starred-item input:checked');
      if (checked.length === 0) { showToast('请先选择仓库', 'error'); return; }
      const watch = {
        releases: document.getElementById('opt-releases').checked,
        ignorePreRelease: document.getElementById('opt-ignore-pre').checked,
        commits: document.getElementById('opt-commits').checked,
        actions: document.getElementById('opt-actions').checked,
        issues: document.getElementById('opt-issues').checked,
        prs: document.getElementById('opt-prs').checked,
        forks: document.getElementById('opt-forks').checked,
        prReviews: document.getElementById('opt-pr-reviews').checked,
      };
      setBtnLoading('btn-add-starred', true);
      let added = 0;
      for (const cb of checked) {
        const repo = cb.closest('.starred-item').dataset.repo;
        try {
          await fetchAPI('/api/repos', { method: 'POST', body: JSON.stringify({ repo, watch }) });
          added++;
        } catch (e) { /* skip */ }
      }
      setBtnLoading('btn-add-starred', false);
      closeStarredModal();
      showToast('已添加 ' + added + ' 个仓库');
      loadRepos();
      loadStatus();
    }


    // Filter save
    async function saveFilters() {
      setBtnLoading('btn-save-filters', true);
      try {
        const body = {
          filters: {
            ignorePreRelease: document.getElementById('filter-ignore-pre').checked,
            actionsOnlyFailures: document.getElementById('filter-actions-fail').checked,
            ignoreAuthors: document.getElementById('filter-ignore-authors').value.split(',').map(s => s.trim()).filter(Boolean),
            ignoreLabels: document.getElementById('filter-ignore-labels').value.split(',').map(s => s.trim()).filter(Boolean),
            tagKeyword: document.getElementById('filter-tag-keyword').value.trim(),
            commitKeyword: document.getElementById('filter-commit-keyword').value.trim(),
          }
        };
        await fetchAPI('/api/config', { method: 'POST', body: JSON.stringify(body) });
        showToast('过滤规则已保存');
      } catch (e) {
        showToast('保存失败: ' + e.message, 'error');
      } finally {
        setBtnLoading('btn-save-filters', false);
      }
    }

    // Keyword alerts
    function renderKeywordAlerts(alerts) {
      const list = document.getElementById('keyword-list');
      if (!alerts || alerts.length === 0) {
        list.innerHTML = '<li class="empty-state">暂无告警规则</li>';
        return;
      }
      list.innerHTML = alerts.map((a, i) =>
        '<li class="keyword-item">' +
          '<span class="repo-tag">' + escapeHTML(a.repo || '*') + '</span>' +
          '<span class="kw">' + escapeHTML(a.keyword) + '</span>' +
          '<button class="btn btn-danger btn-sm" onclick="removeKeywordAlert(' + i + ')" style="margin-left:auto">删除</button>' +
        '</li>'
      ).join('');
    }

    async function addKeywordAlert() {
      const repo = document.getElementById('kw-repo').value.trim() || '*';
      const keyword = document.getElementById('kw-keyword').value.trim();
      if (!keyword) { showToast('请输入关键词', 'error'); return; }
      try {
        const config = await fetchAPI('/api/config');
        const alerts = config.keywordAlerts || [];
        alerts.push({ repo, keyword });
        await fetchAPI('/api/config', { method: 'POST', body: JSON.stringify({ keywordAlerts: alerts }) });
        document.getElementById('kw-repo').value = '';
        document.getElementById('kw-keyword').value = '';
        renderKeywordAlerts(alerts);
        showToast('告警规则已添加');
      } catch (e) { showToast('添加失败: ' + e.message, 'error'); }
    }

    async function removeKeywordAlert(index) {
      try {
        const config = await fetchAPI('/api/config');
        const alerts = config.keywordAlerts || [];
        alerts.splice(index, 1);
        await fetchAPI('/api/config', { method: 'POST', body: JSON.stringify({ keywordAlerts: alerts }) });
        renderKeywordAlerts(alerts);
        showToast('已删除');
      } catch (e) { showToast('删除失败: ' + e.message, 'error'); }
    }

    let _starsSort = 'stars-desc';

    function renderStarsChart(sorted) {
      // Pure-SVG multi-series line chart (no dependencies)
      const series = sorted.filter(s => s.history && s.history.length >= 2).slice(0, 6);
      if (series.length === 0) return '';
      const W = 720, H = 240, PL = 56, PR = 12, PT = 16, PB = 32;
      const colors = ['#00d9ff', '#00ff88', '#ffb020', '#ff6b6b', '#b388ff', '#ff80ab'];
      const maxLen = Math.max(...series.map(s => s.history.length));
      let vMin = Infinity, vMax = -Infinity;
      series.forEach(s => s.history.forEach(p => {
        if (p.stars < vMin) vMin = p.stars;
        if (p.stars > vMax) vMax = p.stars;
      }));
      if (vMin === vMax) { vMin = Math.max(0, vMin - 1); vMax += 1; }
      const x = i => PL + (maxLen <= 1 ? 0 : i / (maxLen - 1)) * (W - PL - PR);
      const y = v => PT + (1 - (v - vMin) / (vMax - vMin)) * (H - PT - PB);
      let svg = '<svg class="stars-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Stars 趋势图">';
      // Grid + y labels
      for (let g = 0; g <= 4; g++) {
        const gv = vMin + (vMax - vMin) * g / 4;
        const gy = y(gv);
        svg += '<line x1="' + PL + '" y1="' + gy + '" x2="' + (W - PR) + '" y2="' + gy + '" stroke="currentColor" stroke-opacity="0.12" />';
        svg += '<text x="' + (PL - 8) + '" y="' + (gy + 4) + '" text-anchor="end" font-size="11" fill="currentColor" fill-opacity="0.5">' + Math.round(gv).toLocaleString() + '</text>';
      }
      // Lines
      series.forEach((s, si) => {
        const pts = s.history.map((p, i) => x(i) + ',' + y(p.stars)).join(' ');
        svg += '<polyline points="' + pts + '" fill="none" stroke="' + colors[si % colors.length] + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />';
        const last = s.history[s.history.length - 1];
        svg += '<circle cx="' + x(s.history.length - 1) + '" cy="' + y(last.stars) + '" r="3.5" fill="' + colors[si % colors.length] + '" />';
      });
      // X labels: first / mid / last date of the longest series
      const longest = series.reduce((a, b) => a.history.length >= b.history.length ? a : b);
      [0, Math.floor((longest.history.length - 1) / 2), longest.history.length - 1].forEach(i => {
        const d = longest.history[i] && longest.history[i].date ? longest.history[i].date.slice(5) : '';
        svg += '<text x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="11" fill="currentColor" fill-opacity="0.5">' + d + '</text>';
      });
      svg += '</svg>';
      const legend = '<div class="stars-legend">' + series.map((s, si) =>
        '<span class="stars-legend-item"><span class="stars-legend-dot" style="background:' + colors[si % colors.length] + '"></span>' + escapeHTML(s.repo) + ' · ⭐' + s.stars.toLocaleString() + '</span>'
      ).join('') + '</div>';
      return svg + legend;
    }

    async function loadStars() {
      try {
        const { stars } = await fetchAPI('/api/stars/history');
        const container = document.getElementById('stars-chart');
        if (!stars || stars.length === 0) {
          container.innerHTML = '<div class="empty-state">暂无数据</div>';
          return;
        }
        // Sort stars
        const sorted = stars.slice().sort((a, b) => {
          const da = a.history.length >= 2 ? a.stars - a.history[0].stars : 0;
          const db = b.history.length >= 2 ? b.stars - b.history[0].stars : 0;
          if (_starsSort === 'stars-desc') return b.stars - a.stars;
          if (_starsSort === 'stars-asc') return a.stars - b.stars;
          if (_starsSort === 'delta-desc') return db - da;
          if (_starsSort === 'delta-asc') return da - db;
          if (_starsSort === 'name') return a.repo.localeCompare(b.repo);
          return 0;
        });
        container.innerHTML = renderStarsChart(sorted) + sorted.map(s => {
          const delta = s.history.length >= 2 ? s.stars - s.history[0].stars : 0;
          const deltaStr = delta > 0 ? '+' + delta : delta < 0 ? String(delta) : '';
          return '<div class="stars-row">' +
            '<span class="repo-name"><a href="https://github.com/' + escapeHTML(s.repo) + '" target="_blank">' + escapeHTML(s.repo) + '</a></span>' +
            '<span class="stars-count">⭐ ' + s.stars.toLocaleString() + '</span>' +
            (deltaStr ? '<span class="stars-delta">(' + deltaStr + ')</span>' : '') +
          '</div>';
        }).join('');
      } catch (e) {
        document.getElementById('stars-chart').innerHTML = '<div class="empty-state">加载失败</div>';
      }
    }


    // Notification settings save
    async function saveNotifySettings() {
      setBtnLoading('btn-save-notify-settings', true);
      try {
        const milestonesStr = document.getElementById('star-milestones').value.trim();
        const milestones = milestonesStr ? milestonesStr.split(',').map(s => parseInt(s.trim(), 10)).filter(n => n > 0) : [];
        const body = {
          starMilestones: milestones,
          weeklySummary: document.getElementById('weekly-summary').checked,
        };
        await fetchAPI('/api/config', { method: 'POST', body: JSON.stringify(body) });
        showToast('通知设置已保存');
      } catch (e) {
        showToast('保存失败: ' + e.message, 'error');
      } finally {
        setBtnLoading('btn-save-notify-settings', false);
      }
    }

    let _compareSort = 'stars-desc';
    async function loadCompare() {
      try {
        const { repos } = await fetchAPI('/api/repos/compare');
        const container = document.getElementById('compare-table');
        if (!repos || repos.length === 0) {
          container.innerHTML = '<div class="empty-state">暂无监控仓库</div>';
          return;
        }
        // Sort
        const sorted = repos.slice().sort((a, b) => {
          if (_compareSort === 'stars-desc') return b.stars - a.stars;
          if (_compareSort === 'stars-asc') return a.stars - b.stars;
          if (_compareSort === 'forks-desc') return b.forks - a.forks;
          if (_compareSort === 'forks-asc') return a.forks - b.forks;
          if (_compareSort === 'issues-desc') return b.openIssues - a.openIssues;
          if (_compareSort === 'issues-asc') return a.openIssues - b.openIssues;
          if (_compareSort === 'name') return a.repo.localeCompare(b.repo);
          return 0;
        });
        // Only rebuild sort dropdown if it doesn't exist yet
        if (!document.getElementById('compare-sort')) {
          container.innerHTML = '<div class="sort-bar" style="margin-bottom:8px"><label>排序：</label>' +
            '<select id="compare-sort" onchange="_compareSort=this.value;loadCompare()" style="padding:6px 10px;background:var(--input-bg);border:1px solid var(--input-border);border-radius:8px;color:var(--text-primary);font-size:13px">' +
            '<option value="stars-desc">Stars ↓</option><option value="stars-asc">Stars ↑</option>' +
            '<option value="forks-desc">Forks ↓</option><option value="forks-asc">Forks ↑</option>' +
            '<option value="issues-desc">Issues ↓</option><option value="issues-asc">Issues ↑</option>' +
            '<option value="name">名称</option></select></div>' +
            '<div id="compare-table-body"></div>';
        }
        document.getElementById('compare-sort').value = _compareSort;
        document.getElementById('compare-table-body').innerHTML =
          '<table class="compare-table"><thead><tr>' +
          '<th>仓库</th><th>⭐ Stars</th><th>🍴 Forks</th><th>📋 Issues</th><th>👁 Watchers</th><th>🔤 语言</th>' +
          '</tr></thead><tbody>' +
          sorted.map(r =>
            '<tr><td><a href="https://github.com/' + escapeHTML(r.repo) + '" target="_blank">' + escapeHTML(r.repo) + '</a></td>' +
            '<td>' + r.stars.toLocaleString() + '</td>' +
            '<td>' + r.forks.toLocaleString() + '</td>' +
            '<td>' + r.openIssues.toLocaleString() + '</td>' +
            '<td>' + r.watchers.toLocaleString() + '</td>' +
            '<td>' + escapeHTML(r.language || '-') + '</td></tr>'
          ).join('') + '</tbody></table>';
      } catch (e) {
        document.getElementById('compare-table').innerHTML = '<div class="empty-state">加载失败</div>';
      }
    }

    // Weekly summary
    async function loadSummary() {
      try {
        const data = await fetchAPI('/api/summary');
        const container = document.getElementById('summary-content');
        const repos = Object.keys(data.summary);
        if (repos.length === 0) {
          container.innerHTML = '<div class="empty-state">本周暂无活动记录</div>';
          return;
        }
        container.innerHTML = '<p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">本周共 ' + data.totalEvents + ' 条事件</p>' +
          '<div class="summary-grid">' + repos.map(repo => {
            const s = data.summary[repo];
            const items = [];
            if (s.releases) items.push(['🏷️ Releases', s.releases]);
            if (s.commits) items.push(['📝 Commits', s.commits]);
            if (s.actions) items.push(['⚡ Actions', s.actions]);
            if (s.issues) items.push(['🆕 Issues', s.issues]);
            if (s.prs) items.push(['🔀 PRs', s.prs]);
            if (s.prMerges) items.push(['✅ Merges', s.prMerges]);
            if (s.forks) items.push(['🍴 Forks', s.forks]);
            if (s.starMilestones) items.push(['⭐ Star 里程碑', s.starMilestones]);
            if (s.keywordAlerts) items.push(['🔔 关键词告警', s.keywordAlerts]);
            return '<div class="summary-card"><h3>' + escapeHTML(repo) + '</h3>' +
              items.map(([l, v]) => '<div class="summary-stat"><span class="label">' + l + '</span><span class="value">' + v + '</span></div>').join('') +
              '</div>';
          }).join('') + '</div>';
      } catch (e) {
        document.getElementById('summary-content').innerHTML = '<div class="empty-state">加载失败</div>';
      }
    }
    // ── Auto refresh (paused while the tab is hidden) ──

    let _refreshTimer = null;
    function startAutoRefresh() {
      if (_refreshTimer) clearInterval(_refreshTimer);
      _refreshTimer = setInterval(() => {
        if (document.hidden) return;
        Promise.all([loadStatus(), loadHistory()]).catch(() => {});
      }, 60000);
    }
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        Promise.all([loadStatus(), loadHistory()]).catch(() => {});
      }
    });

    // Init
    async function initApp() {
      await Promise.all([loadStatus(), loadConfig(), loadRepos(), loadHistory(), loadCompare(), loadSummary(), loadStars()]);
      startAutoRefresh();
    }

    (async function init() {
      // Check if password is required
      try {
        const r = await fetch(API + '/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(authToken ? { token: authToken } : { password: '' }),
        });
        const data = await r.json();
        if (data.authenticated) {
          showApp();
          initApp();
        } else {
          showLogin();
        }
      } catch (e) {
        // Fail closed: don't render the dashboard when the auth check itself failed
        showLogin();
      }
    })();
  </script>
</body>
</html>`;
}
