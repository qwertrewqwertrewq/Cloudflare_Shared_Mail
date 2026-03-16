# Cloudflare_Shared_Mail

仓库地址：`https://github.com/qwertrewqwertrewq/Cloudflare_Shared_Mail.git`

用于搭建公用邮件接收平台：

- Worker 负责收件、存储、清理、权限校验、后台 API。
- Pages 托管 Vue3 + Element Plus 前端（验证页、列表页、后台页）。

## 功能概览

- 邮件接收：Cloudflare Email Routing -> Worker。
- 存储：正文/元数据落 R2 + KV。
- 附件策略：全部丢弃，不落盘。
- 访问控制：路径 + 访问码双校验。
- 后台能力：
  - 管理员登录（密钥 + Turnstile）
  - 新增邮箱并自动创建 Email Routing 规则
  - 刷新路径和访问码
  - 配置自动删除时间、最大封数
  - 复制带 code 的分享地址
- 自动清理：Cron 定时删除过期邮件并执行容量上限。

## 当前工程结构

- `src/worker.ts` Worker 入口。
- `frontend/` Vue3 工程（Vite + Vue Router + Element Plus）。
- `frontend/src/views/VerifyView.vue` 验证页。
- `frontend/src/views/ListView.vue` 列表/预览页。
- `frontend/src/views/AdminView.vue` 后台页。
- `wrangler.toml` Worker 配置模板。

---

## 一、Fork 本仓库并拉取到本地

1. 在 GitHub 页面点击 Fork。
2. 克隆你自己的仓库：

```bash
git clone https://github.com/qwertrewqwertrewq/Cloudflare_Shared_Mail.git
cd Cloudflare_Shared_Mail
```

3. 安装依赖：

```bash
npm install
npm --prefix frontend install
```

---

## 二、准备 Cloudflare 资源

需要同一个 Cloudflare 账号下的以下资源：

1. 一个可用 Zone（例如 `example.com`）
2. Email Routing 已开启
3. KV Namespace（用于索引和配置）
4. R2 Bucket（用于邮件内容）
5. Turnstile Site Key + Secret
6. Pages 项目（例如 `cfmail-pages`）

可用 Wrangler 创建（示例）：

```bash
npx wrangler login
npx wrangler kv namespace create cfmail-kv
npx wrangler r2 bucket create cfmail-mailbox
npx wrangler pages project create cfmail-pages --production-branch main
```

---

## 三、修改配置

编辑 `wrangler.toml`：

1. `[[kv_namespaces]].id` 改成你的 KV ID
2. `[[r2_buckets]].bucket_name` 改成你的 R2 Bucket 名
3. `[vars].API_BASE_URL` 改成 Worker 地址
4. `[vars].PAGES_BASE_URL` 改成 Pages/自定义域名
5. `[vars].FRONTEND_ORIGIN` 改成前端域名
6. `[vars].TURNSTILE_SITE_KEY` 改成 Turnstile Site Key

编辑 `frontend/public/runtime-config.js`：

1. `apiBaseUrl` 改成 Worker 地址

---

## 四、连接 Cloudflare（Secrets 与权限）

### 1) 写入 Worker Secrets

```bash
npx wrangler secret put ADMIN_SECRET
npx wrangler secret put SESSION_SIGNING_KEY
npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put CF_ZONE_ID
```

可选：

```bash
npx wrangler secret put WORKER_NAME
```

### 2) CF_API_TOKEN 最低建议权限

对目标 Zone（不是 All zones）授权：

- Email Routing Rules: Edit
- Email Routing Rules: Read
- Zone: Read

如果你启用了 `GET /zones/{zone_id}/email/routing` 强检查，再额外给：

- Zone Settings: Read
- DNS Settings: Read

---

## 五、Build 与部署

### 1) 部署 Worker

```bash
npm run deploy:worker
```

### 2) 构建并部署 Vue 前端到 Pages

```bash
npm run deploy:pages
```

该命令会自动执行：

1. `npm --prefix frontend run build`
2. `wrangler pages deploy frontend/dist --project-name cfmail-pages`

---

## 六、访问与使用

1. 管理后台：`/admin`
2. 验证页：`/verify/:path`
3. 列表页：`/list/:path?code=xxxx`
4. 兼容分享：`/p/:path`（自动跳转到 `/list/:path`）

推荐流程：

1. 进后台登录
2. 新建邮箱
3. 复制后台生成的带 code 分享链接
4. 用户访问后完成验证并查看邮件

---

## 常见问题

### 1) Email Routing API 返回 Authentication error

先验证 token：

```bash
curl -sS -H "Authorization: Bearer <token>" https://api.cloudflare.com/client/v4/user/tokens/verify
```

再检查 token 是否包含上述 Zone 权限，且作用域是目标 Zone。

### 2) 前端页面不更新

先确认 `npm run deploy:pages` 成功，再强制刷新浏览器缓存。

### 3) 访问 `/admin` 被重定向

检查 Cloudflare Redirect Rules / Page Rules 是否有 `/admin -> /` 规则。
