# 10 · 生产准备度

> 目标：区分“功能可演示”与“可承载真实商家数据和订单”。只有本页 P0 门禁全部通过，才能宣称生产可用。
> 本文档只负责上线硬门禁；产品优先级和执行状态以
> [00-roadmap.md](./00-roadmap.md) 为准，工程实现证据见
> [09-main-flow.md](./09-main-flow.md)。
>
> **时效说明（2026-08-04）**：现有 Supabase 项目已明确按 staging 管理。当前实时只读预检确认 staging 仍为 33/43（第 34～43 个为连续 pending 尾部），已应用前缀 checksum、unfinished/rolled back、RLS/ACL 与同店铺平台商品 ID 重复前置条件均通过；因存在 pending，当前 datamodel schema diff 按规则标记 deferred。staging 真实数据一致性备份为 150265 bytes，SHA256 `b4eb1f374c75f5aa6244568443143394628b9a252dfbad3114473ae9d2e6fc54`；隔离临时库已完成 33→43 恢复升级，43/43、schema diff 无差异、数据量 10/0/0/0、41/41 public 表 RLS，以及 ACL、约束和升级数据断言全部通过。第 34～43 个尚未实际应用到 staging，候选也尚未重部署；生产数据库仍必须独立核验。

## 1. 当前结论（治理与技术证据截至 2026-08-04）

**结论不变：当前不能宣称生产可用或直接正式上架。** 真实抖店与 1688 小额订单 E2E、生产数据库、生产 Redis、目标云部署、监控告警、恢复演练、服务市场商业生命周期和法务合规仍需关闭 P0 门禁。以下内容保留为 M13～M67 的工程历史证据，不能替代新的目标环境验收。

当前 staging 已完成数据库备份恢复、RLS、Storage、关闭公开注册、匿名访问拒绝、Cloudflare Worker、Redis AOF、BFF readiness、告警 firing/resolved 基础 smoke，以及 Redis / 数据库队列非空重启持久性实测；已部署旧候选的 Web 为 59 个纯静态 Cloudflare Assets，固定 URL、BFF CORS/OAuth、Supabase Site/Redirect 和 15/15 HTTPS 验收均通过，且没有可执行 Worker CPU 路径。新旧 Supabase Key 兼容和安全轮换/Auth 验收器已有代码证据，但尚未在 Dashboard 创建新 Key、重部署 Web/BFF、停用 legacy Key 或完成真实邀请账号生命周期；长期进程守护尚未获得安装授权，也尚未验收，因此 R0-03 保持进行中。当前 staging 证据和临时 Quick Tunnel 都不能当作生产部署证据。

R2-01 当前已有跨页首次铺货进度、利润试算、统一风险预检、服务端草稿、用户内请求幂等键和上下文绑定的 OAuth 安全回跳。回跳目标只接受站内相对地址并绑定进一次性 state；callback 只在 URL 携带短期一次性、用户绑定的结果 token，登录用户消费后才能读取成功、店铺或错误信息，跨用户、伪造和重放均拒绝。草稿恢复后强制重新试算/预检，多标签旧 generation 不能覆盖新草稿，重复点击和响应丢失恢复原任务。当前候选部署须应用第 34～43 个 migration（其中本能力数据结构依赖第 34/35 个）并重部署后才能进入 staging，且尚缺真实店 E2E 和 5 人无指导可用性验收，因此仍只属于应用侧进行中。

R2-02 当前有八个候选代码切片。M78 新增抖店离线安全换源：真实店必须具备可用的 30 天订单历史与新鲜同步水位，平台连续两次确认稳定离线后，应用才在事务内关闭旧采购绑定、创建带生效区间的新绑定并切换库存目标；历史订单按付款时间保留原 offer/spec/成本快照，新订单与库存任务跟随当前绑定。换源不调用平台 SKU、价格或上下架写接口，平台 SKU key 和离线状态保持不变。M77 的滞销安全下架与 M71～M76 的持久批量采集、上下架、标题、价格和库存切片继续保留最多 100 件物化预览、item 级状态、租户隔离、平台强回读与商品 revision 漂移保护。任意平台 SKU 编辑仍未实现；第 36～40 个 migration、双租户采集、真实 1688 配额/数据口径、30 天订单历史回补和真实抖店/1688 行为均尚未在 staging 验收，因此不能把八个切片写成 R2-02 完成或生产可用。

R2-03 当前已有统一异常中心应用侧候选。六个业务域独立扫描，单域读取失败时保留旧事项；扫描器与业务生产者事项分离，来源指纹变化会使旧确认失效并重新打开。订单域会识别从未同步、水位陈旧、首次同步挂起、授权失效和凭证缺失，并以同一店铺 dedupe 防止候选消失造成误关闭。有界后台 worker 可按活跃账号轮转，单实例防重入并隔离单账号失败；它默认关闭，必须在 migration 和真实隔离验收后显式开启。运营确认只表示已接手，只有权威来源恢复或平台回读成功才能关闭。Case 与 append-only event 同事务写入，actionHref 由服务端目录产生并由 Web 再次白名单过滤。它尚未应用 staging，也未使用真实双租户和六域异常样本验证，因此不能标记完成。

R2-05 当前已有售后工单基础闭环应用侧候选。订单同步与主动刷新会按权威销售售后快照建立或更新工单，关联销售子单和同订单的 1688 采购；运营可认领、记录人工取消/退款退货/拦截/认损/复核及外部编号，再确认结果。工作台可直接处理部分退款决策、退款金额确认、采购异常及最终成本核销；这些销售/采购权威写入与工单物化位于同一 Serializable 事务。状态、处理时限、append-only 事件、UUID 幂等、工单与采购 revision CAS、来源/采购语义变化失效重开和异常中心联动已有代码证据；健康巡检仅推进 `syncRevision` 时不会误重开已关闭工单。关闭前强制检查 5 分钟内销售平台回读、部分退款决策与金额、采购人工动作、异常和最终成本；存在阻断时不得关闭。生产身份还会在所有工单读取、命令和幂等回放中排除历史 `demo-*` 店铺。该能力不自动调用 1688 售后、退款或退货接口，且尚未应用 staging、部署或完成真实双租户和抖店/1688 E2E，因此只能标记为进行中的应用侧候选。

M80 的全仓 `pnpm test` 14/14 个任务共 1182 项（BFF 807、Web 99、DB 12、Platform SDK 166、Crawler 62、Entitlements 14、LLM 8、Scoring 14）证据保持有效。M81 新增第 43 个前向约束修复及升级后断言后，当前候选代码测试合计 1192/1192（其中 BFF 807/807、DB 22/22），一次性 PostgreSQL 15 已完成 43/43 deploy/status、live schema diff、三个回滚式负向探针与合法状态正向探针，并再次通过 public schema RLS/ACL 断言，临时资源已清理。M82 修复 CI seed 缺少供应商标识导致的 pricing-preview 400，并把部署验证扩为 PUT/DELETE CORS 正向与恶意 Origin 负向探针；合并后 `pnpm test` 1192/1192、运维测试 59/59、CORS 1/1、Chromium 1/1、lint 2/2、typecheck 15/15、BFF build、Prettier 与 `git diff --check` 通过。Release gates #22 的 verify 通过，但 browser 使用修复前 seed 失败、images 被跳过；当前候选仍缺新提交的远端三作业全绿证据。当前实时预检、真实数据备份及隔离 33→43 升级演练均已完成，但该证据不等于 staging 已迁移：staging 账面仍为 33/43。BFF、migration、Web 三个非 root Linux 镜像仍属于 R2-01 之前的已验证基线，本次新增代码尚未重建镜像、部署或应用 staging 第 34～43 个 migration；真实抖店/1688 E2E、真实异常/售后工单 E2E 和任意平台 SKU 编辑均未完成。以下 M13～M67 文字是按里程碑当时证据保留的历史账本，不能覆盖本节最新状态。

### M13～M67 历史账本（按记录当时理解）

核心业务和 M13～M18 生产基座保持通过。应用侧已进一步补齐抖店目录、类目属性、类目资质、已发布商品修正、真实平台状态同步、售后退款保护、部分退款剩余子单处置、实际退款金额核对、采购成本核销及集中财务待办闭环：真实商品创建后先进入待审核，本地不再把平台返回商品 ID 误判为已上线；运营可读取 `product.detail` 刷新审核/上下架状态，驳回后基于最新规则修正重提；采购和物流前会刷新子订单售后，部分退款可在严格安全条件下继续未退款商品；经营看板不会再用原金额统计未核对退款订单，也不会忽略退款/关闭后的采购损失；订单页可集中分页处理全部财务待办，积压会主动进入指标和分级告警；普通订单也已支持完整分页和销售店铺/状态筛选，不再静默截断或把数据库故障伪装为空列表；真实店铺可在保留历史业务数据的同时主动停用并清除本地 Token，刷新竞态不会将其重新激活；生产身份模式不能创建或执行演示店铺，历史演示店、订单和铺货商品也不会进入真实业务查询、经营/财务指标、告警或套餐额度；平台 AI 调用已改为先原子预占额度再回填实际成本，供应商已计费但数据库回填失败时不会静默漏记。当前按功能优先级暂不继续 Docker、镜像和部署工作；M21～M26 及类目相关新增 migration 尚未在目标 PostgreSQL 实际应用。**当前仍不可直接面向真实多租户商家上线**：尚未用真实抖店测试店完成目录、属性、资质、状态同步、修正重提、售后处置和退款金额交叉验收，也未用 1688 买家账号和小额订单完成采购、真实物流回传及采购退款成本核销；真实 Supabase Auth 邮件账号生命周期、生产 Redis/目标云部署与恢复演练、外部告警/监控以及法务合规也仍是 P0 门禁。

M36 已保证铺货任务/job 与 worker 状态迁移的事务一致性；M37 已为每个任务/店铺固化抖店外部商品编码，创建结果不确定或本地写入失败时可恢复同一平台商品。M21～M37 期间新增的业务 migration（含类目、售后财务和铺货恢复键）仍未应用到目标 PostgreSQL。当前优先验证功能闭环，不重新构建 Docker 镜像、不部署。

M38 已补齐 1688 采购结果恢复：稳定 `outOrderId` 可通过官方买家订单列表反查，只有唯一远端订单且商品快照一致才绑定；创建响应丢失、本地写入失败和并发重试不会再静默丢失已创建采购单。本里程碑无 schema 变更。

M39 已将抖店物流回传成功后的本地 shipped 更新改为带当前状态和售后条件的原子迁移；退款/售后状态并发抢先落库时重新刷新平台，不再被迟到更新覆盖。本里程碑无 schema 变更。

M40 已将库存 worker 的 execute/complete/fail 和人工重试绑定当前 attempts、lockedBy 及目标版本；stale recovery 或其他 worker 接管后，迟到结果不能覆盖新状态。本里程碑无 schema 变更。

M41 已要求采购后的平台子单集合与本地履约快照完全一致，且每个售后状态更新必须命中；不一致时单订单事务回滚且同步水位不推进。本里程碑无 schema 变更。

M42 已要求抖店订单列表和详情严格解析父订单与子单；异常父订单、空或异常子单、缺失稳定子单 ID 及重复子单 ID 均整批失败，避免不完整同步后推进水位。本里程碑无 schema 变更。

M43 已要求抖店订单金额、时间、子单数量与单价严格校验；不再把缺失值静默写成 0 元、1970 年或数量 1，异常在进入 BFF 前整批失败。本里程碑无 schema 变更。

M44 已要求 BFF 在写入整页订单前预校验全部平台状态；任一未知状态都会停止同步并保留成功水位，不再以跳过计数掩盖数据缺口。本里程碑无 schema 变更。

M45 已要求严格解析子单 `after_sale_info`；只有字段缺失时才按无售后处理，异常结构或非法状态值会整批失败，避免错误放行采购与物流。本里程碑无 schema 变更。

M46 已要求 1688 买家订单恢复和详情轮询严格校验非空商品明细、金额、数量、状态及唯一远端子单 ID；异常响应不会推进本地采购状态。本里程碑无 schema 变更。

M47 已要求每次 1688 付款/物流轮询在写入状态、成本和物流前核对远端订单 ID 与 `offerId/specId/quantity` 采购快照；错单或远端商品变化均 fail-closed。本里程碑无 schema 变更。

M48 已要求 1688 运单号在单次物流快照内唯一，并将每个采购单的状态/成本、陈旧运单清理和全部当前包裹映射收敛到一个数据库事务。本里程碑无 schema 变更。

M49 已要求严格区分物流 `orderEntryIds` 的缺失/空值与格式异常；只有缺失、`null`、空字符串或空数组时允许单包回退，malformed、重复或超长 ID 均 fail-closed。本里程碑无 schema 变更。

M50 已为每个 1688 采购单增加持久化 `syncRevision`；每次轮询先领取新世代，后续状态、成本和包裹事务都以该世代条件写入，迟到请求失去所有权后不再覆盖新快照。新增 migration `20260720235500_add_purchase_sync_revision`，尚未应用到目标 PostgreSQL。

M51 已严格区分物流承运商/状态字段的真实缺失与 malformed 值，并把采购摘要承运商容量从 32 字符统一扩展为 64 字符。新增 migration `20260720235600_expand_purchase_carrier`，尚未应用到目标 PostgreSQL。

M52 已在抖店物流回传前核对待履约销售项、采购项及包裹项的集合、归属与数量完全一致；退款排除项、跨采购单串包、额外项、缺项和非法数量均 fail-closed。本里程碑无 schema 变更。

M53 已要求 1688 采购状态单调推进：待付款、已付款、已发货、已收货不能被后续旧响应逆向覆盖，`failed` 终态不能自动恢复；远端取消/关闭仍可将进行中采购置为 `failed`。本里程碑无 schema 变更。

M54 已为采购异常增加 `exceptionRevision`：新的部分退款、整单退款或关闭事件都会递增修订号，人工核销 API 必须携带并条件匹配页面读取的版本，过期表单不能覆盖新事件。新增 migration `20260720235700_add_purchase_exception_revision`，尚未应用到目标 PostgreSQL。

M55 已把发货前被 1688 取消/关闭的采购单转为可重试人工待办；运营核对本次实际成本后，旧远端单号、状态、成本和处理依据写入 `purchase_order_attempts`，历史失败成本累加到经营口径，当前采购使用新的 `-rN` 外部单号并与销售订单一起原子恢复。重置同时递增 `syncRevision`，迟到轮询不能污染新尝试。新增 migration `20260720235800_add_purchase_retry_history`，尚未应用到目标 PostgreSQL。

M56 已区分抖店回传前的发货后异常与发货前取消：`everShipped` 为真时禁止创建替代采购；运营在 1688 处理物流后，旧包裹和订单项映射连同操作人、异常版本及说明写入 `purchase_order_recoveries`，再清空本地物流并仅恢复同一远端订单的严格轮询。未重新通过完整物流校验前不会回传抖店。新增 migration `20260720235900_add_purchase_logistics_recovery`，尚未应用到目标 PostgreSQL。

M57 已完成可配置的已履约采购后台巡检：仅扫描抖店已发货/收货、1688 曾产生物流且无未处理异常的采购单；正常同路由可更新签收状态，取消/关闭、物流消失或路由变化会保留原快照、转人工待办并产生 critical 告警，API/Token 故障产生 warning。每个采购单用持久化 `settledAuditNextAt` 控制下一次巡检并以条件更新防止多副本重复领取；未送达的人工告警会继续重试。`ALIBABA_1688_PURCHASE_AUDIT_ENABLED` 必须与真实采购开关同时启用，间隔和批量均有启动门禁。新增 migration `20260722090000_add_settled_purchase_audit_schedule`，尚未应用到目标 PostgreSQL。

M58 已补齐已发货订单的物流修复闭环：运营核对最终成本后，系统重新读取并严格校验 1688 订单、商品和包裹，以本地旧快照和目标快照幂等更新抖店物流，平台回读一致后才在单事务内归档旧包裹、替换本地快照并解决告警。修复任务持久化执行锁和目标快照；同一采购异常修订号数据库唯一，平台成功而本地提交失败时可安全重试。通用成本核销接口不能绕过该流程，订单页已提供专用操作入口。新增 migration `20260722091000_add_order_logistics_repairs`，尚未应用到目标 PostgreSQL。

M59 已补齐长时间订单同步的执行权保护：Redis 店铺锁不再只依赖固定 15 分钟 TTL，每页平台调用前后都以随机 token 原子续租；失去锁后在订单写入前停止，旧任务不会与接管任务并发回写售后快照。同步成功水位和失败状态仅允许当前 `orderSyncAttemptAt` 所有者更新，被新任务替代的旧 worker 归类为 busy，不产生过期 warning。发布工作流在全新 PostgreSQL 应用 migration 后新增 `migrate status` 和 live schema → Prisma datamodel `migrate diff --exit-code` 门禁。M59 无 schema 变更；新增 CI 门禁尚待 GitHub runner 首次实际执行。

M60 已把数据库 schema 版本纳入运行时 readiness：PostgreSQL `SELECT 1` 成功后还必须确认最新必需 migration `20260722091000_add_order_logistics_repairs` 已完成且未回滚，否则 `/api/health/ready` 返回 503、数据库依赖进入 critical 告警，候选实例不会接流量。单测扫描 migration 目录并要求 readiness 常量等于仓库最新目录，后续新增 migration 未同步门禁时会直接失败。M60 无 schema 变更。

M61 已把抖店单笔订单详情的父订单 ID 纳入请求/响应一致性校验：SDK 映射后必须与请求 ID 完全一致，BFF 在订单商品查询和事务写入前再次防御；平台或网关串单时保留原订单状态并停止履约，不会写入另一订单后继续基于旧售后状态采购。M61 无 schema 变更。

M62 已把订单同步与真实采购快照创建放入同一并发隔离协议：两侧均使用带 P2034 重试的 Serializable 事务；采购事务内重新读取当前售后、地址、订单项、货源映射和已有采购，并一次固化全部供应商采购项。同步与采购交叠时必须串行化为“先同步后按新快照采购”或“先固化采购后同步只更新售后”，不会用进入服务时的旧订单项错采。M62 无 schema 变更。

M63 已把 OAuth Token 轮换结果纳入可恢复状态机：平台刷新成功后先将新旧密文关联和新到期时间写入 24 小时 Redis 恢复记录，再按旧凭证 CAS 最多重试 3 次写 PostgreSQL。数据库瞬时失败返回 503、保留 active 和恢复记录；后续请求持同一店铺刷新锁完成提交，不会把持久化故障误报为授权失效或再次用已旋转的旧 refresh token。恢复记录不含明文，revoked/重新授权竞态继续由旧密文条件阻断。M63 无 schema 变更。

M64 已把同一已发布商品的所有外部读写放入共享 Redis 互斥域：人工商品修正、平台状态回读和库存同步使用同一 product lock，并在外部调用前后按随机 token 续租。库存 worker 持锁后重读并再次验证任务所有权；人工修正持锁后验证货源库存版本仍与准备输入一致。并发修正、迟到状态回读和整 SKU 修正/库存同步交错时不会再产生平台与本地乱序或库存回退。M64 无 schema 变更。

M65 已把铺货 job 的一次性领取改为执行期租约：worker 每 60 秒按 `id + running + attempts + lockedBy` 续租，正常长任务不会被 5 分钟 stale recovery 误重试。执行链在付费 AI、图片 worker/Storage、店铺发布与幂等恢复、本地商品/任务结果写入前后重新确认所有权。失权的旧 attempt 不再调用下一个外部接口，不提交 complete/fail；平台调用已返回但本地未落库时，由新 attempt 使用持久化外部编码恢复同一商品。M65 无 schema 变更。

M66 已将付费 AI 中间结果按阶段写入 `publish_tasks.ai_optimized`：标题、详情文案、详情图 URL 和主图处理结果均在下一个费用/副作用阶段前持久化。详情与主图保存 attempted 标记，因合规、解析或上传降级后的队列接管不会再次调用已计费供应商。阶段 checkpoint 继续使用 M65 所有权 guard，旧 attempt 失权时不会覆盖新 worker 结果。M66 无 schema 变更。

M67 已将已发货物流修复改为持续租约：服务每 60 秒按 `repair id + running + lockedBy` 续写数据库锁，正常的多包裹修复不会被 5 分钟 stale 条件接管。抖店 adapter 在承运商查询、订单回读、每个包裹更新和最终验证前后校验同一 guard；失权旧请求不继续下一包，本地采购/物流快照事务仍在最终 lockId 条件下整体提交或回滚。M67 无 schema 变更。

## 2. 准备度矩阵

| 领域                   | 当前状态     | 生产硬门禁                                                                                                                                                                                                                    |
| ---------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 生产配置               | ✅ 基座完成  | 缺少数据库、Redis、加密密钥或安全 CORS 时拒绝启动                                                                                                                                                                             |
| 存活/就绪探针          | ✅ 基座完成  | `/api/health/live` 检查进程；`/api/health/ready` 实查 PostgreSQL、最新 migration 与 Redis，失败返回 503                                                                                                                       |
| API 防护               | ✅ 基座完成  | 全局 120 次/分钟限流；生产默认关闭 Swagger；仅允许显式 HTTPS CORS origin                                                                                                                                                      |
| 优雅退出               | ✅ 基座完成  | Nest shutdown hooks、Prisma 断连、Redis `QUIT`/强制断连                                                                                                                                                                       |
| 发布门禁               | ✅ 基座完成  | 代码检查、三镜像构建、migration、部署 smoke、非 root 与优雅退出均已纳入 CI                                                                                                                                                    |
| 依赖与 SAST            | 🔄 CI 待验收 | 2026-08-04 联网生产依赖审计为 0 已知漏洞；本轮已修复 `fast-uri` 3.1.4 新增 high 公告；须让当前 SHA 的 audit/CodeQL 通过 required checks                                                                                       |
| 身份与租户隔离         | 🔄 P0 待验收 | 应用侧已验证 JWT、内部用户映射和数据隔离；staging 须完成真实邮件账号生命周期，生产 Auth 项目还须独立配置和验收                                                                                                                |
| 真实抖店闭环           | 🔄 P0 阻塞   | 发布幂等恢复、状态同步、修正重提、订单、物流应用链路已通；须用测试店验收 `outer_product_id`、`quality_list`、`product.detail`、`editV2` 与物流                                                                                |
| 真实 1688 货源         | 🔄 P0 待联调 | 搜索/详情 adapter 与持久批量采集应用侧已通；须验证方案订购、真实 buyer Token、配额/曝光回传，以及至少两个受控买家账号的价格和库存口径。未证明全局一致前不得配置 `global_offer` 或启用 worker                                  |
| 真实 1688 采购         | 🔄 P0 待联调 | 应用侧下单恢复、付款状态、物流、多包回传已通；须用真实账号验证 `outOrderId` 判重/反查并完成小额验收后才能打开采购开关                                                                                                         |
| Redis 生产实例         | ❌ P0 阻塞   | 临时 Redis 7 容器已通过 readiness；Token 轮换恢复也依赖 24 小时密文记录，须提供持久化、受监控、可恢复且避免随意淘汰的生产 Redis                                                                                               |
| 部署与回滚             | 🔄 P0 待演练 | 本地镜像、CI、migration-once 与回滚手册已完成；须在目标云环境完成切流、回滚和备份恢复演练                                                                                                                                     |
| 审计与告警             | 🔄 P0 待演练 | 应用侧审计、Prometheus、签名 Webhook 和告警状态机已完成；须接入真实接收端/监控平台并演练                                                                                                                                      |
| Storage / GPU 图片链路 | 🔄 P1        | 公开 Storage 与真实图片 worker 联调；失败继续保持降级而不误报成功                                                                                                                                                             |
| 真实平台类目/属性/资质 | 🔄 P0 待验收 | 这是首发抖店发布必经链路；应用侧目录、Top3、属性与动态资质闭环已完成，须应用 migration 并用真实测试店验收                                                                                                                     |
| 批量商品经营           | 🔄 P0 进行中 | 批量采集、上下架、改标题、改价、库存同步与滞销安全下架已有应用侧证据；须在 staging 应用第 36～39 个 migration，验证双租户采集隔离与恢复、完成 30 天订单历史回补，再用真实商品验收状态/标题/价格/库存/清理强回读及未知结果恢复 |
| 生产数据库 schema      | ❌ P0 阻塞   | 生产数据库尚未独立验收；须在备份、回滚和维护窗口齐备后应用全部 migration，确认 schema diff 为空且 readiness 通过；staging 不能替代该证据                                                                                      |
| 服务市场商业生命周期   | ❌ P0 阻塞   | 须完成订购、试用、续费、退款、到期、卸载回调，以及验签、幂等、权益同步和对账异常路径                                                                                                                                          |
| 法务与平台合规         | ❌ P0 阻塞   | 隐私政策、用户协议、数据处理清单、AI 内容标识、备案/资质和应急演练                                                                                                                                                            |

## 3. 历史工程证据：M13 已落地的运行规则

第 3～10 节保留 M13～M67 的历史实现与验证证据，不定义当前执行顺序，也不表示证据仍然有效。最新工作状态只在 [00-roadmap.md](./00-roadmap.md) 维护。

### 3.1 生产启动必须满足

- `DATABASE_URL`：有效 PostgreSQL URL
- `REDIS_URL`：有效 `redis://` 或 `rediss://` URL
- `ENCRYPTION_KEY`：至少 32 字符，且不能使用示例默认值
- `CORS_ORIGINS`：一个或多个精确 HTTPS origin，禁止 `*`、路径、query 与 hash
- `PUBLISH_QUEUE_MODE=database`
- `AUTH_MODE=supabase`
- `SUPABASE_URL`：精确 HTTPS 项目 origin；默认从 `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` 读取 JWKS
- 旧 Supabase 项目使用 HS256 时配置至少 32 字符的 `SUPABASE_JWT_SECRET`；新项目优先使用 JWKS
- `OPERATIONS_TOKEN`：至少 32 字符的独立运维凭证，不与租户 Bearer token 共用
- `ALERT_WEBHOOK_URL`：精确 HTTPS 告警接收地址
- `ALERT_WEBHOOK_SECRET`：至少 32 字符，用于 timestamp + HMAC-SHA256 Webhook 签名
- `ALERT_WEBHOOK_MAX_ATTEMPTS` 默认 3，范围 1～5；`ALERT_WEBHOOK_RETRY_BASE_MS` 默认 500，范围 100～5000 毫秒
- `PORT` 为 1～65535 的整数
- `HEALTH_CHECK_TIMEOUT_MS` 为 100～10000 毫秒
- `ALIBABA_1688_PAYMENT_MODE=manual`：首期只允许人工确认支付
- `ALIBABA_1688_PURCHASE_ENABLED`：真实联调前保持 `false`；只有 1688 采购准备度全绿并完成小额验收后才可设为 `true`
- `SOURCE_IMPORT_ENABLED`：默认 `false`。生产设为 `true` 时必须有 1688 AppKey/AppSecret、HTTPS OAuth 回调，并确认 `ALIBABA_1688_SOURCE_DATA_SCOPE=global_offer`；`SOURCE_IMPORT_POLL_MS` 范围 500～60000，`SOURCE_IMPORT_MAX_ATTEMPTS` 范围 1～10
- `EXCEPTION_CENTER_SCAN_ENABLED`：默认 `false`。第 41 个 migration、真实双租户和六域异常样本验收通过后必须设为 `true`；`EXCEPTION_CENTER_SCAN_INTERVAL_MS` 范围 60000～3600000，`EXCEPTION_CENTER_SCAN_BATCH_SIZE` 范围 1～500
- `DOUYIN_ORDER_SYNC_ENABLED`：真实凭证和店铺未验收前保持 `false`；生产设为 `true` 时必须同时配置 AppKey/AppSecret/Service ID、HTTPS OAuth 回调及包含该回调的白名单
- `DOUYIN_ORDER_SYNC_INTERVAL_MS` 默认 60000；`DOUYIN_ORDER_SYNC_LOOKBACK_DAYS` 默认 30；`DOUYIN_ORDER_SYNC_OVERLAP_SECONDS` 默认 300；`DOUYIN_ORDER_SYNC_MAX_PAGES` 默认 100，超过上限不得推进水位

`AUDIT_RETENTION_DAYS` 默认 180 天；`ALERT_WEBHOOK_TIMEOUT_MS`、重试次数/退避、监控周期、队列阈值和 5xx 阈值可按生产容量调整，但不得通过放宽阈值掩盖持续故障。

生产环境始终不注册 Swagger UI、OpenAPI JSON/YAML 或静态资源路由；`SWAGGER_ENABLED` 只在非生产生效，开发环境仅提供 `/docs-json` 原始契约，不内嵌 UI。

Web 生产构建还必须显式设置 `NEXT_PUBLIC_AUTH_MODE=supabase`、`NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY` 与 `NEXT_PUBLIC_BFF_URL`；两个 URL 都必须是无路径、query、hash 的 HTTPS origin。漏配时前端展示配置错误，不回退 demo。

### 3.2 身份与租户规则

- 除健康探针、抖店 OAuth callback 和独立运维端点外，全部 API 必须携带 Supabase Bearer token
- `/api/operations/*` 不接受租户 Bearer token，必须携带独立 `OPERATIONS_TOKEN`，并应在网关侧限制来源网络
- `x-user-id` / `x-user-plan` 只在显式 `AUTH_MODE=demo` 的本地演示中生效，生产设置这两个头不会取得身份
- JWT 必须通过签名、issuer、audience 与 `sub` UUID 校验；无效或过期 token 返回 401
- `sub` 通过 `users.auth_subject` 唯一映射内部用户；业务表继续使用内部 `user_id`，套餐从数据库读取
- 内部用户为非 active 状态时返回 403；认证服务或用户映射数据库故障时安全失败

### 3.3 探针语义

| 端点                    | 用途                      | 成功条件                                                           |
| ----------------------- | ------------------------- | ------------------------------------------------------------------ |
| `GET /api/health`       | 兼容旧探针，等同 liveness | 进程可处理 HTTP                                                    |
| `GET /api/health/live`  | 容器存活检查              | 返回 200，不检查外部依赖                                           |
| `GET /api/health/ready` | 流量接入检查              | PostgreSQL 最新 migration 查询与 Redis `PING` 都成功；否则返回 503 |

负载均衡只应把 readiness 为 200 的实例加入流量池，不能用 liveness 代替 readiness。

## 4. M14 当前验证证据

- migration `20260717150000_add_user_auth_subject` 已应用到真实 Supabase
- 两个本地签名的测试 JWT 分别映射两个唯一内部用户；重复用户 1 请求复用同一映射
- 用户 1 收藏 `mock-1001` 后收藏数为 1，用户 2 收藏数为 0，证明现有 `user_id` 业务隔离链路生效
- 两个临时用户与级联测试收藏均已清理，删除数为 2
- 假生产 BFF：live 200、ready 503（假 PostgreSQL/Redis 均 down）、无 Bearer 401、伪造演示头 401、无效 Bearer 401、`/docs` 404、公开 OAuth callback 业务校验 400
- Web：登录/注册切换、会话加载、配置错误、受保护路由直达、桌面与 390×844 均通过；390px 无横向溢出，控制台无 warning/error
- 尚未验证：真实 Supabase 邮件投递、邮箱确认跳转、密码登录、token 自动刷新、退出、Site URL 和 redirect allowlist

## 5. M15 当前验证证据

- 单一 Dockerfile 成功构建 `bff`、`migrate`、`web` 三个 target；Web 使用 Next standalone，BFF/Web 均以非 root `node` 用户运行
- Debian slim 补齐 OpenSSL；BFF production deploy 后显式生成 Linux Prisma Client，修复部署目录启动时 `@prisma/client did not initialize yet`
- 全新 PostgreSQL 15 中由 migrate 镜像一次应用 6 个 migration；Redis 7 与 PostgreSQL 均被 readiness 识别为 up
- 隔离容器网络内实测 live 200、ready 200、Web 200、生产 `/docs` 404、无 Bearer/无效 Bearer/伪造演示头均 401，OAuth callback 不被认证守卫拦截
- BFF/Web 镜像配置用户为 `node`，容器内实际 uid/gid 为 1000；收到 SIGTERM 后退出码均为 0 且未 OOM
- GitHub Actions 已定义全量代码门禁、三镜像构建、migration、部署 smoke、非 root 和优雅退出检查
- `docs/11-deployment-runbook.md` 已定义不可变 SHA、migration-once、readiness 切流、应用回滚、Prisma 前向修复和快照恢复边界
- 全仓 lint 2/2、typecheck 14/14、测试任务 11/11（BFF 140 项、总计 199 项）、production build 9/9、Prettier 与差异检查均通过
- 尚未验证：真实镜像仓库、目标编排平台、HTTPS 域名、生产 Secret Manager、持久 Redis、生产数据库快照/PITR 和实际切流/回滚演练

## 6. M16 当前验证证据

- 新增 `audit_logs`：全局记录 POST/PUT/PATCH/DELETE 成功与失败，单独记录失败鉴权和 OAuth authorize/callback；租户只能分页读取自己的审计事件
- 审计记录不保存请求 body、Authorization、Cookie、token 或密钥；IP 仅保存 HMAC，BigInt 输出统一转字符串
- 新增 `operational_alerts`：支持去重、严重度升级、重通知窗口和自动 resolved；覆盖 PostgreSQL/Redis、dead/backlog/stale job、5xx 错误率、LLM 与店铺凭证异常
- 新增独立运维端点：`/api/operations/status`、`alerts`、`metrics`、`check`；无运维 token 返回 401
- Webhook 使用 timestamp + HMAC-SHA256 签名，并携带稳定 `deliveryId`；网络错误、408/425/429/5xx 做有界指数退避，普通 4xx 不重试，成功后才更新通知时间
- 最新 `m20-current` BFF/migrate/Web 在全新 PostgreSQL 15/Redis 7 中一次应用 14 个 migration，状态最新且 schema diff 为空；12 项部署验证通过，非法 `ALERT_WEBHOOK_MAX_ATTEMPTS=0` 以 exit 1 拒绝启动，合法重试配置下 BFF ready 200
- 审计保留策略默认 180 天并可配置，定时删除过期记录
- 空库、模拟历史 BYOK schema 和真实 Supabase 三种迁移路径均通过；真实 Supabase 已应用全部 8 个 migration，schema diff 为空
- 最终 M17 BFF/migrate/Web 镜像在隔离 PostgreSQL/Redis 网络中通过部署验证：8 migration 无待应用项、status/check/metrics 均 200、无运维 token 401、Web 200
- BFF/Web 镜像与容器实际用户均为 `node` / uid/gid 1000；SIGTERM exit 0、未 OOM；临时验收环境已清理
- BFF lint、typecheck 和 47 个测试文件 / 150 项测试通过

尚未验证：真实 HTTPS 告警接收端验签、按 `deliveryId` 幂等去重及重试响应，Prometheus 抓取/Grafana 面板、集中日志/APM、告警通知链路和故障演练。

## 7. M17 当前验证证据

- 初始生产依赖审计复现 48 个漏洞：3 critical、18 high、22 moderate、5 low
- Next 当前为 15.5.22；Nest common/core/platform-fastify 为 11.1.28，运行链路使用 Fastify 5.10
- Sharp 当前为 0.35.3；业务不需要的可选 `@fastify/static` 已移除，PostCSS、`find-my-way`、`fast-uri`、`js-yaml` 与 `brace-expansion` 固定到已修复版本
- `pnpm audit --prod` 返回 `No known vulnerabilities found`
- `audit:prod` 已进入 `make release-check` 与 GitHub release-gates；新增 PR/main/weekly CodeQL + SCA workflow
- 完整 release-check：lint 2/2、typecheck 14/14、测试任务 11/11（BFF 150、总计 209）、build 9/9、Prettier 与差异检查通过

尚未验证：GitHub security-scans 首次真实运行、Code Scanning 权限/套餐、main 分支 required checks 和告警处置流程。

## 8. M18 当前验证证据

- 1688 SDK 实现官方 Web OAuth、Token 换取/刷新、HMAC-SHA1、`fastCreateOrder`、买家订单和物流查询；买家 Token 与销售店隔离且只存密文
- 抖店已付款订单的非空姓名、电话和详细地址字段不依赖密文外观，全部调用 `order.batchDecrypt`；按 `auth_id + cipher_text` 去重、每批最多 50 个，少任意结果或返回失败码时整批停止入库/采购；非已付款订单只读取脱敏字段
- `OrderItem` 持久化 `sourceSupplierId/sourceOfferId/sourceSpecId`；创建采购单后，平台重新拉单不会将本地 `purchasing` 降级为 `paid` 或删除采购快照
- 每个供应商生成独立 `PurchaseOrder`，使用 `flow=saleproxy`、`fenxiaoChannel=douyin` 和稳定 `outOrderId`；不支持一件代发、绑定不全或地址不可解密时 fail-closed
- 官方 `fastCreateOrder` 明确 `outOrderId` 可用于幂等，`getBuyerOrderList` 支持按该字段查询；创建报错、本地保存失败和后续重试会恢复同一远端订单，不只依赖重复创建的隐含行为
- 采购恢复结果必须恰好一笔且 `offerId/specId/quantity` 与本地快照一致；本地 `orderId1688` 条件更新拒绝并发冲突，失败标记不能覆盖已由其他进程恢复的记录
- 人工付款后，1688 `subItemIDString` 与物流 `orderEntryIds` 必须严格映射到销售子订单和数量；无法确认的分包不会回传平台
- 抖店多包使用 `order.logisticsAddMultiPack`，`request_id` 由订单及排序后包裹数据稳定派生；快递 code 优先使用明确 code/已知别名，其余从 `order.logisticsCompanyList` 动态解析
- `ALIBABA_1688_PURCHASE_ENABLED` 只接受 `true/false`；生产环境设为 `true` 时，启动门禁强制要求人工付款模式、完整 AppKey/AppSecret 和 HTTPS OAuth 回调地址
- 隔离 PostgreSQL 已应用全部 13 个 migration，`migrate status` 最新，schema diff 为空；收件人姓名密文列、供应商列、包裹映射表和唯一索引已直接查询确认
- 完整 release-check 通过：生产依赖 0 已知漏洞，typecheck 14/14，测试任务 11/11（Platform SDK 31、BFF 167、全仓 243），build 9/9，Prettier 与差异检查通过
- BFF/migrate/Web 生产镜像在全新 PostgreSQL 15 + Redis 7 中一次应用 13 migration；live/ready/Web、Swagger/认证/运维门禁、Prometheus 均通过，容器 uid/gid 1000，SIGTERM exit 0 且未 OOM

尚未验证：真实抖店应用与测试店、1688 买家应用与授权账号、小额人工付款、卖家真实发货与抖店多包回传；在此之前 `ALIBABA_1688_PURCHASE_ENABLED` 必须保持 `false`。

## 9. M19 当前验证证据

- `shops` 新增 `last_order_sync_at/order_sync_attempt_at/order_sync_error`，同步错误只保存可公开信息
- 每轮固定 `update_time_start/end`，官方页码从 0 开始、每页 100；页间去重，最后一页不足 100 才推进成功水位
- 首次默认回看 30 天，后续从成功水位减 300 秒；页数上限、Redis 故障、同店并发和任一 API/数据库失败均 fail-closed
- worker 只处理 active OAuth 抖店 seller，跨实例使用 15 分钟 Redis 锁；失败/恢复写入去重告警，正常锁冲突不误告警
- 设置页展示上次成功水位或脱敏错误，可人工同步并刷新订单/经营缓存；准备度由 5 项增至 6 项，新增后台订单同步开关
- 第 14 个 migration 在全新 PostgreSQL 15 一次应用，`migrate status` 最新，三列实际存在，live DB 与 datamodel diff 为空
- 完整 release-check：生产依赖 0 已知漏洞，lint 2/2，typecheck 14/14，测试任务 11/11（Platform SDK 32、BFF 178、全仓 255），build 9/9，Prettier 与差异检查通过
- M19 migrate 镜像在第二个全新数据库一次应用 14 个 migration；BFF/Web 的 12 项部署验证全部通过，生产漏配同步凭证 exit 1，完整配置 worker 真实启动；BFF/Web/migrate uid 1000，SIGTERM exit 0 且未 OOM
- Dockerfile 已固定 `pnpm@9.12.0`，将 workspace manifests、源码和 Corepack 下载分层，并为 apt 增加 BuildKit 缓存、5 次重试和 30 秒超时；标准 BFF/migrate 从零构建及 Web 构建成功，三镜像在全新 PostgreSQL/Redis 中复验通过
- 真实 Supabase 在 PostgreSQL 17 一致性逻辑备份及事务回滚预演后应用 M18–M19 六个 migration；最终 14 个 migration 最新、schema diff 为空，六条记录均 finished，新表/列和三条演示数据迁移结果已通过运行时连接池确认

尚未验证：真实测试店后台轮询/人工同步。

## 10. M20～M67 当前验证证据

- 真实 1688 货源采集、抖店库存联动、类目目录/属性/动态资质、已发布商品修正均已形成应用侧闭环
- 抖店 `product.addV2` 返回商品 ID 后，真实店商品初始状态为待审核；演示店仍保持在线以便本地演示
- `product.detail` 同时读取 `status` 与 `check_status`，审核状态优先，避免“审核驳回但上下架字段仍在线”时误报在线
- BFF 提供租户隔离的手工状态同步接口，保存平台原始状态、最近成功时间和脱敏错误；同步失败不修改当前业务状态
- “我的铺货”展示待审核、平台驳回、在线、已下架状态，支持手工刷新；驳回商品可调整属性/资质并用原商品 ID 修正重提
- 修正成功后清除旧的平台状态快照，等待下一次真实查询，不继续显示修正前的驳回结果
- 抖店订单同步与单笔即时刷新读取子订单 `after_sale_info`；部分退款不会误把主订单改为全部退款，`refund_status=1` 会暂停自动履约，`after_sale_type=6` 的价保退款仍继续商品履约
- 真实 1688 采购及物流回传前都重新读取销售订单；售后处理中、部分/全部退款时 fail-closed，售后失败后恢复正常入口
- 未创建远端采购时自动停止；已创建/推进采购及部分退款要求人工核对，处置说明做租户隔离并保留审计记录
- 运维状态和 Prometheus 覆盖待人工采购异常、售后处理中与部分退款暂停；正常采购不会被误报为退款异常
- 部分退款默认暂停；只有待采购、没有远端 1688 单且剩余子单无活跃售后时，运营才可确认仅履约未退款商品，否则只能停止整单并走人工处置
- 部分退款决定绑定全部子单售后状态、类型与退款结果指纹；任一字段变化会自动失效。确认继续后，1688 采购、成本、包裹数量校验及抖店物流明细均排除履约退款子单，但不排除价保商品
- 抖店订单详情没有通用实际退款金额字段；订单页支持按后台累计实退金额人工核对和修正，并绑定同一售后指纹与订单实付基准，任一变化都会失效。价保不停止履约，但退款成功仍进入财务核对
- 未核对退款金额的有效订单不进入 GMV、毛利与动销排行；看板展示排除订单数和原金额，核对后按 `订单实付 - 累计退款` 计入净 GMV
- 远端 1688 采购异常必须核对最终实际成本；历史已处理但无结构化成本的记录继续标记待补齐，未核销时成本与毛利 fail-closed
- 未触达 1688 的自动停止采购按最终成本 0；退款/关闭订单的不可追回采购成本进入经营毛利，新的售后或终态事件会清空旧核销
- 订单页新增独立分页的财务待办入口，与普通订单筛选和页码解耦；接口按当前租户过滤，同一订单的退款金额和采购成本待办只计一笔
- 运维快照和 Prometheus 分别暴露采购成本待核销、退款金额待核对及去重后的财务待办订单总数；退款金额积压触发 warning，采购成本积压含历史 `resolved + reconciledCost=null` 并触发 critical
- 普通订单接口和页面改为独立分页，支持当前租户内按 seller 店铺及订单状态筛选；数据库读取失败直接反馈错误，不再返回误导性的空列表
- 店铺支持租户隔离的本地停用和 Token 清除；停用/重新授权恢复凭证告警，重新启用重验店铺配额，迟到刷新不能覆盖 revoked 或较新凭证
- 生产身份模式前后端都禁止演示店创建；店铺列表和配额统计的数据库故障不再 fail-open
- 平台适配器工厂在生产身份模式拒绝所有旧 `demo-*` 店铺操作；类目、铺货、订单同步、履约和库存入口不能通过直接 API 或 worker 绕过
- 历史演示店、演示订单和演示铺货商品在生产身份模式下不进入店铺列表、订单/财务待办、经营看板、财务告警及月度铺货额度；Web 不展示模拟订单入口
- 铺货记录接口和页面改为租户隔离分页，生产总数和列表同步排除历史演示目标店铺；数据库读取失败直接反馈错误，不再被最近 50 条截断或误显示为空列表
- 商品详情数据库故障保持 5xx，仅查询成功且无记录时返回 404；推荐降级空结果与正常筛选无结果在 Web 明确区分
- 平台 AI 与月度铺货用量无法可靠查询时 fail-closed；LLM、主图付费 worker 和新铺货在产生外部成本或任务写入前停止，BYOK 保持用户自付旁路
- 平台 LLM 与主图 worker 的额度检查和预占在 Serializable 事务中原子完成；供应商成功后回填实际成本，解析失败仍计量，未收敛预占进入 critical 告警、运维快照和 Prometheus
- 铺货标题、详情、详情图和主图处理按阶段 checkpoint；队列接管复用已保存结果并跳过已计费的失败/降级尝试
- BYOK 密钥读取故障不再伪装成未配置，活跃密钥解密失败不会回退平台付费额度；删除只有在数据库确认后才向用户报告成功
- 铺货任务与队列 job 原子创建，失败/死信/人工重试状态在事务内迁移；worker 所有权条件阻止迟到结果覆盖，历史 pending 孤儿任务可自动补建 job
- 铺货 worker 按当前 attempt 每 60 秒续租；AI、图片、Storage、平台发布/恢复和结果写入前后均复核所有权，失权旧 worker 停止剩余副作用
- 抖店铺货任务按目标店铺持久化稳定 `outer_product_id`，创建报错后用 `product.detail + out_product_id + show_draft=true` 恢复同一商品；本地按 `task_id + shop_id` 唯一 upsert，避免平台成功而本地失败后的重复创建
- 1688 采购使用稳定 `outOrderId` 并通过官方买家订单列表恢复；创建响应不确定、本地写入失败或并发重试时，只有唯一且商品快照一致的远端订单可绑定
- 抖店物流回传成功后只允许 `purchasing + 售后允许` 原子迁移为 shipped；退款/售后状态并发先到时重新刷新平台，不会被迟到更新覆盖
- 库存 worker 执行、完成和失败必须匹配 attempts/lockedBy/目标版本；stale recovery 后的迟到结果返回 stale，人工重试竞态返回冲突
- 采购后的平台子单 ID 集合必须与本地快照一致，每个售后更新必须命中；失败时整单事务回滚且同步水位不推进
- 抖店订单响应不再过滤异常父订单或子单；空子单列表、缺失稳定子单 ID 和重复子单 ID 均使整批 fail-closed
- 抖店订单金额/时间及子单数量/单价必须合法；缺失数量不再默认 1、缺失金额不再默认 0、缺失时间不再写成 1970 年
- BFF 在整页写入前拒绝未知平台订单状态；失败不执行商品/订单写入、不推进成功水位，`skipped` 不再掩盖数据缺口
- 子单售后对象和三个状态字段严格解析；异常值不会降级为无售后，显式 `0` 继续作为合法初始值保留
- 1688 买家订单恢复/详情必须返回非空商品明细，金额/数量/状态及唯一远端子单 ID 全部严格校验，异常时不推进采购状态
- 每次 1688 状态轮询在任何采购/物流写入前重新核对远端订单 ID 和聚合商品快照，错单或商品变化不会推进本地状态
- 1688 重复运单在写入前被拒绝；完整物流按采购单单事务替换状态/成本、陈旧运单及全部当前包裹商品映射
- 物流商品 ID 仅在字段真实缺失时允许单包回退；对象/数组坏值、重复、超长或控制字符 ID 不会被过滤成空映射
- 物流承运商/状态仅在真实缺失时允许为空，malformed 文本整批失败；承运商在 SDK、采购摘要和包裹表统一支持 64 字符
- 1688 采购轮询持久化同步世代；状态、成本和包裹事务只接受当前所有者，较早请求的迟到响应不能覆盖较新快照
- 1688 采购状态只允许向前推进或进入 `failed`；已发货/已收货不会被顺序旧响应回退，失败终态不能自动恢复
- 抖店物流回传前再次核对待履约销售项、采购项和包裹项的集合、归属与数量；退款排除项、串包、额外项、缺项及非法数量均被阻断
- 新的退款/关闭事件会递增采购异常修订号，人工成本核销必须匹配当前版本；旧事件表单无法把新异常误标为已处理
- 发货前被 1688 取消/关闭的采购进入可重试待办；旧尝试和实际成本完整归档，历史成本进入毛利，新尝试使用独立稳定外部单号且与销售订单原子恢复
- 已产生物流的采购异常不会误走重新采购；旧包裹和映射在清除前带操作人完整归档，同一远端订单必须重新通过严格物流校验
- 已履约采购巡检 worker、持久化调度领取、路由变化比较、原快照保留、异常待办、分级告警与告警重试已实现并通过专项回归
- 已发货订单的专用物流修复支持旧/目标/当前三方快照核验、逐包幂等更新、平台回读、数据库执行锁、异常修订号唯一性和本地原子替换；普通成本核销不能误关闭该类异常
- 物流修复执行期每 60 秒按 lockId 续租，并在每次抖店读写前后校验 ownership guard；失权请求不再继续剩余包裹或本地提交
- 订单增量同步在每页平台调用前后续租并校验分布式锁；失去执行权时不写订单，成功水位/错误状态按当前 attempt 条件更新，旧 worker 不产生误告警
- release-gates 已要求迁移镜像在全新数据库上通过 `migrate status`、live schema diff 和 RLS/ACL 断言；2026-08-03 的 [GitHub Actions #30811827585](https://github.com/harzss/supplier/actions/runs/30811827585) 已在全新 Runner 上完成首次 verify + images 全绿验证
- BFF readiness 除 PostgreSQL/Redis 连通性外还校验仓库最新必需 migration；目标 schema 落后时保持 liveness、拒绝 readiness 和流量接入
- 抖店单笔订单详情在 SDK 映射后和 BFF 写入前双层核对请求父订单 ID；串单响应不会写入其他订单，也不会让目标订单旧状态进入采购
- 订单同步与采购快照创建统一使用可重试 Serializable 事务；采购只基于事务内重读的最新订单项一次固化全部供应商快照
- Token 刷新成功先写 Redis 密文恢复记录，再以旧凭证 CAS 重试 PostgreSQL；持久化故障不误标过期，后续请求可恢复同一轮换结果
- 人工商品修正、平台状态回读和库存 worker 共享商品级 Redis 锁；平台调用前后续租，并复核任务所有权与货源库存版本
- 当前代码验证通过：lint 2/2、typecheck 14/14、测试任务 13/13（Platform SDK 107、BFF 338、全仓 522）、production build 9/9、Prisma schema、Prettier 与 `git diff --check` 通过；BFF/migrate/Web 三个 Linux 镜像重新构建成功且保持非 root
- 2026-08-03 联网 `pnpm audit --prod --audit-level high` 返回 `No known vulnerabilities found`；新增公告触发的 Next、Sharp、PostCSS、Fastify/Nest 传递依赖升级已纳入当前 lockfile
- 2026-07-22 M67 收尾时，M22～M37 期间以及 M50～M51、M54～M58 新增的业务 migration 尚未应用到目标 PostgreSQL；该迁移状态已被 2026-08-03 的 33/33 staging 证据取代，但真实测试店 E2E 仍未完成
- 2026-07-22 只读 `prisma migrate status` 已连接目标 Supabase：仓库 32 个 migration 中 18 个仍待应用，范围为 `20260720120000_add_inventory_sync`～`20260722091000_add_order_logistics_repairs`
- 同次只读迁移预检确认目标库当前 `source_products=30`、`published_products=6`、`orders=3`、`purchase_orders=3`，没有未完成 migration 记录，`published_products(task_id, shop_id)` 重复组为 0；待迁移数据量和唯一索引前置条件当前无已知阻塞
- 2026-07-22 M67 当时仅执行本地 production build、未重新构建 Docker 或部署；该镜像与 migration 证据已被本文顶部 2026-08-03 staging 记录取代

## 11. 执行顺序引用

本文档不再单独维护执行顺序。统一按 [00-roadmap.md](./00-roadmap.md) 的 R0～R5 推进；只有本页准备度矩阵的 P0 全部关闭并附有当前生产环境证据，才能进入生产灰度。

## 12. 每次发布的最低验证

```bash
pnpm audit:prod
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm exec prettier --check "**/*.{ts,tsx,md,json,yml,yaml}"
git diff --check
```

运行环境还必须验证：

- 缺少任一生产必需配置时进程以非零状态退出
- 生产 BFF 拒绝 `AUTH_MODE=demo`、HTTP Supabase URL、缺失/不安全认证配置
- 生产 Web 漏配认证或 HTTP BFF/Supabase origin 时安全失败，不展示商家工作台
- `/api/health/live` 返回 200
- `/api/health/ready` 仅在 PostgreSQL、Redis 都可用时返回 200
- `/api/health/ready` 必须确认最新必需 migration `20260805040000_harden_workflow_check_null_semantics` 已完成且未回滚；readiness 常量已前移到该版本，当前发布账面 33/43 必须返回 503
- `PRODUCT_BATCH_ENABLED=false` 时批量商品预览不产生平台副作用、确认执行返回 503；启用后只允许当前已实现的 `online`、`offline`、`edit_title`、`edit_price`、`sync_inventory`、`cleanup` 与抖店离线 `change_source`。标题/上架/下架未知结果未核验前不得重放；下架 fence 必须同时阻断完整编辑、普通状态同步和库存 worker。`cleanup` 不得删除商品，真实店必须先验证 30 天订单历史回补并配置 `DOUYIN_ORDER_SYNC_HISTORY_VERIFIED_AT`，同步水位过期、运行中、失败或执行期间出现订单都必须停止或进入人工复核。`change_source` 必须保持平台 SKU、售价和离线状态不变，不能作为任意平台 SKU 编辑入口
- `SOURCE_IMPORT_ENABLED=false` 时可读取已有采集任务但确认执行返回 503；生产启用必须同时具备 1688 AppKey/AppSecret、HTTPS OAuth 回调和 `ALIBABA_1688_SOURCE_DATA_SCOPE=global_offer`。预览不得调用详情或请求用户 URL；worker 必须重新校验任务用户、buyer Shop、Token、Redis 限流和 item 所有权
- 统一异常中心必须验证两个真实账号互不可见；六域刷新中任一域故障不得关闭该域旧事项；确认跟进不能把来源置为已恢复；来源指纹变化必须重新打开；只有权威扫描恢复或生产者平台回读证据才能关闭；返回的处理入口必须保持站内白名单路径
- 订单异常扫描必须覆盖从未同步、水位陈旧、首次同步挂起、授权过期和启用店铺凭证缺失；用户主动停用的 `revoked` 店铺不得重新产生 critical 异常。新授权店铺与正在运行的首次同步有宽限期。开启后台扫描后必须验证账号批次有界轮转、单账号失败隔离和单实例不重入
- 售后工单必须验证两个真实账号的列表、详情、子单、采购关联和时间线互不可见；同 UUID 同参恢复、异参冲突，销售来源或采购 revision 变化使旧确认失效并重开。超过 5 分钟的销售快照、未完成部分退款决策/金额核对、未确认的 1688 人工动作、未核销采购异常或最终成本都必须阻止关闭；清除全部阻断并取得新鲜平台回读后才允许关闭。自动调用 1688 售后、退款或退货不在当前候选范围内
- 受保护 API 无 Bearer、仅伪造演示头或携带无效 token 时返回 401
- 运维端点无 `OPERATIONS_TOKEN` 返回 401；携带有效 token 时 status/check/alerts/metrics 均成功
- Prometheus 输出包含请求、5xx、队列、活跃告警和审计失败指标
- 创建可清理的测试写操作后，审计记录可查且不包含 body、token、Cookie、密钥或原始 IP
- 两个真实测试账号互相看不到对方的店铺、铺货、订单、收藏和模型密钥
- 生产 `/docs` 默认返回 404
- 收到终止信号后进程及时退出，不遗留数据库或 Redis 连接
