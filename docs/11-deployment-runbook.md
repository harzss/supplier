# 11 · 部署与回滚手册

> 目标：以不可变镜像发布 BFF、Web 和数据库迁移，先验证再切流；应用可回滚，数据库只允许前向修复。本文不替代云厂商、数据库或 Redis 的灾备文档。
>
> **staging 执行快照（2026-08-06）**：维护窗口最终一致性备份为 150239 bytes，SHA256 `c482ea5387c9fb6b5bb70ea1b8704af0ceacbae9161d820435d591d4ba39c30c`；十条 mock `supplierId` 定向 backfill 已更新并回读，第 34～43 个 migration 已单次应用。最终状态为 43/43、schema diff matched、41/41 public 表 RLS，`anon` / `authenticated` 的表、sequence 和默认 ACL 暴露均为 0。当前 Web、BFF/Gateway、readiness 与 18/18 smoke 已通过；新式 Supabase Key 切换完成，旧 legacy HS256 Key 撤销后重复验证仍通过。该快照只证明 staging 内部部署，不证明真实 Auth 账号生命周期、抖店/1688 E2E 或生产发布完成。

## 1. 发布单元

每个 Git commit 构建三个使用同一 commit SHA 的镜像：

- `supplier-bff:<git-sha>`：NestJS BFF，运行用户为 `node`，提供 liveness/readiness。
- `supplier-web:<git-sha>`：Next.js standalone Web，运行用户为 `node`。
- `supplier-migrate:<git-sha>`：与 BFF 使用同一 Prisma schema 和 migration 集合，只执行 `prisma migrate deploy`。

禁止覆盖已发布 SHA tag。`latest`、环境名或版本别名只能作为指针，部署记录和回滚必须引用镜像 digest 或完整 SHA tag。

## 2. 发布前硬门禁

代码合并和构建镜像前执行：

```bash
make release-check
```

CI 还必须完成：

1. `pnpm audit:prod` 不存在 high/critical 生产依赖漏洞。
2. CodeQL security scan 通过且没有未处置的阻断级告警。
3. 构建 `bff`、`migrate`、`web` 三个 Docker target。
4. 在全新 PostgreSQL 和 Redis 上执行全部 migration。
5. 迁移镜像执行 `prisma migrate status`，并以 `migrate diff --exit-code` 确认 live schema 与同镜像 Prisma datamodel 无差异。
6. 启动 BFF/Web 并运行 `pnpm deploy:verify`。
7. 验证 BFF/Web 镜像用户为 `node`。
8. 发送 SIGTERM，确认两个容器退出码均为 `0`。

任何门禁失败都不得推送生产别名或进入切流步骤。

## 3. 配置与密钥

生产配置由部署平台或 Secret Manager 注入，不写入镜像、Git、CI 日志或 `.env` 文件制品。

BFF 至少需要：

- `NODE_ENV=production`
- `AUTH_MODE=supabase`
- `DATABASE_URL`、`REDIS_URL`
- `ENCRYPTION_KEY`
- `SUPABASE_URL`，旧 HS256 项目还需要 `SUPABASE_JWT_SECRET`
- 使用 Supabase Storage 时配置仅限服务端的 `SUPABASE_SERVICE_ROLE_KEY=sb_secret_*`；禁止复制到 Web 或日志
- `CORS_ORIGINS`
- `PUBLISH_QUEUE_MODE=database`
- `OPERATIONS_TOKEN`：至少 32 字符，必须与租户 Bearer token 分离
- `ALERT_WEBHOOK_URL`：HTTPS 告警接收地址
- `ALERT_WEBHOOK_SECRET`：至少 32 字符，用于 timestamp + HMAC-SHA256 签名
- `ALERT_WEBHOOK_MAX_ATTEMPTS`：默认 3，允许 1～5 次总尝试
- `ALERT_WEBHOOK_RETRY_BASE_MS`：默认 500ms，允许 100～5000ms 的指数退避基数
- `PRODUCT_BATCH_ENABLED`：批量商品执行 worker 总开关；新环境和首次发布必须先保持 `false`
- `PRODUCT_BATCH_POLL_MS`：默认 2000ms，允许 500～60000ms
- `PRODUCT_BATCH_MAX_ATTEMPTS`：默认 3，允许 1～10 次；只作用于 item 级失败，不得通过重跑整批覆盖成功项
- `SOURCE_IMPORT_ENABLED`：持久化 1688 货源采集 worker 总开关；新环境和首次发布必须先保持 `false`
- `EXCEPTION_CENTER_SCAN_ENABLED`：统一异常中心后台扫描总开关；第 41 个 migration、双租户和六域样本验收前保持 `false`，通过后生产必须显式设为 `true`
- `EXCEPTION_CENTER_SCAN_INTERVAL_MS` / `EXCEPTION_CENTER_SCAN_BATCH_SIZE`：默认 300000ms / 50 个活跃账号，合法范围分别为 60000～3600000 / 1～500
- `SOURCE_IMPORT_POLL_MS`：默认 2000ms，允许 500～60000ms
- `SOURCE_IMPORT_MAX_ATTEMPTS`：默认 3，允许 1～10 次；只重试失败 item，不得覆盖已成功采集结果
- `ALIBABA_1688_SOURCE_DATA_SCOPE`：只有用至少两个受控买家账号证明详情、分销价和库存不随账号变化后才能设置为 `global_offer`；生产开启货源采集时缺失或为其他值必须启动失败

`AUDIT_RETENTION_DAYS` 默认 180 天；告警监控周期、队列阈值、5xx 阈值、Webhook timeout 和重试参数应通过部署配置管理并记录变更。接收端必须校验 timestamp + HMAC-SHA256，并按签名 payload/header 中相同的 `deliveryId` 幂等去重。运维端点应同时使用网关来源限制和 `OPERATIONS_TOKEN`，不能只依赖 URL 隐蔽。

Web 的 `NEXT_PUBLIC_*` 会在构建时固化，必须为公开值：

- `NEXT_PUBLIC_AUTH_MODE=supabase`
- `NEXT_PUBLIC_BFF_URL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_*`

Supabase 新式 `sb_secret_*` / `sb_publishable_*` 只作为 `apikey` 发送；legacy JWT 才能兼容 `apikey` + Bearer。Secret rotation 应先让应用兼容两种格式，再切换 BFF Secret 与 Web Publishable Key、重建前端，确认 Auth/Storage/readiness 和业务验证后撤销旧凭证。

生产 Redis 还保存 `oauth:refresh-result:<shopId>` Token 轮换恢复记录：内容已由 `ENCRYPTION_KEY` 加密，TTL 24 小时。Redis 应启用持久化、监控和合适的内存/淘汰策略，发布或故障恢复时不得把该前缀当作普通缓存批量清除；否则平台已旋转 Token 而 PostgreSQL 尚未提交的极小窗口只能重新授权。

## 4. 标准发布流程

### 4.1 构建并推送不可变镜像

以下 `<registry>` 和 `<git-sha>` 由 CI 替换：

```bash
docker build --target bff -t <registry>/supplier-bff:<git-sha> .
docker build --target migrate -t <registry>/supplier-migrate:<git-sha> .
docker build --target web -t <registry>/supplier-web:<git-sha> \
  --build-arg NEXT_PUBLIC_AUTH_MODE=supabase \
  --build-arg NEXT_PUBLIC_BFF_URL=https://api.example.com \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://project.supabase.co \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=<sb_publishable-key> .
```

推送后记录三个镜像 digest、Git SHA、构建时间和发布负责人。

### 4.2 发布前数据库快照

在执行 migration 前创建数据库供应商的一致性快照或 PITR restore point，并记录：

- 快照/restore point 标识和时间；
- 当前应用 SHA；
- 当前 migration 列表；
- 恢复目标数据库和预计 RTO/RPO。

没有可恢复快照或 PITR 时，不执行包含数据重写、删除或不可逆约束变化的 migration。

### 4.3 migration-once

每次发布只由一个受控 Job 执行迁移。`DATABASE_URL` 和 `DIRECT_URL` 必须先由 CI 或 Secret Manager 安全导出到 Job 环境，不得把含凭据、query 或 `&` 的完整连接串直接拼入 shell 命令：

当前候选的最新必需 migration 为第 43 条 `20260805040000_harden_workflow_check_null_semantics`。第 36 条 `20260804050000_add_product_batch_operations` 新增 `published_products.mutation_revision`、`product_batch_tasks`、`product_batch_items` 和 `(shop_id, platform_product_id)` 唯一索引；第 37 条新增 `published_products.sku_price_snapshot` 与 `price_synced_at`，第 38 条新增 `sku_inventory_snapshot`；第 39 条新增 `source_import_tasks`、`source_import_items` 和 `user_source_products`；第 40 条新增 `published_product_source_bindings`，并为 `order_items` 增加绑定、单位成本和一件代发快照；第 41 条新增 `purchase_orders.exception_code`、`exception_cases` 与 `exception_case_events`；第 42 条新增 `after_sale_cases`、`after_sale_case_items`、`after_sale_purchase_links` 与 `after_sale_case_events`；第 43 条不修改既有 checksum，在事务内以严格布尔 CHECK 阻断异常事件、售后采购结果和售后事件的 NULL/UNKNOWN 绕过。隔离预检必须先确认所有非空 `platform_product_id` 在同一店铺内没有重复；第 36 个 migration 自身也会在建索引前 fail-closed。迁移后必须确认十二张新增任务/归属/绑定/异常/售后表均启用 RLS，`anon` / `authenticated` 对表和 sequence 都没有直接权限，直接核对价格与库存快照列类型分别为 `jsonb`、timestamp 和 `jsonb`，确认第 39 条 migration 的用户、买家店铺、货源商品、采集任务和用户货源外键及其删除策略，确认第 40 条为每个历史已发布商品生成且仅生成一个 revision 1 当前绑定、订单项快照外键/成本/一件代发字段与 migration 定义一致，并确认第 41 条旧采购异常回填仅依据持久状态。第 42 与 43 条还必须核对一单一工单唯一约束、工单/子单/采购关联的复合租户与订单外键、状态与事件迁移 CHECK、UUID 命令唯一键、三个 NULL 负向探针，以及四张售后表和四个 sequence 的 RLS/ACL。上述空库与隔离升级门禁均已通过；2026-08-06 实际 staging 也已完成单一 migration-once，并复核为 43/43、schema diff matched、41/41 RLS 和客户端 ACL 0。生产数据库仍必须在独立维护窗口重复同一流程，不能复用 staging 结果代替。

```bash
docker run --rm \
  -e DATABASE_URL \
  -e DIRECT_URL \
  <registry>/supplier-migrate:<git-sha>
```

不得让每个 BFF 副本在启动时自动迁移。迁移失败时停止发布，不启动新版本，不重复手工修改 `_prisma_migrations`。

### 4.4 启动候选版本并验证

先以不接生产流量的方式启动新 BFF/Web：

1. BFF `/api/health/live` 返回 200。
2. BFF `/api/health/ready` 返回 200，且 PostgreSQL 最新必需 migration、数据库连接与 Redis 均为 `up`。
3. Web `/` 返回 200。
4. BFF `/docs`、`/docs-json`、`/docs-yaml` 与 `/docs/swagger-ui.css` 均返回 404。
5. 无 token、无效 token、伪造 demo headers 访问受保护 API 均返回 401。
6. OAuth callback 不应被全局认证守卫改成 401。
7. `/api/operations/status` 无运维 token 返回 401；有效 token 下 status/check/alerts/metrics 返回 200。
8. Prometheus 文本包含请求、5xx、队列、活跃告警和审计失败指标。
9. 执行关键业务 smoke：真实测试账号登录、读取收藏/店铺、创建一条可清理的测试记录，并确认审计记录已落库且不包含 body、token、Cookie、密钥或原始 IP。
10. 首次启动保持 `PRODUCT_BATCH_ENABLED=false`：候选商品与持久化预览可以读取/创建，但确认执行必须明确返回 503，数据库不得出现 `queued/running` 批量 item；这证明开关关闭时不会产生平台副作用。
11. 在一次性测试窗口把开关改为 `true` 并重启候选 BFF，只对可清理的测试商品验收首个 `offline` 动作：预览不调用平台；确认后逐项推进；真实平台必须回读到下架才算成功；刷新页面可恢复任务；停止只取消未开始项；失败项重试不重跑成功项。验收后恢复 `false`，直到真实平台权限和运营窗口批准长期启用。
12. 首次启动同时保持 `SOURCE_IMPORT_ENABLED=false`：已有采集任务和“我的货源”允许只读，预览只解析官方 offerId 且不调用详情 API，确认执行必须返回 503；数据库不得出现新的 `queued/running` 采集 item。
13. 只有跨买家详情/分销价/库存口径、1688 方案配额、曝光回传和 Redis 限流均已验收，且配置 `ALIBABA_1688_SOURCE_DATA_SCOPE=global_offer` 后，才可在一次性窗口开启 `SOURCE_IMPORT_ENABLED=true`。用两个 Supabase 测试用户分别验证任务和“我的货源”隔离、刷新恢复、停止未开始项、单个失败项重试、同 UUID 同参恢复和异参冲突；任何一项失败立即恢复 `false`。
14. 保持 `EXCEPTION_CENTER_SCAN_ENABLED=false` 打开 Web `/exceptions`，用两个测试用户确认事项、计数与详情互不可见；注入可清理的发布/订单/采购/物流/售后/权益异常，验证六域刷新、单域失败保留、跟进确认不关闭来源、来源变化重新打开、权威恢复关闭和站内处理入口。订单域还要验证从未同步、水位陈旧、首次同步挂起、授权过期和启用店铺凭证缺失；新授权、近期首次同步和用户主动停用的 `revoked` 店铺不得产生噪音。物流回传成功后的平台回读失败必须保留 `purchasing` 并生成待核验事项，不能本地盲目标记已发货。上述样本通过后开启扫描 worker，验证有界账号轮转、单账号失败隔离和不重入，再将开关作为生产必需配置。
15. 打开 Web `/after-sales`，用两个测试用户验证工单、计数、销售子单、采购关联和时间线互不可见。以可清理的抖店部分退款、整单退款/关闭和 1688 已下单样本依次验证：订单刷新自动建立工单；认领后记录人工取消/退款退货/拦截及外部编号；同 UUID 同参恢复、异参冲突；采购或销售来源变化使旧确认失效并重开；超过 5 分钟的销售快照、未确认部分退款处置、未核对退款金额、未完成采购动作/异常核销/成本核销均阻止关闭；取得 5 分钟内平台回读并清除全部阻断后才能关闭。该步骤只验收运营在真实平台完成的人工动作与系统证据关联，不得把它描述为自动调用 1688 售后接口。

自动验证：

```bash
BFF_URL=https://candidate-api.example.com \
WEB_URL=https://candidate.example.com \
OPERATIONS_TOKEN=<operations-token> \
pnpm deploy:verify
```

### 4.5 切流与观察

只有 readiness 持续成功的实例才可加入负载均衡。先切少量流量，至少观察：

- 5xx、401/403 异常增幅和请求延迟；
- PostgreSQL/Redis 连接错误；
- publish queue backlog、重试和 dead job；
- `product_batch_tasks/items` 的 queued、running、retry_wait、failed 和 stale 数量；批量成功项不得因失败重试再次执行，running 超过 5 分钟应由 stale recovery 收敛；
- `source_import_tasks/items` 的 preview、queued、running、retry_wait、failed、cancelled 和 stale 数量；成功项不得因刷新或失败项重试再次读取详情，running 超过 5 分钟应由 stale recovery 收敛；
- `after_sale_cases` 的 open、handling、waiting_external、verifying、closed 与逾期数量；关闭工单不得仍有未核验采购动作、过期销售快照或未核销成本，来源/采购版本变化必须产生重开或新的阻断证据；
- 运行中 publish job 的 `locked_at` 应至少每 60 秒推进；停滞超过 5 分钟才应由 stale recovery 接管；
- 运行中 `order_logistics_repairs.locked_at` 也应每 60 秒推进；长时多包裹修复不应出现两个并发 lockId；
- Supabase JWKS/认证失败；
- 活跃 operational alerts、审计失败量与告警 Webhook 投递失败；
- 容器重启、OOM 和 readiness 抖动。

指标稳定后逐步完成切流。旧版本至少保留到观察窗口结束，且不得立即删除其镜像 digest。

## 5. 应用回滚

适用：新版本应用错误，但已执行的 migration 与旧应用向后兼容。

1. 停止继续切流和发布任务。
2. 将 `PRODUCT_BATCH_ENABLED=false` 并停止新批量确认；保留 `product_batch_tasks/items` 及已完成结果，不删除或整批重置。旧版本不会消费尚未完成的 item，恢复该功能前必须先核对逐项状态。
3. 将 `SOURCE_IMPORT_ENABLED=false` 并停止新采集确认；保留 `source_import_tasks/items`、`user_source_products` 和已经更新的全局货源快照。旧版本不会消费尚未完成的采集 item，恢复前必须核对逐项状态，不能把任务整批重置或把“我的货源”改写成收藏。
4. 将 BFF/Web 指向上一个已验证的 SHA/digest。
5. 等待旧版本 readiness 为 200 后切回流量。
6. 运行部署验证和关键业务 smoke。
7. 保留故障版本日志、指标、镜像 digest 和发布记录。

不重新运行旧版 migration，不执行 `prisma migrate reset`，不删除 `_prisma_migrations` 记录。

本次已经完成的 33→43 staging 窗口不满足上述“旧应用向后兼容”前提。最后一个有旧环境记录的 `8ddac05` 只要求第 33 个 migration，SQL 结构上可连接 43 schema，但不会维护第 34～43 个引入的发布请求幂等键、mutation revision、价格/库存快照、版本化货源 binding、订单冻结成本、异常和售后工单语义；第 40 个 migration 又只 backfill 迁移时已有数据。把它切回并恢复写流量会产生新语义空洞，因此不得作为可写回滚。本次维护按授权保持停写并只允许前向修复；同一规则继续适用于生产窗口。只有另行证明全局只读、任务已 drain 且旧版本有不可变产物与 smoke 后，才可把旧版本用于紧急只读查看；当前仍没有这样的资格化证据。

## 6. 数据库变更失败与前向修复

Prisma migration 按前向历史管理。已应用到任何共享环境的 migration 文件不得修改、改名或删除。

- migration 尚未应用：修正原 migration 后重新走完整门禁。
- migration 部分失败：停止切流，检查数据库实际状态和 Prisma migration 状态；创建明确的恢复方案后再处理。
- migration 已成功但逻辑有误：创建新的 corrective migration，恢复兼容列、索引、约束或数据，不回写旧 migration。
- 新 schema 与旧应用不兼容：优先部署兼容性修复版本；只有完成数据恢复评审后才能执行快照恢复。

推荐使用 expand/contract：先新增兼容结构并双读/双写，再迁移数据，最后在后续独立发布中删除旧结构。

## 7. 快照恢复边界

数据库快照恢复是最后手段，因为它可能回退快照后的真实订单、店铺授权、铺货任务和审计数据。

只有以下条件同时满足时才执行：

1. 应用回滚和前向修复无法恢复服务或数据正确性。
2. 已明确快照时间之后会丢失或需要补偿的数据范围。
3. 已暂停写流量、队列 worker、订单同步与自动代发。
4. 已由业务、技术和数据负责人确认 RPO/RTO 与补偿方案。
5. 优先恢复到隔离数据库完成校验，再决定切换生产连接或定向修复。

恢复后必须重跑 migration status、readiness、部署验证、身份隔离和订单/铺货一致性检查。

## 8. 发布记录与演练

每次生产发布记录：Git SHA、镜像 digest、migration、快照标识、配置版本、切流时间、验证结果、回滚目标和负责人。

至少按固定周期演练：

- 上一版本应用回滚；
- migration Job 失败时停止发布；
- Redis/PostgreSQL 不可用时 readiness 摘流；
- dead job、队列积压、5xx 激增、凭证异常的告警触发、升级、重通知与自动 resolved；
- 告警接收端不可用、签名错误和通知渠道失效时的值守与补偿流程；
- 从快照或 PITR 恢复到隔离环境并核对关键业务数据。

M20 时点的候选曾使用标准 Dockerfile 验证本地全新 PostgreSQL 15/Redis 7、当时全部 14 个 migration、BFF/migrate/Web 镜像、非 root uid 1000、12 项部署 smoke 与 SIGTERM exit 0；当时数据库状态最新且 schema diff 为空，镜像中的 `/api/operations/check` 已实测 200，抖店订单同步 worker 的生产配置门禁和启动路径也已复验。告警可靠性加固后的 `m20-current` 三镜像再次通过同范围验证，并确认非法重试次数配置 exit 1、合法配置 ready 200。真实 Supabase 也曾在 PostgreSQL 17 一致性逻辑备份和事务回滚预演后应用当时全部 14 个 migration。以上均是历史快照，不是当前 43 个 migration 候选的镜像或部署证据；云端镜像仓库、编排平台、生产 Redis、真实域名切流、外部告警接收/监控平台和备份恢复演练仍需在目标环境完成。

以上是 M20 时点的已验证快照。2026-07-22 只读查询确认当时仓库有 32 个 migration，现 staging Supabase 当时仍有 18 个待应用，范围为 `20260720120000_add_inventory_sync`～`20260722091000_add_order_logistics_repairs`；当时只有 30 条货源、6 条铺货、3 条订单和 3 条采购，没有未完成 migration 记录，待新增的 `published_products(task_id, shop_id)` 唯一索引重复组为 0。该段仅保留历史迁移证据，不能作为当前状态。

2026-08-03 审计快照确认 staging 为 PostgreSQL 17.6、当时仓库 33/33 migration applied、0 unfinished、0 rolled back，远端 checksum 与仓库 migration 全匹配，live schema 与 Prisma datamodel 无差异；最新已应用 migration 为 `20260803173000_secure_supabase_public_schema`，28/28 public 表启用 RLS，anon/authenticated 对表和 sequence 均无权限。当时为 10 条货源、0 条铺货、0 条订单和 0 条采购，恢复键重复组为 0。安全 migration 前的一致性归档已在隔离 PostgreSQL 17 中完成恢复演练，归档 142614 bytes，SHA256 为 `d77d1b618d8ecdc06dbc9bfd6bcb6cbc2828cc6f7316846a17273c8d9e71bcf3`。release-gates 已加入全新库 migration status、live schema diff、Supabase 角色初始化、RLS/ACL 和工作流负向约束断言，并由 2026-08-03 的 [GitHub Actions #30811827585](https://github.com/harzss/supplier/actions/runs/30811827585) 在全新 Runner 上完成首次旧基线验证。随后维护前预检确认 33/43 与十个连续 pending，150265 bytes 的真实数据备份也已在隔离库完成 33→43 演练；这些历史证据现已由 2026-08-06 的实际 staging 维护结果取代。

2026-08-06 停写后创建最终 150239 bytes 一致性备份，SHA256 `c482ea5387c9fb6b5bb70ea1b8704af0ceacbae9161d820435d591d4ba39c30c`。专用事务精确补齐十条 mock `supplierId` 并回读；单一 Linux maintenance image 随后应用第 34～43 个 migration。维护后审计确认 43/43、schema diff matched、41/41 public 表 RLS，`anon` / `authenticated` 的表、sequence 与默认 ACL 暴露均为 0。当前 Web、BFF/Gateway、readiness 与 18/18 smoke 已通过；新式 Supabase Key 已生效，旧 legacy HS256 Key 撤销后重复验证仍通过。真实邀请账号、邮件/密码/refresh 生命周期、真实抖店与 1688 E2E、生产资源和生产切流均未由本次维护证明。

2026-08-04 M73 候选曾在临时 PostgreSQL 17 全新库一次应用当时全部 38/38 migration，`migrate status` 最新且 live schema → Prisma datamodel 无差异；`mutation_revision`、`state_revision`、两张 `product_batch_*` 表、唯一索引、`sku_price_snapshot`、`price_synced_at` 与 `sku_inventory_snapshot` 均存在，两张批量表和 `published_products` 均启用 RLS，anon/authenticated 对表与 sequence 的直接权限为 0。M78 随后在一次性 PostgreSQL 15 从空库应用当时全部 40/40 migration，并以带两种 SKU 成本的历史订单验证 revision 1 binding、order item 绑定/一件代发和 8.50/14.75 成本快照；新表 RLS 开启、anon/authenticated 无 SELECT，live schema → Prisma datamodel diff 为 `No difference detected`。M79 再从空库应用当时全部 41/41 migration，验证两张异常表 RLS、anon/authenticated 表与 sequence 权限均为 0、schema diff 为空，并用事务构造四类旧采购异常确认回填为售后暂停、可重试取消、物流人工复核和采购人工复核。M80 已在 PostgreSQL 15.18 空库完成 42/42 deploy/status、schema diff、21 CHECK、11 FK、19 索引、负向约束、41/41 public 表 RLS 与角色权限验证。M81 的第 43 个前向修复随后在一次性 PostgreSQL 15 完成 43/43、schema diff、三个 NULL 绕过负向探针、对应合法状态正向探针和 RLS/ACL 断言；全部临时资源均已删除。上述空库与隔离演练是 2026-08-06 实际 staging migration 的前置证据，不能替代未来生产数据库的独立迁移和复核。
