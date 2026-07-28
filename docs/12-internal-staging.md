# 12 · 免费内部测试环境

> 目标：优先使用 Supabase Free、Cloudflare Workers/Tunnel 与 Vercel，在不改写 NestJS BFF 的前提下验证核心功能。本方案不是生产架构；本机必须在线，Cloudflare Quick Tunnel 无 SLA。

## 1. 拓扑

```text
Vercel Web
    │ HTTPS
    ▼
Cloudflare Worker（固定 workers.dev URL、签名告警接收）
    │ HTTPS
    ▼
Cloudflare Quick Tunnel（随机 trycloudflare.com URL）
    │
    ▼
本机 BFF :3001 ── 本机 Redis :6379
    │
    └── Supabase Free（PostgreSQL / Auth / Storage）
```

Cloudflare Worker 为 Web 和平台 OAuth 提供稳定入口；每次 Quick Tunnel 地址变化时，只更新 Worker 的 `BFF_ORIGIN` Secret，不需要重新构建 Web。BFF 的租户 API 仍由 Supabase JWT 保护，运维 API 仍由独立 `OPERATIONS_TOKEN` 保护。

## 2. 发布代码版本

从门禁通过的独立分支部署。提交和推送前至少执行：

```bash
pnpm lint
pnpm typecheck
pnpm exec turbo run test --force -- --api.host=127.0.0.1
pnpm exec turbo run build --force
pnpm --filter @supplier/db exec prisma validate
pnpm exec prettier --check "**/*.{ts,tsx,md,json,yml,yaml}"
git diff --check
node --test deploy/cloudflare/staging-gateway/worker.test.mjs
```

受限执行环境如果不允许 Vitest 监听本机临时端口，应在可信本机或 CI 中执行同一测试命令，不能把 `EPERM` 当作代码失败，也不能用缓存结果替代重跑。

## 3. 创建 Supabase staging

1. 新建 `supplier-staging` 免费项目，优先选择 Singapore 区域。
2. 保存 Project URL、Anon Key、Service Role Key、数据库密码、Pooler URL 和 Direct URL；不要放入 Git、聊天或日志。
3. 从模板创建本地文件 `packages/db/.env.staging.local`，权限设为仅当前用户可读写。
4. 使用 Node 22 的环境文件参数执行全部 migration：

```bash
node --env-file=packages/db/.env.staging.local \
  packages/db/node_modules/prisma/build/index.js migrate deploy \
  --schema packages/db/prisma/schema.prisma

node --env-file=packages/db/.env.staging.local \
  packages/db/node_modules/prisma/build/index.js migrate status \
  --schema packages/db/prisma/schema.prisma
```

5. 在 Storage 创建公开读取的 `supplier-assets` Bucket。
6. Auth 暂时关闭公开注册；Vercel URL 确定后再配置 Site URL、Redirect URLs 并邀请内部测试账号。

完成标准：32 个 migration 全部 applied，且不存在 failed migration。

## 4. 部署 Cloudflare staging gateway

Worker 同时提供稳定 BFF 入口和签名告警接收端。它只记录告警元数据，不记录 `details`、Token 或请求正文。

```bash
cd deploy/cloudflare/staging-gateway
npx wrangler login
npx wrangler deploy
npx wrangler secret put ALERT_WEBHOOK_SECRET
```

`ALERT_WEBHOOK_SECRET` 使用至少 32 字符的随机值，并与 BFF 环境保持一致。记录部署输出中的固定 `https://...workers.dev` URL。

## 5. 启动 Redis 与 BFF

Redis 使用命名卷保留本机重启后的状态：

```bash
docker run -d \
  --name supplier-staging-redis \
  -p 127.0.0.1:6379:6379 \
  -v supplier-staging-redis-data:/data \
  redis:7-alpine redis-server --appendonly yes
```

从 `apps/bff/.env.staging.example` 创建 `apps/bff/.env.staging.local`，填入 Supabase、随机密钥、Cloudflare Worker URL 和最终 Vercel Origin。首轮保持以下开关关闭：

```env
DOUYIN_ORDER_SYNC_ENABLED=false
INVENTORY_SYNC_ENABLED=false
ALIBABA_1688_PURCHASE_ENABLED=false
ALIBABA_1688_PURCHASE_AUDIT_ENABLED=false
```

构建并以独立环境文件启动：

```bash
pnpm --filter @supplier/bff build
node --env-file=apps/bff/.env.staging.local apps/bff/dist/main.js
```

本机检查：

```bash
curl -fsS http://127.0.0.1:3001/api/health/live
curl -fsS http://127.0.0.1:3001/api/health/ready
```

## 6. 启动 Quick Tunnel 并更新 Worker

安装并运行：

```bash
brew install cloudflared
cloudflared tunnel --url http://127.0.0.1:3001
```

复制输出的完整 `https://...trycloudflare.com` Origin，然后更新 Worker Secret：

```bash
cd deploy/cloudflare/staging-gateway
npx wrangler secret put BFF_ORIGIN
```

不要把路径、query 或末尾额外内容写进 `BFF_ORIGIN`。通过固定 Worker URL 检查 `/api/health/live` 和 `/api/health/ready`。

## 7. 部署 Vercel Web

1. 从 GitHub 导入测试分支，Root Directory 选择 `apps/web`，Framework 选择 Next.js，并开启构建时包含 Root Directory 外部源码。仓库内的 `apps/web/vercel.json` 会从 monorepo 根目录安装依赖，并用 Turbo 先构建 Web 的工作区依赖。
2. 将 `apps/web/.env.staging.example` 中的五个变量配置到 Vercel；`NEXT_PUBLIC_BFF_URL` 使用固定 Worker URL。
3. 部署后记录稳定项目 URL，例如 `https://supplier-staging.vercel.app`。
4. 如果实际 URL 与 BFF 的 `CORS_ORIGINS` 不同，更新 `apps/bff/.env.staging.local` 并重启 BFF。

Vercel Hobby 仅允许非商业个人用途。公司内部商业测试应使用 Pro Trial，或把 Web 改放允许该用途的免费服务。

## 8. 完成 Auth 与访问边界

1. Supabase Auth 的 Site URL 设置为稳定 Vercel URL。
2. Redirect URLs 只加入需要的 Vercel URL，不使用无界通配符。
3. 关闭公开注册，通过邀请创建内部账号。
4. 确认无 Token 请求业务 API 返回 401，伪造 `x-user-id` 不生效。
5. `/api/operations/*` 只接受独立 `OPERATIONS_TOKEN`。

## 9. 验收与平台开关

先执行部署验证：

```bash
BFF_URL=https://supplier-staging-gateway.ACCOUNT.workers.dev \
WEB_URL=https://supplier-staging.vercel.app \
OPERATIONS_TOKEN=replace-with-local-secret \
pnpm deploy:verify
```

再按登录、选品、筛选、收藏、AI 文案、类目/SKU、铺货记录、订单和经营看板顺序人工验证。真实平台严格按以下顺序开放：

1. 抖店 OAuth 与测试商品发布。
2. 手工订单同步。
3. 库存同步。
4. 1688 小额采购，保持人工付款。
5. 物流回传。
6. 已履约采购后台巡检。

任何一步失败都先关闭对应开关并保留审计、告警和数据库快照；不要同时打开全部自动化。
