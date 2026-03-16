# Cloudflare 公用邮件接收平台

本项目包含两部分：

- Cloudflare Worker：接收 Email Routing 邮件、存储到 R2/KV、后台管理 API、预览访问 API、定时清理。
- Cloudflare Pages：预览页与管理后台。

## 功能覆盖

- 收件写入：邮件正文写入 R2，索引和配置写入 KV。
- 附件处理：解析 MIME 后仅保存 text/html/header，丢弃全部附件。
- 自动清理：通过 Cron 触发器按邮箱策略删除过期邮件，并强制执行最大封数。
- 预览访问控制：路径 + 访问码双校验，不符合则拒绝。
- 路径与访问码：后台自动生成，支持手动刷新；刷新时同步刷新路径和访问码。
- 管理后台：
  - 管理员认证（部署时注入密钥）。
  - 调用 Cloudflare 邮件路由 API 注册邮箱接收规则。
  - 配置每个邮箱的自动删除时间（小时）与最大存储封数。
  - 一键复制分享地址。
- 安全：预览页和后台都接入 Cloudflare Turnstile。

## 目录结构

- `src/worker.ts` Worker 入口
- `pages/preview.html` 预览页
- `pages/admin.html` 后台页
- `pages/preview.js` 预览逻辑
- `pages/admin.js` 后台逻辑
- `pages/config.js` 前端 API 地址配置
- `wrangler.toml` Worker 配置

## 1) 准备资源

1. 创建 KV Namespace（例如 `cfmail-kv`）
2. 创建 R2 Bucket（例如 `cfmail-mailbox`）
3. 创建 Turnstile Site Key + Secret
4. 开启域名 Email Routing，并确保允许 Worker 处理邮件

## 2) 配置 `wrangler.toml`

更新以下值：

- `kv_namespaces.id`
- `r2_buckets.bucket_name`
- `[vars].API_BASE_URL`
- `[vars].PAGES_BASE_URL`
- `[vars].FRONTEND_ORIGIN`
- `[vars].TURNSTILE_SITE_KEY`

## 3) 设置 Worker Secrets

```bash
wrangler secret put ADMIN_SECRET
wrangler secret put SESSION_SIGNING_KEY
wrangler secret put TURNSTILE_SECRET
wrangler secret put CF_API_TOKEN
wrangler secret put CF_ACCOUNT_ID
wrangler secret put CF_ZONE_ID
```

可选：

```bash
wrangler secret put WORKER_NAME
```

说明：

- `CF_API_TOKEN` 需要至少具备 Zone Email Routing 编辑权限。
- `ADMIN_SECRET` 是后台登录密钥。
- `SESSION_SIGNING_KEY` 用于签名后台和预览会话 token。

## 4) 安装并部署

```bash
npm install
npm run deploy:worker
```

编辑 `pages/config.js` 的 `apiBaseUrl` 为 Worker 实际地址后，部署 Pages：

```bash
npm run deploy:pages
```

## 5) 使用流程

1. 打开 `/admin`，输入管理员密钥并完成 Turnstile。
2. 新建邮箱地址。
3. 后台自动生成：
   - 预览路径（16 位数字+大小写字母）
   - 访问码（8 位强密码）
4. 复制分享地址给访问者。
5. 访问者打开 `/p/{path}`，可从 URL `?code=` 自动读取访问码，或手动输入访问码。
6. 验证成功后查看邮件列表和详情。

## 注意事项

- Cloudflare Email Routing API 字段在不同版本可能有微调，若你账号返回字段不一致，请按错误信息调整 `src/worker.ts` 中 `upsertCloudflareEmailRoute` 的请求体。
- 当前未实现附件下载，设计上统一丢弃附件。
- 预览 token 默认 12 小时过期，可在 `src/worker.ts` 调整。
