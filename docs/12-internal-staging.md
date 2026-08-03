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
pnpm audit:prod
pnpm lint
pnpm typecheck
pnpm exec turbo run test --force -- --api.host=127.0.0.1
pnpm exec turbo run build --force
pnpm --filter @supplier/db exec prisma validate
pnpm exec prettier --check "**/*.{ts,tsx,md,json,yml,yaml}"
git diff --check
node --test scripts/verify-supabase-boundary.test.mjs
node --test deploy/cloudflare/staging-gateway/worker.test.mjs
```

受限执行环境如果不允许 Vitest 监听本机临时端口，应在可信本机或 CI 中执行同一测试命令，不能把 `EPERM` 当作代码失败，也不能用缓存结果替代重跑。

## 3. 创建 Supabase staging

1. 新建 `supplier-staging` 免费项目，优先选择 Singapore 区域。
2. 保存 Project URL、Anon Key、Service Role Key、数据库密码、Pooler URL 和 Direct URL；不要放入 Git、聊天或日志。
3. 从模板创建本地文件 `packages/db/.env.staging.local`，权限设为仅当前用户可读写。
4. 每次先运行只读审计；脚本会检查 migration 状态、live schema diff、远端 migration checksum、失败/回滚记录和关键数据前置条件：

```bash
node --env-file=packages/db/.env.staging.local \
  packages/db/scripts/audit-staging.mjs
```

审计通过且输出 `Database schema is up to date!`、`No difference detected.` 时，**不要再运行 `migrate deploy`**。

5. 只有出现 pending migration 时，才进入受控迁移流程：
   1. 停止 BFF、队列和全部 worker 写入，记录 Git SHA、审计输出和维护窗口。
   2. 确认 Supabase 当前套餐的快照/PITR 能力；如果不能恢复，使用 PostgreSQL 17 `pg_dump --format=custom --schema=public --no-owner --no-privileges` 创建强制 TLS 的一致性备份。
   3. 使用 `pg_restore --list` 校验归档，并先恢复到隔离 PostgreSQL 17 数据库完成恢复演练。
   4. 为隔离库创建不入 Git 的 `packages/db/.env.restore.local`，只填写指向隔离库的 `DATABASE_URL` 和 `DIRECT_URL`，并用单引号包住完整 URL，使文件可被 Node 与 shell 安全加载。在隔离恢复库实际执行待发布 migration，再验证 migration status、schema diff、关键数据量和数据回填；只有全部通过，才允许对 staging 执行一次 `migrate deploy`。

```bash
set -a
. packages/db/.env.restore.local
set +a

psql "$DIRECT_URL" -v ON_ERROR_STOP=1 \
  -f infra/postgres/init-supabase-roles.sql

node --env-file=packages/db/.env.restore.local \
  packages/db/node_modules/prisma/build/index.js migrate deploy \
  --schema packages/db/prisma/schema.prisma

node --env-file=packages/db/.env.restore.local \
  packages/db/node_modules/prisma/build/index.js migrate status \
  --schema packages/db/prisma/schema.prisma

node --env-file=packages/db/.env.restore.local \
  packages/db/node_modules/prisma/build/index.js migrate diff \
  --exit-code \
  --from-schema-datasource packages/db/prisma/schema.prisma \
  --to-schema-datamodel packages/db/prisma/schema.prisma

psql "$DIRECT_URL" -v ON_ERROR_STOP=1 \
  -f infra/postgres/assert-public-schema-isolation.sql
```

角色初始化脚本是幂等的，用于模拟 Supabase 在 application migration 前已存在的 `anon` / `authenticated` 角色；它不能替代权限断言。隔离库还必须用发布前记录的表级行数和关键业务断言核对恢复结果。不要在普通 PostgreSQL 隔离库运行 `audit-staging.mjs`：该脚本刻意只接受同一个 Supabase project 的 pooler/direct host，用于防止把 staging 审计误连到其他数据库。

```bash
node --env-file=packages/db/.env.staging.local \
  packages/db/node_modules/prisma/build/index.js migrate deploy \
  --schema packages/db/prisma/schema.prisma

node --env-file=packages/db/.env.staging.local \
  packages/db/scripts/audit-staging.mjs
```

禁止在 staging 使用 `pnpm db:migrate` / `prisma migrate dev`、`prisma migrate reset`，也禁止手工修改 `_prisma_migrations`。已成功但有逻辑问题的 migration 只能通过新的 corrective migration 前向修复；快照恢复必须先恢复到隔离库验证，不能直接覆盖 staging。

6. 在 Storage 创建公开读取的 `supplier-assets` Bucket，并完成上传、公开读取和删除 smoke。
7. Auth 暂时关闭公开注册；Vercel URL 确定后再配置 Site URL、Redirect URLs 并邀请内部测试账号。使用公开 Web 配置重复验证服务端门禁：

```bash
node --env-file=apps/web/.env.staging.local \
  scripts/verify-supabase-boundary.mjs
```

完成标准：仓库 migration 全部 applied，0 unfinished、0 rolled back、checksum 全匹配，live schema diff 为空。BFF/Redis readiness 属于下一节环境 smoke，不作为数据库审计的循环前置条件。

2026-08-03 当前证据：PostgreSQL 17.6，33/33 migration applied，0 unfinished，0 rolled back，checksum 全匹配，live schema diff 为空；最新 migration 为 `20260803173000_secure_supabase_public_schema`。28/28 public 表启用 RLS，anon/authenticated 对表和 26 个 sequence 均无权限。migration 前的一致性归档 142614 bytes，SHA256 为 `d77d1b618d8ecdc06dbc9bfd6bcb6cbc2828cc6f7316846a17273c8d9e71bcf3`，已在隔离 PostgreSQL 17 恢复，Docker volume 为 `supplier-staging-pre-rls-20260803-1730`。`supplier-assets` 上传、公开读取、删除均返回 200；公开注册关闭，匿名业务表访问返回 401。

## 4. 部署 Cloudflare staging gateway

Worker 同时提供稳定 BFF 入口和签名告警接收端。它只记录告警元数据，不记录 `details`、Token 或请求正文。

```bash
cd deploy/cloudflare/staging-gateway
npx wrangler login
npx wrangler deploy
npx wrangler secret put ALERT_WEBHOOK_SECRET
```

`ALERT_WEBHOOK_SECRET` 使用至少 32 字符的随机值，并与 BFF 环境保持一致。记录部署输出中的固定 `https://...workers.dev` URL。

当前固定入口为 `https://supplier-staging-gateway.chenjie.workers.dev`；`BFF_ORIGIN` 与 `ALERT_WEBHOOK_SECRET` 已配置，Worker 测试 7/7 通过。Secret 更新会产生新的部署版本，记录验收时应使用当前远端版本而不是首次部署版本。

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

当前 Redis `supplier-staging-redis` 仅监听 `127.0.0.1:6379`，使用 `supplier-staging-redis-data` 命名卷、AOF 和 `unless-stopped`。BFF 使用 production/Supabase Auth/数据库队列模式，四项真实平台自动化开关均为 `false`。Supabase Free 实测单次数据库探测偶尔超过 3 秒，因此 staging 专用 `HEALTH_CHECK_TIMEOUT_MS=8000`；探测仍然 fail-closed，超时返回 503。

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

2026-08-03 已记录本机、Tunnel 和 Worker 三条链路各连续 5 次 readiness 200 的时点证据。随机 Quick Tunnel upstream 只保存在本地运维记录中，不提交仓库，也不对测试用户公开；它会在重启后变化，不能作为稳定域名或长期守护证据。

## 7. 部署 Vercel Web

1. 从 GitHub 导入仓库，Root Directory 选择 `apps/web`，Framework 选择 Next.js，并开启构建时包含 Root Directory 外部源码。仓库内的 `apps/web/vercel.json` 会从 monorepo 根目录安装依赖，并用 Turbo 先构建 Web 的工作区依赖。
2. 在 Vercel Git 设置中把 **Production Branch** 设为本次已通过门禁的精确发布分支；当前内测分支为 `codex/internal-test-deploy`。不要用 `main` 或任意 Preview deployment 代替本次稳定入口。
3. 将 `apps/web/.env.staging.example` 中的六个变量配置到 **Production** environment scope；`NEXT_PUBLIC_BFF_URL` 使用固定 Worker URL，内部邀请制保持 `NEXT_PUBLIC_SIGNUP_ENABLED=false`。环境变量变更后重新部署 Production。
4. 部署完成后，核对 Vercel Deployment 的 Git commit SHA 与本地 `git rev-parse HEAD`、远端发布分支 SHA 三者完全一致，再把该 deployment 设为 Production 并记录稳定项目 URL，例如 `https://supplier-staging.vercel.app`。
5. 用最终稳定 URL 同时回填 BFF 的 `CORS_ORIGINS` 和 `OAUTH_RESULT_REDIRECT_URL=https://<stable-vercel-origin>/settings`，重启 BFF 后从固定 Worker 重新验证 OAuth 发起与结果跳转。不能只更新 CORS。
6. 如果稳定 alias、Production Branch、环境变量或提交 SHA 后续变化，重复第 3～5 步并重新运行部署验证。

Vercel Hobby 仅允许非商业个人用途。公司内部商业测试应使用 Pro Trial，或把 Web 改放允许该用途的免费服务。

## 8. 完成 Auth 与访问边界

1. Supabase Auth 的 Site URL 设置为稳定 Vercel URL。
2. Redirect URLs 只加入需要的 Vercel URL，不使用无界通配符。
3. 关闭公开注册，通过邀请创建内部账号；邀请链接进入 Web 后必须设置至少 8 位登录密码。
4. 退出后使用新密码重新登录，再验证刷新页面、token 自动刷新和退出；忘记密码邮件必须回到同一稳定 Web origin。
5. 运行以下命令加载 staging Web 公共配置，确认 `disable_signup=true` 且 anon 读取业务表返回 401/403：

```bash
node --env-file=apps/web/.env.staging.local \
  scripts/verify-supabase-boundary.mjs
```

6. 确认无 Token 请求业务 API 返回 401，伪造 `x-user-id` 不生效。
7. `/api/operations/*` 只接受独立 `OPERATIONS_TOKEN`。

## 9. 验收与平台开关

先执行部署验证：

```bash
DEPLOY_VERIFY_TIMEOUT_MS=30000 \
BFF_URL=https://supplier-staging-gateway.ACCOUNT.workers.dev \
WEB_URL=https://supplier-staging.vercel.app \
OPERATIONS_TOKEN=replace-with-local-secret \
pnpm deploy:verify
```

验证器按顺序执行，避免 Supabase Free 单连接环境因测试自身的并发请求产生假 503；30 秒只是 staging 的单请求上限，不能替代延迟监控或正式 SLA。

再按登录、选品、筛选、收藏、AI 文案、类目/SKU、铺货记录、订单和经营看板顺序人工验证。真实平台严格按以下顺序开放：

1. 抖店 OAuth 与测试商品发布。
2. 手工订单同步。
3. 库存同步。
4. 1688 小额采购，保持人工付款。
5. 物流回传。
6. 已履约采购后台巡检。

任何一步失败都先关闭对应开关并保留审计、告警和数据库快照；不要同时打开全部自动化。

## 10. 当前未关闭项

截至 2026-08-03，Supabase、Storage、Auth 服务端边界、Worker、Redis、BFF readiness 和告警状态机已有真实环境证据，但 R0-03 仍未完成：

固定 Worker + 本地 Web 已通过 15 项部署验证，包括 live/ready、四个生产文档路由 404、三种鉴权拒绝、OAuth、运维状态/检查/指标和 Web 200；本地 Web 不能替代稳定托管 URL。

- Vercel 项目与稳定 Web URL 尚未创建；BFF CORS/OAuth 结果地址和 Supabase Site/Redirect URL 仍待回填。
- 尚无真实邀请邮箱完成设置密码、登录、刷新、受保护 API、退出和密码恢复验收。
- Redis 虽已配置 AOF/命名卷，但尚未用非空探针证明重启后保留；数据库队列也尚未完成非空重启演练。
- BFF 与 Quick Tunnel 仍是手工前台进程，没有 launchd、容器编排或等价守护；Quick Tunnel 无 SLA。
- Vercel Hobby 只允许非商业个人验证；公司商业内测必须使用 Pro Trial 或其他许可匹配的托管方案。

以上任一项未关闭时，不得把 R0-03 标记为完成，也不得用该 staging 证据宣称生产可用。
