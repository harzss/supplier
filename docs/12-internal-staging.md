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
3. 从模板创建本地文件 `packages/db/.env.staging.local`，权限设为仅当前用户可读写。该文件必须是当前用户所有、非 symlink、权限精确为 `0600` 的普通文件，且只能包含 `STAGING_PROJECT_REF`、`DATABASE_URL`、`DIRECT_URL` 三个键。
4. 所有连接 staging 的 Prisma 5.22 操作（audit、backfill、migration status/deploy/status 和 schema diff）只允许通过固定宿主机 runner 进入当前 clean Git SHA 的 Linux `staging-maintenance` 镜像。runner 不把源 `.env` 交给 Docker：它以 `O_NOFOLLOW` 打开固定文件，要求当前用户所有、权限精确 `0600`，并用“恰好三个无引号、无注释、无 CR/控制字符的 ASCII 单行赋值”语法解析，只把三个命名变量加入 Docker CLI 的最小子环境，再通过 `--env KEY` 传入容器。它还会清除 ambient `NODE_OPTIONS`、`DOCKER_*` 与数据库变量影响，固定本机 Unix-socket context，要求 clean worktree，用 `git archive --format=tar HEAD` 作为唯一 build context，核对完整 image ID、OCI revision label 和非 root 用户，最后只按完整 image ID 加 hardening flags 运行。镜像内 runtime marker 只是误用防护，不是镜像身份证明；宿主机 runner 的核对不可省略。

```bash
node packages/db/scripts/staging-maintenance-host.mjs build
```

5. 每次先在上述镜像内运行只读审计。脚本会先在只读事务内检查远端 migration、checksum、失败/回滚记录、RLS/ACL 和关键数据前置条件；默认严格模式要求 0 pending，并继续执行 live schema diff：

```bash
node packages/db/scripts/staging-maintenance-host.mjs audit
```

如果预期存在待发布 migration，迁移前审计必须显式使用 `--allow-pending`：

```bash
node packages/db/scripts/staging-maintenance-host.mjs audit --allow-pending
```

该模式只接受“远端已应用 migration 严格匹配本地前缀、pending 为连续本地尾部”；unknown、乱序、checksum 不一致、unfinished、rolled back、RLS/ACL 失配或同一店铺非空 `platform_product_id` 重复都会失败。Prisma `migrate status` 只有在精确返回同一 pending 清单时才允许退出 1；输出会列出 `pendingNames`，并将 datamodel schema diff 标为 `deferred`，不能作为 schema 已一致或 migration 已完成的证据。

默认严格审计通过且输出 `Database schema is up to date!`、`No difference detected.` 时，**不要再运行 `migrate deploy`**。

6. 只有出现 pending migration 时，才进入受控迁移流程：
   1. 停止 BFF、队列和全部 worker 写入，记录 Git SHA、审计输出和维护窗口。
   2. 确认 Supabase 当前套餐的快照/PITR 能力；如果不能恢复，在停写后使用下方 `staging-libpq.mjs backup` 通过强制 TLS 的 `DIRECT_URL` 创建 PostgreSQL 17 custom format、仅 public schema、不包含 owner/privileges 的最终一致性备份。
   3. `staging-libpq.mjs backup` 会先用 PostgreSQL 17 `pg_restore --list` 校验 TOC、关键 schema/data 对象、文件权限和 SHA256；该结果仍不能替代恢复，必须再把归档恢复到隔离 PostgreSQL 17 数据库完成演练。
   4. 使用下方固定的本机 Docker 路径创建名称以 `supplier_restore_` 开头的专用空数据库，再创建不入 Git 且权限恰为 `0600` 的 `packages/db/.env.restore.local`；`DATABASE_URL` 和 `DIRECT_URL` 必须使用同一密码并指向同一个数值 loopback（`127.0.0.1` 或 `::1`）目标，不接受可被名称解析覆盖的 `localhost`，完整 URL 使用单引号包住并仅由 Node `--env-file` 读取。禁止 SSH、socat、kubectl 或其他通用端口转发。`restore-rehearsal.mjs rehearse` 会清空 `DOCKER_HOST` / `DOCKER_CONTEXT` 影响，先固定当前 Docker context 的名称和本机 Unix-socket endpoint，后续每次都按该名称复核 endpoint，并为 image/container inspect 显式传入 `--context`；同时按 `--confirm-container` 核对运行中且 `--rm` 的容器、固定 PostgreSQL 17 image ID、默认 entrypoint、精确数据库标签、唯一数值-loopback 端口映射和无持久 volume 的 tmpfs 数据目录。连接后还会要求服务端确为 PostgreSQL 17、`data_directory` 精确为 `/var/lib/postgresql/data`、数据库名精确匹配且 restore 前没有用户对象。首次检查后固定完整 container ID，随后在同一进程的角色初始化、restore、迁移、status、diff 和每条断言前都按完整 ID 复核，拒绝名称重用。归档会以 `O_NOFOLLOW` 打开并通过 fd 确认为普通文件，再复制到进程私有、权限精确为 `0600` 的临时文件并绑定 SHA256；`pg_restore --list` 和正式 restore 分别使用 fresh fd 与 `/dev/fd/3`，不会再次信任原始路径，退出时删除副本并关闭原始 fd。迁移前必须把恢复库 `_prisma_migrations` 的前 33 条记录按应用顺序逐条与当前仓库 SQL 计算出的名称和 checksum 比较，并要求 `applied_steps_count=1`、finished、未 rollback；本地目录还必须保持精确 33→43 边界和既定第 34～43 个尾部。Prisma 使用仓库内固定 CLI/schema、固定仓库根目录 cwd 和 helper 重建的最小子环境，不继承 ambient `DATABASE_URL` / `DIRECT_URL`、`PG*`、`NODE_*`、`DOCKER_*` 或其他 Prisma 覆盖项。只有整条 `rehearse` 通过，才允许对 staging 执行一次受控 `migrate-once`。第 36 个 migration 还必须预查同一 `shop_id` 下非空 `platform_product_id` 没有重复；应用第 36～43 个后核对 `published_products.mutation_revision`、`sku_price_snapshot`、`price_synced_at`、`sku_inventory_snapshot`、`product_batch_tasks.state_revision`、两张 `product_batch_*` 表、`source_import_tasks`、`source_import_items`、`user_source_products`、`published_product_source_bindings`、两张 `exception_*` 表和四张 `after_sale_*` 表的唯一索引、复合租户/订单外键、生命周期与事件 CHECK、RLS 及表/sequence 权限。隔离库必须证明 43/43、schema diff 为空，一单一工单、工单/子单/采购同订单及 UUID 命令唯一键均生效，并通过第 43 个 migration 对三个 NULL/UNKNOWN 绕过的回滚式负向探针。
   5. 如果最终只读审计仍报告 `mockSupplierIdBackfillRequired=true`，必须在 migration 前使用专用脚本；默认模式只读检查，写模式要求显式 `--apply`、精确 project ref、33/43、最新第 33 个 migration、binding 表不存在、十个 mock 集合与现有元数据全部匹配。检查和写入都只接受指向 `postgres` 数据库的 5432 session `DIRECT_URL`，并从该 URL 重建下述固定 CA 严格 TLS datasource，不使用 pooler `DATABASE_URL` 中可能存在的弱 TLS 参数。它只更新空白 `supplier_id` 并在同一事务回读；禁止运行通用 `scripts/seed.mjs`。

```bash
# 将绝对路径和 Project Ref 替换为本次维护窗口的实际值。
(
set -euo pipefail

node --env-file=packages/db/.env.staging.local \
  packages/db/scripts/staging-libpq.mjs backup \
  --output=/absolute/path/to/supplier-staging-pre-migration.dump \
  --confirm-project=YOUR_20_CHAR_PROJECT_REF

# 创建不入 Git 的 packages/db/.env.restore.container.local，内容仅为：
# POSTGRES_PASSWORD=<本次一次性随机密码>
# POSTGRES_DB=supplier_restore_20260806
# packages/db/.env.restore.local 的两个 URL 使用同一密码，并都指向
# 127.0.0.1:55432/supplier_restore_20260806。
chmod 600 packages/db/.env.restore.container.local packages/db/.env.restore.local

# 清除可覆盖目标的 Docker 环境变量，固定当前 context，并先验证其为本机 Unix socket。
restore_docker_context="$(
  env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_CONFIG \
    /opt/homebrew/bin/docker context show
)"
restore_docker_endpoint="$(
  env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_CONFIG \
    /opt/homebrew/bin/docker context inspect "$restore_docker_context" \
    --format '{{.Endpoints.docker.Host}}'
)"
case "$restore_docker_endpoint" in
  unix:///*) ;;
  *) echo 'Refusing non-Unix Docker context.' >&2; exit 1 ;;
esac

env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_CONFIG \
  /opt/homebrew/bin/docker --context "$restore_docker_context" \
  image inspect postgres:17-alpine --format '{{.Id}}'
# 必须得到：sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193

if env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_CONFIG \
  /opt/homebrew/bin/docker --context "$restore_docker_context" \
  container inspect supplier-restore-rehearsal-pg17 >/dev/null 2>&1; then
  echo 'Refusing to replace an existing restore container.' >&2
  exit 1
fi

restore_container_started=0
restore_cleanup() {
  if [[ "$restore_container_started" == 1 ]]; then
    if env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_CONFIG \
      /opt/homebrew/bin/docker --context "$restore_docker_context" \
      stop --timeout 10 supplier-restore-rehearsal-pg17 >/dev/null 2>&1; then
      restore_container_started=0
    fi
  fi
}
trap restore_cleanup EXIT
trap 'exit 130' INT TERM

env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_CONFIG \
  /opt/homebrew/bin/docker --context "$restore_docker_context" run --rm -d \
  --name supplier-restore-rehearsal-pg17 \
  --label com.supplier.restore-database=supplier_restore_20260806 \
  -p 127.0.0.1:55432:5432 \
  --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=256m \
  --env-file packages/db/.env.restore.container.local \
  postgres:17-alpine
restore_container_started=1

restore_ready=0
for restore_attempt in {1..30}; do
  if env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_CONFIG \
    /opt/homebrew/bin/docker --context "$restore_docker_context" \
    exec supplier-restore-rehearsal-pg17 \
    pg_isready -U postgres -d supplier_restore_20260806 >/dev/null 2>&1; then
    restore_ready=1
    break
  fi
  sleep 1
done
[[ "$restore_ready" == 1 ]] || { echo 'PostgreSQL 17 did not become ready.' >&2; exit 1; }

node --env-file=packages/db/.env.restore.local \
  packages/db/scripts/restore-rehearsal.mjs rehearse \
  --archive=/absolute/path/to/supplier-staging-pre-migration.dump \
  --confirm-database=supplier_restore_20260806 \
  --confirm-container=supplier-restore-rehearsal-pg17

restore_cleanup
restore_removed=0
for restore_attempt in {1..30}; do
  if ! env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_CONFIG \
    /opt/homebrew/bin/docker --context "$restore_docker_context" \
    container inspect supplier-restore-rehearsal-pg17 >/dev/null 2>&1; then
    restore_removed=1
    break
  fi
  sleep 1
done
[[ "$restore_removed" == 1 ]] || { echo 'Restore container removal was not confirmed.' >&2; exit 1; }
trap - EXIT INT TERM
)
```

`staging-libpq.mjs` 的宿主机 libpq 子命令固定使用 Dashboard 提供的公开 `Supabase Root 2021 CA`（仓库路径 `infra/postgres/certs/supabase-prod-ca-2021.crt`）和 `verify-full`，同时校验 CA 与 hostname；证书 SHA256 指纹为 `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`，有效期至 2031-04-26。Prisma 5.22 的受控 datasource（audit、backfill 与 migrate-once）使用同一 CA 文件，并固定为 Quaint 支持的 `sslmode=require`、`sslcert=<CA>`、`sslaccept=strict` 组合；缺少 `sslaccept=strict` 会退化为接受无效服务端证书，明确禁止使用 `accept_invalid_certs`。证书轮换必须从 Dashboard 重新下载并同步更新指纹测试，不能去掉 CA 校验或退回原始 URL 中可能存在的弱 TLS 参数。

2026-08-06 维护前真实只读检查发现 macOS/Darwin Prisma 5.22 native-tls 即使分别固定已验证的 Supabase root、intermediate 或当前 pooler leaf，仍在事务开始前返回 P1011 `The certificate was not trusted`；没有发生写入。同一 pooler 的服务端链与 hostname 已由 OpenSSL 使用仓库 root 验证为 OK，同一 root 和 strict datasource 在 Linux Prisma Client 只读事务及 schema-engine `migrate status` 均成功，后者精确报告第 34～43 个 pending migration。因此 staging Prisma 操作统一进入上述 immutable Linux maintenance image；宿主机 Darwin 直接执行会在联网前 fail-closed，不能通过关闭证书验证绕过。

`restore-rehearsal.mjs rehearse` 会在恢复前执行幂等的角色初始化，模拟 Supabase 在 application migration 前已存在的 `anon` / `authenticated` 角色，并在同一进程内完成固定的 Prisma 迁移、status、diff 和三条升级后断言；任何一步失败都不得拼接其他容器或数据库的结果。隔离库还必须用发布前记录的表级行数和关键业务断言核对恢复结果。不要在普通 PostgreSQL 隔离库运行 `audit-staging.mjs`：该脚本刻意只接受同一个 Supabase project 的 pooler/direct host，用于防止把 staging 审计误连到其他数据库。

两种 `post-upgrade-assert` 都只允许运行仓库内固定的三条断言：schema isolation 和升级数据断言强制只读；工作流约束负向探针需要创建临时表，因此使用受控 read-write 会话，但脚本只写临时表并以 `ROLLBACK` 结束，不修改业务表。

```bash
node packages/db/scripts/staging-maintenance-host.mjs backfill-check

# 仅在上一步显示 pendingUpdates=10 且本次维护授权明确包含 backfill 时执行；
# 将 YOUR_20_CHAR_PROJECT_REF 替换为控制台中的实际 Project Ref。
node packages/db/scripts/staging-maintenance-host.mjs backfill-apply \
  --confirm-project=YOUR_20_CHAR_PROJECT_REF

node packages/db/scripts/staging-maintenance-host.mjs backfill-check

node packages/db/scripts/staging-maintenance-host.mjs audit --allow-pending

node packages/db/scripts/staging-maintenance-host.mjs migrate-once \
  --confirm-project=YOUR_20_CHAR_PROJECT_REF

node --env-file=packages/db/.env.staging.local \
  packages/db/scripts/staging-libpq.mjs post-upgrade-assert \
  --confirm-project=YOUR_20_CHAR_PROJECT_REF

node packages/db/scripts/staging-maintenance-host.mjs audit
```

`migrate-once` 不继承 shell 中的数据库或 libpq 环境，只接受指向 `postgres` 数据库且使用 5432 session 端口的 `DIRECT_URL`，并从已经通过 Project Ref 与 Supabase host 校验的值重建唯一的严格 TLS datasource。audit、backfill 和 migrate-once 都会在联网前验证自己位于带完整 Git SHA marker 的 Linux maintenance runtime；该 marker 仍不能替代宿主机对 clean SHA、完整 image ID、revision label 和用户的核对。每次 Prisma 子进程启动前，migrate-once 还会 fail-closed 检查 Prisma 可能自动加载的仓库根 `.env`、仓库根 `prisma/.env`、`packages/db/.env`、`packages/db/prisma/.env`：镜像中这些文件应不存在；如存在则必须是非 symlink 的普通文件且只能赋值 `DATABASE_URL` / `DIRECT_URL`。随后脚本在最小子进程环境中执行完整只读审计，要求 Prisma status 精确报告第 34～43 个 migration，再用固定 Prisma CLI、schema、argv 和超时执行 deploy，并复核 migration status。审计、status、deploy 是分进程快照，不能消除其间的并发数据库变化；维护窗口必须先停止 BFF、队列和全部 worker，并确保只有这一个 `migrate-once` 执行器，任何门禁失败都不得继续写入或并行重试。

禁止在 staging 使用 `pnpm db:migrate` / `prisma migrate dev`、`prisma migrate reset`，也禁止手工修改 `_prisma_migrations`。已成功但有逻辑问题的 migration 只能通过新的 corrective migration 前向修复；快照恢复必须先恢复到隔离库验证，不能直接覆盖 staging。

7. 在 Storage 创建公开读取的 `supplier-assets` Bucket，并完成上传、公开读取和删除 smoke。
8. Auth 暂时关闭公开注册；稳定 Web URL 确定后再配置 Site URL、Redirect URLs 并邀请内部测试账号。使用公开 Web 配置重复验证服务端门禁：

```bash
pnpm audit:supabase-boundary
```

验证器固定读取当前用户所有、权限恰为 `0600` 的 `apps/web/.env.staging.local`，不接受 shell 中残留变量覆盖目标项目或 Key。legacy anon JWT 使用 `apikey` 与 Bearer；新式 Publishable Key 只发送 `apikey`。

完成标准：仓库 migration 全部 applied，0 unfinished、0 rolled back、checksum 全匹配，live schema diff 为空。BFF/Redis readiness 属于下一节环境 smoke，不作为数据库审计的循环前置条件。

2026-08-03 的旧基线审计确认当时 staging 为 PostgreSQL 17.6、33/33 migration applied、0 unfinished、0 rolled back、checksum 全匹配且 live schema diff 为空；28/28 public 表启用 RLS，anon/authenticated 对表和 26 个 sequence 均无权限。2026-08-06 维护前的实时只读预检确认当时 staging 为 33/43，第 34～43 个是连续 pending 尾部，已应用前缀 checksum、unfinished/rolled back、RLS/ACL 与同店铺非空 `platform_product_id` 重复前置条件全部通过；因存在 pending，当时的 datamodel schema diff 按规则标记 `deferred`。维护前取得的 150265 bytes staging 真实数据一致性备份（SHA256 `b4eb1f374c75f5aa6244568443143394628b9a252dfbad3114473ae9d2e6fc54`）已在隔离临时 PostgreSQL 17 数据库完成 33→43 恢复升级，43/43、schema diff 无差异、数据量为 10 条货源/0 条铺货/0 条订单/0 条采购、41/41 public 表 RLS，以及 ACL、工作流约束和升级数据断言全部通过。以上 33/43 内容是维护前历史快照，不代表当前状态。

2026-08-06 维护窗口已完成。停写后的最终备份为 150239 bytes，SHA256 `c482ea5387c9fb6b5bb70ea1b8704af0ceacbae9161d820435d591d4ba39c30c`；十条 `mock-1001`～`mock-1010` 货源的确定性 `supplierId` 已定向回填并回读。单一 `migrate-once` 执行器已应用第 34～43 个 migration，最终审计为 43/43、checksum 全匹配、schema diff matched、41/41 public 表启用 RLS，`anon` / `authenticated` 的表、sequence 与 default ACL 均为 0。当前候选随后完成重部署，Cloudflare Web 与 Gateway 均返回 200，部署验收 18/18；新式 `sb_secret_*` / `sb_publishable_*` 复验通过，Legacy API keys 已禁用，旧 HS256 signing key 已 revoked，撤销后复验继续通过。真实邀请账号的登录与找回密码仍待测试邮箱；抖店、1688、LLM 和图片服务尚未配置，全部自动化开关保持关闭。完整脱敏记录见 [2026-08-06 staging 维护窗口证据](./evidence/2026-08-06-staging-maintenance-window.md)。

2026-08-05 又用 `staging-libpq.mjs` 对真实 staging 完成一次只读工具链预检：PostgreSQL 17.10 在 `verify-full` 下通过官方 CA 连接 PostgreSQL 17.6，生成 150239 bytes、权限 `0600`、365 个有效 TOC 条目的 custom archive，SHA256 为 `a325f82ddb2e9d1815de9860bab99c46ce7ba01e1692cb3eae5a95ceec21be98`，且原子发布后无 partial 残留。该文件仅证明备份入口真实可执行，不是维护停写后的最终备份，也未替代上述隔离恢复演练。

2026-08-06 又以该 150239 bytes 预检归档验证当时的分步 `restore-rehearsal.mjs` PostgreSQL 17 Docker 路径：通过宿主机 `127.0.0.1` 端口转发恢复全部 365 个 TOC 条目，顺序应用第 34～43 个 migration 后得到 43/43、`Database schema is up to date!`、`No difference detected.`，三组 post-upgrade assertions 全部通过；一次性容器随后删除。脱敏的输入、镜像 digest、执行顺序、结果和清理证据见 [2026-08-06 本地 PG17 恢复演练](./evidence/2026-08-06-local-pg17-restore-rehearsal.md)。该证据证明真实归档和 Docker 路径可用，但早于当前把恢复、迁移与断言绑定到同一完整 container ID 的单进程 `rehearse`。

同日随后使用当前单进程 `rehearse` 对同一归档重新完成真实本地 PostgreSQL 17 复验：私有 `0600` 归档快照、两次 fresh FD custom-format restore、精确 33 条 migration manifest、固定 Docker context/完整 container ID、deploy/status/diff 与三条断言全部通过，结果为 365 个 TOC、3 个 Prisma checks、3 条 assertions；一次性容器已确认删除。证据见 [2026-08-06 单进程 PG17 恢复演练](./evidence/2026-08-06-integrated-local-pg17-restore-rehearsal.md)。两次本地演练都不是维护停写后的最终备份与最终恢复复验，也没有写入 staging。

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

Web 与 gateway 的 Wrangler 配置必须固定到同一个 Cloudflare account，避免本机同时登录多个 account 时把 dry-run、Secret 更新或部署发到错误账号。进程守护仍显式要求同一 `CLOUDFLARE_ACCOUNT_ID`，不能依赖交互式账号选择。

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

   2026-08-06 本次轮换是一次经明确授权的执行例外：当时尚无可用于真实会话 smoke 的已验收内部测试账号，在新式 Secret/Publishable、Auth admin、Storage、公开边界和 18/18 部署验证通过后，Legacy API keys 已禁用，旧 HS256 signing key 已 revoked，并再次通过同组验证。该结果证明新 Key 与部署边界可用，但**不等于真实 Auth 会话前置已通过**；管理员邀请、收信、设密、登录、refresh、logout、找回密码回跳和旧密码失效仍须使用测试邮箱补验。后续轮换继续遵守上一条完整标准顺序，不得以本次例外降低门禁。

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

验证器把 Supabase 项目和 BFF 固定到当前 staging 公开 origin，依次检查密码登录、有效 JWT 访问、refresh token 换新会话、刷新后 JWT 访问、GoTrue 登出、刚刷新得到的 refresh token 再换会话必须返回 400/401，以及无 Token 访问 401；全程不输出邮箱、密码、Token 或响应正文。password/refresh grant 的非 200 响应如包含 access token，会先登记并尝试注销；若请求超时、网络失败、5xx 无可读 Token，或注销后的 refresh 探针结果不确定，命令会明确报告会话清理未证明。此时不要直接重跑；先在 Supabase Auth 中核对并撤销该专用测试账号的全部可疑会话，确认原请求已经终止后再验收。

8. 在浏览器触发忘记密码，核对邮件和稳定 Web 回跳，并设置一个不同的新密码。随后把旧密码写入 `AUTH_TEST_PREVIOUS_PASSWORD`，把 `AUTH_TEST_PASSWORD` 更新为新密码，执行：

   ```bash
   pnpm audit:supabase-auth-password-transition
   ```

   转换验收先要求旧密码返回 400/401，再完整验证新密码会话；429、5xx、超时或网络错误都不能当作“旧密码已失效”。旧密码若意外成功，脚本仅清理该会话并失败，不继续新密码链路。脚本不会发送恢复邮件、点击链接或修改密码，不能替代浏览器验收。完成后立即从文件移除 `AUTH_TEST_EMAIL`、`AUTH_TEST_PASSWORD` 和 `AUTH_TEST_PREVIOUS_PASSWORD`。

9. 再通过同一受控邀请流程准备第二个**专用测试账号**，两个账号和目标货源在整个验收窗口内都不得被浏览器、其他脚本或操作员并发使用；验证器的 logout 可能使同账号的其他 refresh 会话失效。两个账号都完成设密后，在 `apps/web/.env.staging.local` 临时加入两组凭证和一个专用于本次验收、双方都未收藏的现有货源编号：

   ```env
   AUTH_TENANT_A_EMAIL=replace-with-first-test-account
   AUTH_TENANT_A_PASSWORD=replace-with-first-test-password
   AUTH_TENANT_B_EMAIL=replace-with-second-test-account
   AUTH_TENANT_B_PASSWORD=replace-with-second-test-password
   AUTH_TENANT_TEST_PRODUCT_ID=replace-with-existing-product-id
   ```

   随后执行：

   ```bash
   pnpm audit:supabase-tenant-isolation
   ```

   验证器把 Supabase 项目和 BFF 固定到当前 staging 公开 origin，要求两个 Supabase 用户 ID 不同，并在任何写入前确认双方都没有收藏该商品；若已有收藏或无法证明初始为空，会停止且不删除预检时已有的数据。预检通过后，它依次验证 A 收藏仅 A 可见、删除后双方不可见，再对 B 做对称验证。该保护无法识别预检后的并发人工收藏，因此专用账号、专用货源和停写窗口是强制条件。

   PUT 发生超时、网络错误、非 200 或其他不确定结果时绝不重试；脚本仍会执行双账号 DELETE、回读、logout 和 refresh token 失效检查，但迟到的服务端提交可能发生在即时回读之后，所以这条路径只算 best-effort 补偿，最终必须明确失败并报告清理未证明。客户端等待超过自身 timeout 也不是服务端完成栅栏；先从 BFF 请求日志或等价运行证据确认原请求已经终止，无法确认时保持失败且不要重跑。请求确认排空后，再分别登录两个账号人工移除该测试收藏，并在静默窗口后重复回读，确认无残留后才能重新验收。普通成功路径也会做最终双删除和回读，任一补偿或注销无法证明都会失败。输出不包含邮箱、密码、Key、Token、用户 ID、商品编号或响应正文。

   该验收动态证明两个当前 JWT 会话使用不同 Supabase 用户且 Favorites 双向不可见；它不单独证明刷新前后稳定的 `sub → 内部用户` 映射，也不能替代订单、异常中心、售后等业务域的双租户 E2E。完成后立即移除上述五个临时变量。

10. 确认无 Token 请求业务 API 返回 401，伪造 `x-user-id` 不生效。
11. `/api/operations/*` 只接受独立 `OPERATIONS_TOKEN`。

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

截至 2026-08-07，R0-02 已完成定向回填、43/43 migration、schema 与权限复核及停写后的最终备份。`dd648f1` shadcn Web 候选已部署为 Cloudflare 版本 `3c75d6ea-5444-49c2-ac50-47e2ff3990f4`，固定 Web/Gateway 和部署 smoke 已复验；R0-03 仍因真实邮箱 Auth 流程和外部平台依赖未完成而保持进行中：

当前候选的固定 Gateway + 固定 Cloudflare Web 通过 18 项部署验证，包括 live/ready、四个生产文档路由 404、三种鉴权拒绝、OAuth、运维状态/检查/指标、草稿 PUT/DELETE CORS 正向、恶意 Origin 负向 OPTIONS 和 Web 200。远端 Web URL 为 `https://supplier-staging-web.chenjie.workers.dev`，Web 与 Gateway 均返回 200；BFF 精确 CORS/OAuth 结果地址及 Supabase Site/Redirect URL 已回填。

- 2026-08-07 当前候选通过 1,249 项测试、15/15 typecheck、2/2 lint、9/9 build、生产依赖审计、Prisma、63 项运维脚本、7 项 Gateway、Prettier、diff check 与 Cloudflare 无 binding dry-run；[Release gates #32](https://github.com/harzss/supplier/actions/runs/31139134369) 的 verify/browser/images 全绿。部署前发现 2026-08-06 的孤儿 BFF 仍以 `ppid=1` 占用 3001，SIGTERM 无效后只终止已核验的精确 PID；launchd 随后用当前构建接管、刷新 Quick Tunnel 与 Gateway，最终本机和固定 Gateway live/ready 均为 200。远端首页与本地静态产物 SHA256 同为 `ee6ed0a1ab856b4e2736bc3cae9688eca1a3cdd5830a1fa58306db7aa0894328`，主要路由、旧商品 URL 301 和废弃 prototype 404 通过。完整记录见 [2026-08-07 shadcn staging Web release](./evidence/2026-08-07-shadcn-staging-web-release.md)。

- 初版 OpenNext 版本 `2cfa19b5-0b44-4081-a240-8c0737563922` 压缩上传为 953.71 KiB，但动态路由 CPU 实测 40ms，已被替换。2026-08-03 的历史静态版本 `7d15e88a-20bc-40c8-a255-4dae8dcd7e52` 包含 59 个纯静态 assets；当前候选已在 2026-08-06 重新部署并完成 Web/Gateway 200 与 18/18 复验。
- 新式 `sb_secret_*` / `sb_publishable_*` 已用于 Auth admin、随机 Storage 上传/公开读取/删除及公开访问边界复验；Legacy API keys 已禁用，旧 HS256 signing key 已 revoked，撤销后的同组验证和部署 smoke 继续通过。
- 操作员二次确认的单请求管理员邀请脚本及安全测试已完成；尚无真实邀请邮箱完成收信、设置密码、登录、刷新、受保护 API、退出、恢复邮件回跳和旧密码失效验收。
- Redis AOF / 命名卷与数据库队列已分别通过非空探针重启演练；探针均已清理，旧候选重启后本机与固定 Worker readiness 为 200。
- M80 历史候选的全仓 `pnpm test` 14/14 个任务共 1182 项（BFF 807、Web 99）、typecheck 15/15、lint 2/2、build 9/9、Prisma validate 与 `git diff --check` 已通过，`/after-sales` 已静态生成；这些历史代码门禁不替代 2026-08-06 的实际 staging 复验，也不替代尚未完成的真实平台 E2E。
- M82 历史候选修复了 CI demo seed 缺 `supplierId` 导致的 pricing-preview 400，并把部署验证从 15 项扩为 18 项；[GitHub Release gates #23](https://github.com/harzss/supplier/actions/runs/30910322944) 在提交 `a48fb43` 上完成 verify、browser、images 三个 job 全绿。该历史 CI 证据现已由 2026-08-06 当前 staging 的 43/43 migration、重部署和 18/18 真实入口复验补充。
- M83 维护前审计确认十条货源精确为 `mock-1001`～`mock-1010`，当时十条 `supplierId` 全部缺失。2026-08-06 已在最终备份后定向回填全部十条并回读，未运行会覆盖货源与评分的通用 seed；最终审计确认 mock 发布元数据可用。
- 旧候选 `8ddac05` 没有与 Git SHA 绑定的 BFF 镜像或动态回滚 smoke；更重要的是，它不会维护第 34～43 个 migration 对应的版本化货源绑定、发布幂等、价格/库存与订单成本快照、异常和售后语义，不能在迁移后恢复写流量。维护失败时保持停写并前向修复；不得把旧 BFF readiness 可能返回 200 当作安全回滚证据。
- 第 36～43 个批量经营、采集、版本化货源绑定、统一异常中心、售后工单与状态机约束加固 migration 已实际应用到 staging，`/published/batch`、`/sources`、`/exceptions`、`/after-sales` 等当前候选页面也已重部署。抖店、1688、LLM 和图片服务仍未配置，30 天订单历史回补、真实批量操作、六域异常和售后工单 E2E 尚未完成；相关自动化开关全部保持关闭，不能把“已部署”写成“真实平台闭环已验收”。
- `com.supplier.staging-local` LaunchAgent 已安装并运行，由 BFF / Quick Tunnel supervisor 守护当前内测链路；本机和固定 Gateway readiness 均为 200。Quick Tunnel 仍无 SLA，只适合内部验证；正式生产必须迁移到稳定 Tunnel、容器平台或等价的受监控托管服务。
- Vercel Hobby 只允许非商业个人验证，不作为公司商业内测的回退方案。

以上任一项未关闭时，不得把 R0-03 标记为完成，也不得用该 staging 证据宣称生产可用。
