# 12 · 免费内部测试环境

> 目标：优先使用 Supabase Free 与 Cloudflare Workers Free/Tunnel，在不改写 NestJS BFF 的前提下验证核心功能；稳定 Web 首选 Cloudflare Workers Free，Vercel Pro Trial 仅作备选。本方案不是生产架构；本机必须在线，Cloudflare Quick Tunnel 无 SLA。

## 1. 拓扑

```text
Cloudflare Workers Web（supplier-staging-web）
    │ HTTPS
    ▼
Cloudflare staging gateway（固定 workers.dev URL、签名告警接收）
    │ HTTPS
    ▼
Cloudflare Quick Tunnel（随机 trycloudflare.com URL）
    │
    ▼
本机 BFF :3001 ── 本机 Redis :6379
    │
    └── Supabase Free（PostgreSQL / Auth / Storage）
```

Web Worker 只托管 Next 静态导出产物；staging gateway 为 BFF 和平台 OAuth 提供稳定入口。每次 Quick Tunnel 地址变化时，只更新 gateway 的 `BFF_ORIGIN` Secret，不需要重新构建 Web。BFF 的租户 API 仍由 Supabase JWT 保护，运维 API 仍由独立 `OPERATIONS_TOKEN` 保护。

## 2. 发布代码版本

从门禁通过的独立分支部署。提交和推送前至少执行：

```bash
pnpm audit:prod
pnpm lint
pnpm typecheck
pnpm exec turbo run test --force
pnpm exec turbo run build --force
pnpm --filter @supplier/db exec prisma validate
pnpm test:ops
pnpm exec prettier --check "**/*.{ts,tsx,md,json,yml,yaml}"
pnpm exec prettier --check scripts/supabase-api-keys.mjs \
  scripts/invite-staging-user.mjs \
  scripts/invite-staging-user.test.mjs \
  scripts/verify-supabase-*.mjs
git diff --check
node --test deploy/cloudflare/staging-gateway/worker.test.mjs
```

受限执行环境如果不允许 Vitest 监听本机临时端口，应在可信本机或 CI 中执行同一测试命令，不能把 `EPERM` 当作代码失败，也不能用缓存结果替代重跑。

## 3. 创建 Supabase staging

1. 新建 `supplier-staging` 免费项目，优先选择 Singapore 区域。
2. 保存 Project URL、新式 Publishable Key（`sb_publishable_*`）、新式 Secret Key（`sb_secret_*`）、数据库密码、Pooler URL 和 Direct URL；不要放入 Git、聊天或日志。legacy anon / service-role JWT 只用于迁移期兼容，不能作为新环境默认值。
3. 从模板创建本地文件 `packages/db/.env.staging.local`，权限设为仅当前用户可读写。
4. 每次先运行只读审计。脚本会先在只读事务内检查远端 migration、checksum、失败/回滚记录、RLS/ACL 和关键数据前置条件；默认严格模式要求 0 pending，并继续执行 live schema diff：

```bash
node --env-file=packages/db/.env.staging.local \
  packages/db/scripts/audit-staging.mjs
```

如果预期存在待发布 migration，迁移前审计必须显式使用 `--allow-pending`：

```bash
node --env-file=packages/db/.env.staging.local \
  packages/db/scripts/audit-staging.mjs --allow-pending
```

该模式只接受“远端已应用 migration 严格匹配本地前缀、pending 为连续本地尾部”；unknown、乱序、checksum 不一致、unfinished、rolled back、RLS/ACL 失配或同一店铺非空 `platform_product_id` 重复都会失败。Prisma `migrate status` 只有在精确返回同一 pending 清单时才允许退出 1；输出会列出 `pendingNames`，并将 datamodel schema diff 标为 `deferred`，不能作为 schema 已一致或 migration 已完成的证据。

默认严格审计通过且输出 `Database schema is up to date!`、`No difference detected.` 时，**不要再运行 `migrate deploy`**。

5. 只有出现 pending migration 时，才进入受控迁移流程：
   1. 停止 BFF、队列和全部 worker 写入，记录 Git SHA、审计输出和维护窗口。
   2. 确认 Supabase 当前套餐的快照/PITR 能力；如果不能恢复，使用 PostgreSQL 17 `pg_dump --format=custom --schema=public --no-owner --no-privileges` 创建强制 TLS 的一致性备份。
   3. 使用 `pg_restore --list` 校验归档，并先恢复到隔离 PostgreSQL 17 数据库完成恢复演练。
   4. 为隔离库创建不入 Git 的 `packages/db/.env.restore.local`，只填写指向隔离库的 `DATABASE_URL` 和 `DIRECT_URL`，并用单引号包住完整 URL，使文件可被 Node 与 shell 安全加载。在隔离恢复库实际执行待发布 migration，再验证 migration status、schema diff、关键数据量和数据回填；只有全部通过，才允许对 staging 执行一次 `migrate deploy`。第 36 个 migration 还必须预查同一 `shop_id` 下非空 `platform_product_id` 没有重复；应用第 36～43 个后核对 `published_products.mutation_revision`、`sku_price_snapshot`、`price_synced_at`、`sku_inventory_snapshot`、`product_batch_tasks.state_revision`、两张 `product_batch_*` 表、`source_import_tasks`、`source_import_items`、`user_source_products`、`published_product_source_bindings`、两张 `exception_*` 表和四张 `after_sale_*` 表的唯一索引、复合租户/订单外键、生命周期与事件 CHECK、RLS 及表/sequence 权限。隔离库必须证明 43/43、schema diff 为空，一单一工单、工单/子单/采购同订单及 UUID 命令唯一键均生效，并通过第 43 个 migration 对三个 NULL/UNKNOWN 绕过的回滚式负向探针。
   5. 如果最终只读审计仍报告 `mockSupplierIdBackfillRequired=true`，必须在 migration 前使用专用脚本；默认模式只读检查，写模式要求显式 `--apply`、精确 project ref、33/43、最新第 33 个 migration、binding 表不存在、十个 mock 集合与现有元数据全部匹配。它只更新空白 `supplier_id` 并在同一事务回读；禁止运行通用 `scripts/seed.mjs`。

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

psql "$DIRECT_URL" -v ON_ERROR_STOP=1 \
  -f infra/postgres/assert-workflow-check-constraints.sql

psql "$DIRECT_URL" -v ON_ERROR_STOP=1 \
  -f infra/postgres/assert-33-to-43-upgrade-data.sql
```

角色初始化脚本是幂等的，用于模拟 Supabase 在 application migration 前已存在的 `anon` / `authenticated` 角色；它不能替代权限断言。隔离库还必须用发布前记录的表级行数和关键业务断言核对恢复结果。不要在普通 PostgreSQL 隔离库运行 `audit-staging.mjs`：该脚本刻意只接受同一个 Supabase project 的 pooler/direct host，用于防止把 staging 审计误连到其他数据库。

```bash
node --env-file=packages/db/.env.staging.local \
  packages/db/scripts/backfill-staging-mock-supplier-ids.mjs

# 仅在上一步显示 pendingUpdates=10 且本次维护授权明确包含 backfill 时执行；
# 将 YOUR_20_CHAR_PROJECT_REF 替换为控制台中的实际 Project Ref。
node --env-file=packages/db/.env.staging.local \
  packages/db/scripts/backfill-staging-mock-supplier-ids.mjs \
  --apply --confirm-project=YOUR_20_CHAR_PROJECT_REF

node --env-file=packages/db/.env.staging.local \
  packages/db/scripts/backfill-staging-mock-supplier-ids.mjs

node --env-file=packages/db/.env.staging.local \
  packages/db/scripts/audit-staging.mjs --allow-pending

node --env-file=packages/db/.env.staging.local \
  packages/db/node_modules/prisma/build/index.js migrate deploy \
  --schema packages/db/prisma/schema.prisma

set -a
. packages/db/.env.staging.local
set +a

psql "$DIRECT_URL" -v ON_ERROR_STOP=1 \
  -f infra/postgres/assert-workflow-check-constraints.sql

node --env-file=packages/db/.env.staging.local \
  packages/db/scripts/audit-staging.mjs
```

禁止在 staging 使用 `pnpm db:migrate` / `prisma migrate dev`、`prisma migrate reset`，也禁止手工修改 `_prisma_migrations`。已成功但有逻辑问题的 migration 只能通过新的 corrective migration 前向修复；快照恢复必须先恢复到隔离库验证，不能直接覆盖 staging。

6. 在 Storage 创建公开读取的 `supplier-assets` Bucket，并完成上传、公开读取和删除 smoke。
7. Auth 暂时关闭公开注册；稳定 Web URL 确定后再配置 Site URL、Redirect URLs 并邀请内部测试账号。使用公开 Web 配置重复验证服务端门禁：

```bash
pnpm audit:supabase-boundary
```

验证器固定读取当前用户所有、权限恰为 `0600` 的 `apps/web/.env.staging.local`，不接受 shell 中残留变量覆盖目标项目或 Key。legacy anon JWT 使用 `apikey` 与 Bearer；新式 Publishable Key 只发送 `apikey`。

完成标准：仓库 migration 全部 applied，0 unfinished、0 rolled back、checksum 全匹配，live schema diff 为空。BFF/Redis readiness 属于下一节环境 smoke，不作为数据库审计的循环前置条件。

2026-08-03 的旧基线审计确认当时 staging 为 PostgreSQL 17.6、33/33 migration applied、0 unfinished、0 rolled back、checksum 全匹配且 live schema diff 为空；28/28 public 表启用 RLS，anon/authenticated 对表和 26 个 sequence 均无权限。当前候选的实时只读预检现已完成：staging 仍为 33/43，第 34～43 个是连续 pending 尾部，已应用前缀 checksum、unfinished/rolled back、RLS/ACL 与同店铺非空 `platform_product_id` 重复前置条件全部通过；因存在 pending，当前 datamodel schema diff 按规则标记 `deferred`。本次 staging 真实数据一致性备份为 150265 bytes，SHA256 `b4eb1f374c75f5aa6244568443143394628b9a252dfbad3114473ae9d2e6fc54`；归档已在隔离临时 PostgreSQL 17 数据库完成 33→43 恢复升级，43/43、schema diff 无差异、数据量为 10 条货源/0 条铺货/0 条订单/0 条采购、41/41 public 表 RLS，以及 ACL、工作流约束和升级数据断言全部通过。`supplier-assets` 上传、公开读取、删除与关闭公开注册、匿名业务表拒绝仍沿用旧候选证据。第 34～43 个尚未实际应用到 staging；下一步必须取得维护窗口授权，停止 BFF、队列和全部 worker 写入，由单一 migration-once 执行，再复核 43/43、checksum、schema diff、工作流负向约束与 RLS/ACL，随后重部署并完成 smoke。隔离演练不得写成 staging 已迁移。

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

从 `apps/bff/.env.staging.example` 创建 `apps/bff/.env.staging.local`，填入 Supabase、随机密钥、Cloudflare gateway URL 和最终稳定 Web Origin。首轮保持以下开关关闭：

`SUPABASE_SERVICE_ROLE_KEY` 优先使用 `sb_secret_*`；它只允许出现在 BFF 私有环境文件中，禁止复制到任何 `NEXT_PUBLIC_*` 变量、聊天、日志或浏览器。

```env
DOUYIN_ORDER_SYNC_ENABLED=false
DOUYIN_ORDER_SYNC_HISTORY_VERIFIED_AT=
EXCEPTION_CENTER_SCAN_ENABLED=false
EXCEPTION_CENTER_SCAN_INTERVAL_MS=300000
EXCEPTION_CENTER_SCAN_BATCH_SIZE=50
INVENTORY_SYNC_ENABLED=false
ALIBABA_1688_PURCHASE_ENABLED=false
ALIBABA_1688_PURCHASE_AUDIT_ENABLED=false
PRODUCT_BATCH_ENABLED=false
PRODUCT_BATCH_POLL_MS=2000
PRODUCT_BATCH_MAX_ATTEMPTS=3
SOURCE_IMPORT_ENABLED=false
SOURCE_IMPORT_POLL_MS=2000
SOURCE_IMPORT_MAX_ATTEMPTS=3
ALIBABA_1688_SOURCE_DATA_SCOPE=
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

当前 Redis `supplier-staging-redis` 仅监听 `127.0.0.1:6379`，使用 `supplier-staging-redis-data` 命名卷、AOF 和 `unless-stopped`。BFF 使用 production/Supabase Auth/数据库队列模式，订单同步、库存、采购、履约巡检、批量商品执行和批量货源采集六项开关均为 `false`。Supabase Free 实测单次数据库探测偶尔超过 3 秒，因此 staging 专用 `HEALTH_CHECK_TIMEOUT_MS=8000`；探测仍然 fail-closed，超时返回 503。readiness 的最新必需版本已前移到 `20260805040000_harden_workflow_check_null_semantics`，因此第 43 个 migration 未应用时新 BFF 必须保持 503，不能绕过后接流量。

批量货源采集不得仅因页面可见就开启。先保持 `SOURCE_IMPORT_ENABLED=false`，用两个受控 1688 买家账号对同一组 offer 分别取证标题、SKU、分销价和库存；只有确认这些字段不随账号变化，并完成方案配额、限流和曝光回传要求核验后，才在维护窗口写入 `ALIBABA_1688_SOURCE_DATA_SCOPE=global_offer` 并开启 worker。开启后至少用两个 Supabase 测试用户分别验证任务列表、按 client request 恢复和“我的货源”互不可见；再演练 BFF 重启、Redis 不可用、停止未开始项、单个失败项重试、相同 UUID 同参恢复和异参 409。任何一项失败都应重新关闭开关，不得回退 Mock。

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

### 6.1 macOS 内测进程守护

本机长期承载内测 BFF 时，不再分别手工运行 BFF 和 Quick Tunnel。仓库提供一个最小权限的 supervisor：先启动 production BFF 并等待本机 readiness，再启动 Quick Tunnel；解析到新的随机 Origin 后，通过本机已登录的 Wrangler 将 Worker `BFF_ORIGIN` 更新为该 Origin，并等待固定 Worker readiness。BFF 或 Tunnel 任一退出时，supervisor 会优雅停止另一进程并以失败退出，由 launchd 有界重启整组进程。

安装前确认 BFF 已构建、Wrangler 已登录到正确账号，随后只传入公开的 Cloudflare Account ID 和固定 Worker Origin：

```bash
export CLOUDFLARE_ACCOUNT_ID=<32-character-account-id>
export STAGING_GATEWAY_URL=https://supplier-staging-gateway.chenjie.workers.dev
pnpm staging:launchagent:install
```

安装器只把 Account ID、固定 Worker Origin、执行路径和仓库路径写入 `~/Library/LaunchAgents/com.supplier.staging-local.plist`；数据库、平台、Supabase、运维和 Worker 密钥仍只从已忽略且权限为 `0600` 的本地环境文件或 Wrangler 凭据读取，不会复制进 plist。用下列命令核验：

```bash
launchctl print gui/$(id -u)/com.supplier.staging-local
curl -fsS http://127.0.0.1:3001/api/health/ready
curl -fsS https://supplier-staging-gateway.chenjie.workers.dev/api/health/ready
```

Quick Tunnel 仍不提供 SLA；此守护只关闭“前台进程退出即失联”的内测缺口，不能作为正式生产入口。生产环境必须迁移到稳定 Tunnel、容器平台或等价的受监控托管服务。

## 7. 部署稳定 Web

公司内部商业测试优先使用 Cloudflare Workers Free 的纯静态 Assets；Vercel Hobby 不适用，只有静态深链无法满足产品时才评估 Vercel Pro Trial。

1. 从 `apps/web/.env.staging.example` 创建权限为 `0600`、不入 Git 的 `apps/web/.env.production.local`，填写六个公开构建变量；`NEXT_PUBLIC_BFF_URL` 使用固定 gateway URL，`NEXT_PUBLIC_SUPABASE_ANON_KEY` 使用 `sb_publishable_*`，邀请制保持 `NEXT_PUBLIC_SIGNUP_ENABLED=false`。同一组公开配置也写入权限为 `0600` 的 `apps/web/.env.staging.local`，供只读边界与 Auth 验收器固定读取。
2. 从仓库根目录执行 `pnpm --filter @supplier/web cf:dry-run`。该脚本清理旧 `.next/out`，先构建 `@supplier/shared-types`，再以 `WEB_BUILD_TARGET=static` 导出 `out`；Wrangler 必须报告静态 assets 且没有 bindings。
3. 执行 `pnpm --filter @supplier/web cf:preview`，检查登录页、设置页、订单页、`/products?id=<商品编号>`，并确认旧 `/products/<商品编号>` 经 `_redirects` 301 到新地址；确认后再执行 `pnpm --filter @supplier/web cf:deploy`。部署输出应为独立的 `supplier-staging-web` assets-only Worker，并记录稳定 `workers.dev` URL、部署版本 ID 和 `git rev-parse HEAD`。
4. 用 `wrangler tail` 反向验证部署没有可执行 Worker；当前应返回 `Cannot tail a Worker which only has assets`。若未来重新引入 SSR / Worker 代码，必须重新执行 Free CPU 门禁，不能依赖平台对偶发超限的弹性。
5. 用最终稳定 Web origin 同时回填 BFF 的 `CORS_ORIGINS` 和 `OAUTH_RESULT_REDIRECT_URL=https://<stable-web-origin>/settings`，重启 BFF；Supabase Auth 的 Site URL 设为该 origin，Redirect URLs 只加入实际使用的精确地址。
6. 设置 `WEB_URL=https://<stable-web-origin>`、固定 `BFF_URL` 和运维变量后运行 `pnpm deploy:verify`，再完成邀请、设置密码、登录、刷新、受保护 API、退出和密码恢复浏览器验收。URL、变量、部署版本或 SHA 变化后必须重复回填与验收。

Vercel Pro Trial 备选仍使用 `apps/web/vercel.json`：Root Directory 选 `apps/web`、Node.js 固定 22、Production Branch 锁定门禁通过的发布分支，并核对 Production deployment SHA；回填与验收要求与上面相同。

## 8. 完成 Auth 与访问边界

1. Supabase Auth 的 Site URL 设置为稳定 Web URL。
2. Redirect URLs 只加入需要的稳定 Web URL，不使用无界通配符。
3. 先完成已暴露 legacy 管理员 Key 的迁移，不得只替换本地变量后就声称旧 Key 已失效：
   1. 在 Supabase Dashboard 创建新的 `sb_secret_*` 与 `sb_publishable_*`；创建和最终停用 legacy Key 都属于外部权限变更，执行前需当次确认。
   2. 将 `sb_secret_*` 写入 `apps/bff/.env.staging.local`，将 `sb_publishable_*` 写入 Web staging/production 文件；重启 BFF，并重新构建、部署静态 Web。
   3. 运行下列验证。Secret 验证器固定读取 BFF 私有文件，使用随机 Storage 路径执行 Auth admin、上传、公开读取和删除；Publishable 边界验证器固定读取 Web 私有文件。两者都禁止重定向，不输出 Key、对象路径或响应正文：

      ```bash
      pnpm audit:supabase-key-rotation
      pnpm audit:supabase-boundary:publishable
      ```

   4. 再运行 `pnpm deploy:verify` 和真实 Auth 会话 smoke。只有新 Secret、Publishable、Web bundle、BFF、Auth 与 Storage 全部通过后，才能在 Dashboard 停用 legacy Key；停用后重复上述验证和部署 smoke。

4. 关闭公开注册，通过操作员确认的单请求管理员邀请创建内部账号。邀请前在权限为 `0600` 且不入 Git 的 `apps/bff/.env.staging.local` 中确认已有 `SUPABASE_URL` 和新式 `SUPABASE_SERVICE_ROLE_KEY`，临时加入精确稳定 Web origin 和目标邮箱：

   ```env
   WEB_URL=https://supplier-staging-web.chenjie.workers.dev
   STAGING_INVITE_EMAIL=replace-with-target-inbox
   ```

   随后执行命令，并在终端提示后再次手工输入本次目标邮箱：

   ```bash
   pnpm staging:auth:invite
   ```

   CLI 固定读取上述本地文件并要求它是当前用户所有、权限恰为 `0600` 的普通文件，不使用 shell 中残留的同名变量覆盖 Supabase 项目、Web 回跳或邮箱。脚本只接受受支持的 Supabase service-role / secret Key 格式；legacy JWT 使用 `apikey` 与 Bearer，新式 `sb_secret_*` 只发送 `apikey`，实际管理员权限仍由远端 Auth 校验。它通过 `POST /auth/v1/invite` 发送一条禁止跟随重定向的请求，不打印邮箱、用户 ID、响应正文或 Key，也不会自动重试。HTTP 200 后先立即从环境文件移除 `STAGING_INVITE_EMAIL`，再检查邮箱。若出现超时、网络错误、5xx、成功响应不完整或重复操作疑问，先在 Supabase Auth users 中核对，不能直接重跑；未确认邮箱重复邀请会再次发信并旋转邀请 token。邀请链接必须回到 `WEB_URL`，进入 Web 后设置至少 8 位登录密码。

5. 退出后使用当前密码重新登录，再验证刷新页面、token 自动刷新和退出；忘记密码邮件必须回到同一稳定 Web origin。
6. 运行固定文件边界验证，确认当前为 Publishable Key、`disable_signup=true` 且匿名读取业务表返回 401/403：

```bash
pnpm audit:supabase-boundary:publishable
```

7. 邀请账号完成设置密码后，在 `apps/web/.env.staging.local` 临时加入 `AUTH_TEST_EMAIL` 与当前 `AUTH_TEST_PASSWORD`；固定 Worker 已由 `NEXT_PUBLIC_BFF_URL` 提供。运行普通会话验证：

```bash
pnpm audit:supabase-auth-session
```

验证器依次检查密码登录、有效 JWT 访问、refresh token 换新会话、刷新后 JWT 访问、GoTrue 登出、刚刷新得到的 refresh token 再换会话必须返回 400/401，以及无 Token 访问 401；全程不输出邮箱、密码、Token 或响应正文。

8. 在浏览器触发忘记密码，核对邮件和稳定 Web 回跳，并设置一个不同的新密码。随后把旧密码写入 `AUTH_TEST_PREVIOUS_PASSWORD`，把 `AUTH_TEST_PASSWORD` 更新为新密码，执行：

   ```bash
   pnpm audit:supabase-auth-password-transition
   ```

   转换验收先要求旧密码返回 400/401，再完整验证新密码会话；429、5xx、超时或网络错误都不能当作“旧密码已失效”。旧密码若意外成功，脚本仅清理该会话并失败，不继续新密码链路。脚本不会发送恢复邮件、点击链接或修改密码，不能替代浏览器验收。完成后立即从文件移除 `AUTH_TEST_EMAIL`、`AUTH_TEST_PASSWORD` 和 `AUTH_TEST_PREVIOUS_PASSWORD`。

9. 确认无 Token 请求业务 API 返回 401，伪造 `x-user-id` 不生效。
10. `/api/operations/*` 只接受独立 `OPERATIONS_TOKEN`。

## 9. 验收与平台开关

先执行部署验证：

```bash
DEPLOY_VERIFY_TIMEOUT_MS=30000 \
BFF_URL=https://supplier-staging-gateway.ACCOUNT.workers.dev \
WEB_URL=https://supplier-staging-web.chenjie.workers.dev \
OPERATIONS_TOKEN=replace-with-local-secret \
pnpm deploy:verify
```

验证器按顺序执行，避免 Supabase Free 单连接环境因测试自身的并发请求产生假 503；30 秒只是 staging 的单请求上限，不能替代延迟监控或正式 SLA。

再按登录、选品、筛选、收藏、AI 文案、类目/SKU、铺货记录、批量经营、订单、统一异常中心、售后工单和经营看板顺序人工验证。批量经营当前验收 `online`、`offline`、`edit_title`、`edit_price`、`sync_inventory`、`cleanup` 与抖店离线 `change_source`。`change_source` 只切换版本化采购绑定，必须保持平台 SKU、售价和离线状态不变；任意平台 SKU 编辑仍是未来能力，不能把换源或数据库 enum 写成已支持平台 SKU 编辑。

异常中心先保持 `EXCEPTION_CENTER_SCAN_ENABLED=false`，用两个 Supabase 测试用户验证列表、计数、详情和确认记录完全隔离，再分别准备可清理的发布、订单同步、采购、物流、售后和权益异常。订单域必须覆盖从未同步、水位陈旧、首次同步挂起、授权过期和启用店铺凭证缺失；用户主动停用的 `revoked` 店铺不得重新产生 critical 异常，刚授权或近期首次同步中的店铺也不得提前告警。确认一次六域刷新只关闭权威条件已经消失的 scanner 事项；人为让某一域查询失败时，该域旧事项必须保留。对一条事项写入跟进说明后状态只能变为 `acknowledged`，不能同时关闭；改变来源指纹后必须重新变为 `open`。物流回传失败或成功后平台回读未知必须生成 producer 事项，只有后续回读确认平台已发货才能关闭。所有处理入口只能落在明确白名单的站内路径，包括 `/orders`、`/published`、`/settings`、`/sources` 或 `/after-sales`。样本通过后在维护窗口开启 worker，确认账号批次轮转有界、单账号失败不阻断后续账号且同一实例不重入；生产运行不得继续依赖人工刷新。

售后工单使用两个 Supabase 测试用户分别验证 `/after-sales` 列表、详情、子单、采购关联和事件时间线完全隔离。准备可清理的抖店部分退款、整单退款/关闭与 1688 已下单样本，依次验证订单刷新自动建单、认领、记录人工取消/退款退货/拦截及外部编号、结果失败后重试、同 UUID 同参恢复和异参 409。销售来源或采购 revision 变化必须使旧确认失效并重开；超过 5 分钟的销售快照、未完成的部分退款处置/金额核对、未确认的 1688 人工动作、未核销采购异常或成本都必须阻止关闭。只有真实平台操作完成、5 分钟内回读成功且全部阻断清除后才允许关闭。本候选不自动调用 1688 售后、退款或退货接口，不能把人工证据闭环写成自动售后。

首次批量 worker 验收分两阶段：

1. 保持 `PRODUCT_BATCH_ENABLED=false`，创建最多 100 件的持久化预览并刷新页面，确认任务仍可恢复、预览不调用平台；确认执行必须返回 503，数据库不得出现 queued/running item。
2. 选定可清理的抖店测试商品，在维护窗口把 `PRODUCT_BATCH_ENABLED=true` 后重启 BFF。先验收普通批量下架：确认前再次核对预览；观察 item 从 pending 到 running/终态，真实平台必须回读为下架才算成功。再用至少 2 个 SKU 的在线商品分别验收比例上调/下调、逐项目标起售价、多 SKU 价格区间、平台回读、部分失败续跑和外部价格漂移阻断；随后执行一次标题修正并确认不会把新价格写回旧值。库存同步必须显示同步前/1688 目标/平台回读三列，分别演练完整成功、部分 SKU 成功后只续跑剩余项、源版本变化和平台外部漂移；发布恢复与标题修正也要确认不会把请求库存误记成功或覆盖平台当前值。然后选择有可售库存的已下架商品验收批量上架：平台库存不一致时必须先保持下架补齐，只有两次状态回读均为在线且逐 SKU 库存完全一致才成功；演练超时、状态/库存反向不一致、隔离后迟到上线和普通状态同步阻断，未知结果只能走逐项核验，不能直接重试。最后验收 `cleanup` 与离线安全换源：先保持历史确认变量为空并确认真实店全部候选被阻断；强制完成一次覆盖最近 30 天的全量订单回补并记录完成时间，等待店铺在该时间后成功完成增量同步，再把精确 UTC 时间写入 `DOUYIN_ORDER_SYNC_HISTORY_VERIFIED_AT` 并重启 BFF。`cleanup` 只选择上架满 7 天且近 30 天无有效订单的商品，确认预览不调用平台；分别演练预览后出单、下架期间出单、同步错误/运行中/水位过期、网络超时和 worker 中断。换源只选择已连续确认下架、无未核验写入且当前绑定唯一的抖店商品，目标必须是当前用户已采集、可售且支持一件代发的 1688 offer；执行前记录平台商品 ID、SKU key、售价、离线状态和旧绑定，执行后确认只有采购绑定/成本/库存目标变更，平台事实不变，并分别验证切换前付款订单仍走旧绑定、切换后订单走新绑定。未知下架结果只能逐项核验，未核验期间完整编辑、状态同步、库存与其他批量动作必须被阻断；清理不得删除商品或历史数据。完成后清空历史确认变量并恢复 `PRODUCT_BATCH_ENABLED=false`，直到真实平台 E2E 和运营策略批准长期开启。

真实平台其他自动化严格按以下顺序开放：

1. 抖店 OAuth 与测试商品发布。
2. 批量下架、滞销安全下架、改标题、改价、库存同步与安全上架切片。
3. 手工订单同步。
4. 库存同步。
5. 1688 小额采购，保持人工付款。
6. 物流回传。
7. 已履约采购后台巡检。

任何一步失败都先关闭对应开关并保留审计、告警和数据库快照；不要同时打开全部自动化。

## 10. 当前未关闭项

截至 2026-08-04，R0-02 数据库实时预检、真实备份和隔离升级证据已更新；Supabase Storage、Auth 服务端边界、Worker、Redis、BFF readiness、告警状态机和非空重启持久性仍沿用 2026-08-03 的旧候选真实环境证据，R0-03 尚未完成：

已部署旧候选的固定 Worker + 固定 Cloudflare Web 通过 15 项部署验证，包括 live/ready、四个生产文档路由 404、三种鉴权拒绝、OAuth、运维状态/检查/指标和 Web 200。远端已部署版本的 Web URL 为 `https://supplier-staging-web.chenjie.workers.dev`，BFF 精确 CORS/OAuth 结果地址及 Supabase Site/Redirect URL 已回填。

- 初版 OpenNext 版本 `2cfa19b5-0b44-4081-a240-8c0737563922` 压缩上传为 953.71 KiB，但动态路由 CPU 实测 40ms，已被替换。当前远端已部署版本 `7d15e88a-20bc-40c8-a255-4dae8dcd7e52` 包含 59 个纯静态 assets；Cloudflare 明确无可 tail 的 Worker，固定 URL 与 15/15 HTTPS 复验通过，旧候选的稳定 Web 托管缺口已关闭。
- 已增加新旧 Key 请求头兼容、强制新 Secret 的 Auth/Storage 轮换 smoke、固定私有 Web 配置的边界/会话验证，以及旧密码失效检查；这些仍是代码证据，尚未创建新 Key、重新部署 Web/BFF 或停用 legacy Key。
- 操作员二次确认的单请求管理员邀请脚本及安全测试已完成；尚无真实邀请邮箱完成收信、设置密码、登录、刷新、受保护 API、退出、恢复邮件回跳和旧密码失效验收。
- Redis AOF / 命名卷与数据库队列已分别通过非空探针重启演练；探针均已清理，旧候选重启后本机与固定 Worker readiness 为 200。
- 当前 M80 候选的全仓 `pnpm test` 14/14 个任务共 1182 项（BFF 807、Web 99）、typecheck 15/15、lint 2/2、build 9/9、Prisma validate 与 `git diff --check` 已通过，`/after-sales` 已静态生成；这些是代码门禁证据，不替代下述 migration、重部署或真实环境验收。
- 当前 M82 候选已修复 CI demo seed 缺 `supplierId` 导致的 pricing-preview 400，seed 会回读十个 mock 货源的可发布元数据；部署验证从已部署旧候选的 15 项扩为 18 项，分别执行草稿 PUT/DELETE CORS 正向和恶意 Origin 负向 OPTIONS，并禁止重定向、脱敏并释放错误响应。合并后本地 `pnpm test` 1192/1192、运维 59/59、CORS 1/1、Chromium 1/1、typecheck、lint 与 BFF build 通过；[GitHub Release gates #23](https://github.com/harzss/supplier/actions/runs/30910322944) 已在提交 `a48fb43` 上完成 verify、browser、images 三个 job 全绿；images 在临时 PostgreSQL 15/Redis 中完成当前 SHA 三镜像构建、43/43 migration/status/schema/约束断言与 18 项 production smoke。镜像未推送，staging 仍为 33/43，候选尚未迁移或重部署。
- M83 只读审计确认现有十条货源精确为 `mock-1001`～`mock-1010`，已核对的铺货、订单、采购和发布任务计数均为 0，但十条 `supplierId` 全部缺失，当前 `publishReady=false`、`mockSupplierIdBackfillDataCompatible=true`。审计只返回聚合计数且事务第一句设为 read only；专用 backfill 还会强制 33/43、binding 表不存在和精确项目确认，因此仅可在维护窗口停写、完成最终备份且再次得到同样结果后，按明确授权定向补齐十条确定性供应商标识并立即回读。通用 seed 会覆盖货源与评分，禁止用于 staging；尚未执行 backfill。
- 旧候选 `8ddac05` 没有与 Git SHA 绑定的 BFF 镜像或动态回滚 smoke；更重要的是，它不会维护第 34～43 个 migration 对应的版本化货源绑定、发布幂等、价格/库存与订单成本快照、异常和售后语义，不能在迁移后恢复写流量。维护失败时保持停写并前向修复；不得把旧 BFF readiness 可能返回 200 当作安全回滚证据。
- 第 36～43 个批量经营、采集、版本化货源绑定、统一异常中心、售后工单与状态机约束加固 migration，以及 `/published/batch`、`/sources`、`/exceptions`、`/after-sales` 等候选能力已有仓库代码、本地测试、空库 43/43 和 staging 真实数据隔离 33→43 升级证据；staging 仍为 33/43，尚未实际迁移、重部署、完成 30 天订单历史回补、启动 staging worker、执行真实抖店/1688 批量验收、真实六域异常或售后工单 E2E，不能计入已部署 staging 能力。
- BFF / Quick Tunnel supervisor、LaunchAgent 安装器及 15 项测试已完成，Worker 更新只执行仓库锁定的 Wrangler 4.118.0；但持续后台暴露本机 BFF 并自动修改 Worker upstream 属于长期权限变更，尚未获得用户明确授权安装；当前仍是临时前台进程。Quick Tunnel 仍无 SLA。
- Vercel Hobby 只允许非商业个人验证，不作为公司商业内测的回退方案。

以上任一项未关闭时，不得把 R0-03 标记为完成，也不得用该 staging 证据宣称生产可用。
