# 平台 OpenAPI 接入方案

> **原则**：仅使用官方 OpenAPI，不做账号 Cookie、不做爬虫黑产。所有授权走 OAuth 2.0。

## 1. 平台清单

| 平台        | 接入入口              | 角色                  | 优先级 |
| ----------- | --------------------- | --------------------- | ------ |
| 1688        | open.1688.com         | 采购方（货源 + 代发） | P0     |
| 抖音小店    | op.jinritemai.com     | 销售方                | P0     |
| 淘宝 / 天猫 | open.taobao.com       | 销售方                | P0     |
| 拼多多      | open.pinduoduo.com    | 销售方                | P1     |
| 快手小店    | open.kwaixiaodian.com | 销售方                | P1     |
| 视频号小店  | open.weixin.qq.com    | 销售方                | P2     |

## 2. 1688 OpenAPI 接入

### 2.1 关键能力

| 能力       | 接口（示意）                                | 说明                                 |
| ---------- | ------------------------------------------- | ------------------------------------ |
| OAuth 授权 | `/auth/authorize`                           | 买家授权                             |
| 商品搜索   | `cross.keywords.search`                     | 买家货源搜索，需订购跨境代采解决方案 |
| 商品详情   | `cross.productInfo.get`                     | 买家货源详情、SKU、图片与分销价      |
| 类目树     | `alibaba.category.get`                      | 类目映射                             |
| 下单       | `alibaba.trade.fastCreateOrder`             | 代发下单                             |
| 订单恢复   | `alibaba.trade.getBuyerOrderList`           | 按外部订单号恢复采购结果             |
| 订单详情   | `alibaba.trade.get.buyerView`               | 买家视角订单状态与商品明细           |
| 物流查询   | `alibaba.trade.getLogisticsInfos.buyerView` | 买家视角运单跟踪                     |
| 售后       | `alibaba.refund.create`                     | 退款                                 |

### 2.2 服务市场上架要求

- 完成开发者实名认证
- 应用通过审核（隐私政策、用户协议）
- 等保 2.0 三级（硬要求之一）
- 提供测试账号供平台审核

### 2.3 限流与配额

- 普通应用：500 次 / 分钟 / 接口
- 服务市场应用：可申请提升到 5000 次 / 分钟
- **应对**：本地缓存 + 增量同步 + 异步队列

### 2.4 当前实现约定

- 买家货源采集使用 `com.alibaba.fenxiao:cross.keywords.search-1` 与 `cross.productInfo.get-1`；必须先订购官方跨境代采解决方案并取得买家 OAuth Token
- `alibaba.product.get` 的官方权限范围是“只能查询自己所有的产品”，不能作为买家通用货源详情接口
- Web 批量采集只接受最多 100 个数字 offerId 或官方 HTTPS offer 详情链接；预览只提取并去重 offerId，不请求、解析或跟随用户 URL。确认后由持久 worker 使用任务所属用户当前有效的 1688 buyer Token 调用 `cross.productInfo.get-1`
- `source_products` 当前是全局 offer 缓存。真实环境只有在用多个受控买家账号证明详情、分销价与库存不因账号变化，并显式设置 `ALIBABA_1688_SOURCE_DATA_SCOPE=global_offer` 后才能开启 `SOURCE_IMPORT_ENABLED=true`；否则启动与执行均拒绝。若平台数据实际按买家变化，必须先改为用户级快照模型
- 采集任务按 `userId + clientRequestId + requestFingerprint` 幂等；同键同参恢复，同键异参冲突。详情、库存版本、已发布商品库存目标、用户“我的货源”归属与 item 结果在同一 Serializable 事务内提交；停止只取消未开始项，失败项可单独重试且不重跑成功项
- 价格优先读取代销场景的 `consignPrice`；有 SKU 时逐规格读取，抖店 `outer_sku_id` 使用 1688 `specId`，保证后续真实采购可映射回源规格
- 官方主图相对路径统一补为 `https://cbu01.alicdn.com/`，详情图同时读取智能详情图和 HTML 图片
- `scripts/crawl-products.mjs` 在 AppKey/AppSecret/AccessToken 全部存在时自动使用真实适配器；完全未配置时继续使用 Mock，部分配置时安全失败
- 每个销售订单按供应商生成稳定 `outOrderId`。官方 [`alibaba.trade.fastCreateOrder`](https://open.1688.com/api/apidocdetail.htm?id=com.alibaba.trade:alibaba.trade.fastCreateOrder-1) 明确该字段可用于幂等；请求失败或本地保存 `orderId1688` 失败时，不重新生成外部订单号
- 自动重试先调用官方 [`alibaba.trade.getBuyerOrderList`](https://open.1688.com/api/apidocdetail.htm?id=com.alibaba.trade:alibaba.trade.getBuyerOrderList-1) 按 `outOrderId` 恢复；首次创建报错或超时后也立即反查。只有恰好一笔远端订单且商品 `offerId/specId/quantity` 与本地采购快照一致时才接受
- 买家订单列表恢复与订单详情回读必须包含非空商品明细、订单/商品状态、合法非负总金额及正整数数量；重复远端子单 ID、空明细、非法金额或小数数量均 fail-closed，远端子单 ID 允许官方返回的非纯数字稳定格式
- 每次付款/物流轮询都在写入本地采购状态与成本前核对远端订单 ID，并重新比较聚合后的 `offerId/specId/quantity` 与本地采购快照；绑定错单或远端商品变化立即停止，不只在创建结果恢复时校验
- 1688 物流响应中的运单号必须非空、长度受限且单次快照唯一；获得完整物流后，同一采购单的状态、成本、陈旧运单清理、当前运单及商品映射在一个数据库事务内原子替换，任一步失败不暴露半套包裹快照
- 物流 `orderEntryIds` 只有确实缺失、`null`、空字符串或空数组时才按“未提供映射”处理并允许单包回退；对象、数组坏值、过长/控制字符 ID 或重复 ID 均整批 fail-closed，不再被过滤成空列表
- 物流承运商与状态只有字段缺失、`null` 或空字符串时才允许映射为 `null`；对象、数组等错误类型以及超长或控制字符文本整批 fail-closed。承运商从 SDK 到采购摘要和包裹表统一支持 64 字符
- 每次采购状态轮询先递增持久化 `syncRevision` 领取写入所有权；状态、成本和包裹事务仅在世代仍匹配时落库，较早发起但较晚完成的请求不能把新状态或新包裹覆盖为旧快照
- 采购状态只允许向前推进或进入取消/关闭对应的 `failed`；已经 `shipped/received` 的采购单不能因后续旧响应退回待付款/待发货，`failed` 终态也不能自动恢复为进行中
- 回传抖店前再次核对待履约销售订单项、采购项和包裹项的集合、采购归属与数量完全一致；退款后排除项、跨采购单串包、额外项、缺项和非法数量均停止自动回传
- 本地 `orderId1688` 使用条件更新，只允许从空值写入或重复确认同一远端 ID；并发进程返回冲突 ID 时 fail-closed，失败标记不能覆盖已经由其他进程恢复成功的采购单
- 真实验收仍需确认解决方案权限、搜索/详情配额和商品曝光回传要求；未完成前不能把 Mock 数据替换为生产货源池

## 3. 抖音小店 OpenAPI

### 3.1 关键能力

| 能力       | 接口                              | 说明                                           |
| ---------- | --------------------------------- | ---------------------------------------------- |
| OAuth 授权 | `fuwu.jinritemai.com/authorize`   | 工具型应用用 `service_id + state` 发起商家授权 |
| Token 交换 | `token.create`                    | 授权 code 换取 access/refresh token 与店铺信息 |
| 商品发布   | `product.addV2`                   | 携带外部商品编码提交商品并进入平台审核         |
| 商品编辑   | `product.editV2`                  | 修正已有商品并重新提交审核                     |
| SKU 改价   | `sku.editPrice`                   | 按商品 ID、外部 SKU 编码写入绝对整数分售价     |
| 商品状态   | `product.detail`                  | 查询上下架、审核状态及 `spec_prices` SKU 价格  |
| 库存同步   | `sku.syncStockBatchMultiProducts` | 按外部 SKU 编码全量更新库存                    |
| 商品下架   | `product.setOffline`              | 缺货、货源下架或 SKU 结构变化时安全下架        |
| 类目获取   | `shop.getShopCategory`            | 按店铺递归获取可发布类目树                     |
| 类目预测   | `product.GetRecommendCategory`    | 基于商品信息返回官方类目候选                   |
| 类目属性   | `product.getCatePropertyV2`       | 发布所需属性定义、必填项与官方选项             |
| 订单列表   | `order.searchList`                | 订单同步                                       |
| 订单详情   | `order.orderDetail`               | 单笔刷新及子订单售后状态                       |
| 物流回填   | `order.logisticsAdd`              | 发货                                           |

### 3.2 关键约束

- 主图必须 800x800 以上、白底或纯色背景（部分类目）
- 标题不能含极限词、明星名
- 类目属性必填项每个类目不同（要做属性映射表）
- Webhook 推送订单/退款事件

### 3.3 测试环境

抖店 OpenAPI 使用正式网关，开发期通过控制台绑定测试店铺和测试应用；不假设存在独立 sandbox API 域名。

### 3.4 当前实现约定

- 正式网关：`https://openapi-fxg.jinritemai.com`
- 通用 API 使用 HMAC-SHA256 签名，业务 JSON 递归按 key 排序后参与签名，请求超时 10 秒
- 商品发布需要配置 `DOUYIN_CUSTOMER_MOBILE`，货源 `attributes` 中需要提供 `douyinCategoryId`，或 `platformCategoryIds.douyin`
- OAuth 完成后由 BFF 只使用一次性 state 中绑定的站内相对路径跳回原业务页；callback 只在 URL 中携带短期一次性结果 token，登录用户通过 `POST /api/shops/oauth/result` 消费后才能读取成功、店铺或错误信息，跨用户、伪造和重放均被拒绝。`OAUTH_RESULT_REDIRECT_URL` 提供可信 Web origin 和无上下文时的设置页回退，页面消费结果后清理 URL 参数
- `GET /api/shops/oauth/douyin/readiness` 只读检查应用凭证、OAuth/Redis/加密配置、客服电话、真实授权店铺和可发布测试商品，不返回任何密钥
- `POST /api/orders/sync/:shopId` 按固定更新时间窗从第 0 页全分页增量同步；成功后才推进持久水位，手机号和地址经 AES-256-GCM 加密后落库
- 平台订单主状态不能代表全部售后结果：部分退款和已完成订单后续退款时，主订单状态可能保持不变；系统读取子订单 `after_sale_info.after_sale_status/after_sale_type/refund_status`
- `order.searchList` 与 `order.orderDetail` 不允许静默过滤异常父订单或子单；父订单必须包含 ID 和非空子单数组，每个子单必须包含 SKU ID 与稳定平台子单 ID，重复子单 ID 也会使整批同步 fail-closed
- 订单实付/原金额必须是非负整数分，付款时间或创建时间必须提供合法秒级时间戳；子单数量必须是正整数，单价优先使用合法原价、否则按合法子单总价和数量计算，缺失、负数或小数数量均 fail-closed
- BFF 只接受能归一为 `paid/shipped/received/refunded/closed` 的平台订单状态；任一未知状态会在订单写入前停止整页处理并保留成功同步水位，不再计为“跳过”后继续
- 子单 `after_sale_info` 确实缺失或为 `null` 时才按无售后处理；对象结构、`after_sale_status/after_sale_type/refund_status` 任一存在值若不是非负整数则整批 fail-closed，显式 `0` 保留为合法初始值
- 采购开始后，平台同步返回的子单 ID 集合必须与本地受保护采购快照完全一致，且每个售后状态更新必须命中恰好一行；重复、缺失、未知子单或写入未命中会回滚整个订单同步并且不推进店铺水位
- `refund_status=1` 或活跃售后状态映射为处理中，`refund_status=3` 按子订单汇总为部分/全部退款，`refund_status=4` 或拒绝/失败状态映射为售后失败；`after_sale_type=6` 表示价保，即使退款成功也不把商品视为履约退款；部分退款不会误改整张主订单为已退款
- 真实 1688 采购及物流回传前使用 `order.orderDetail` 即时刷新单笔订单；售后处理中、部分退款或全部退款时停止自动履约，售后失败后允许恢复
- 多包物流回传使用由销售订单和排序后包裹内容稳定派生的 `request_id`；平台调用报错或本地状态保存失败时保持 `purchasing`，下次先用 `order.orderDetail` 恢复平台已发货结果
- 平台物流回传成功后，本地只能以 `purchasing + 售后允许` 条件迁移到 `shipped`；若退款或售后状态并发抢先落库，条件更新失败后重新读取平台，不允许无条件覆盖为已发货
- 全部退款/关闭后，未提交到 1688 的采购自动停止；已创建或推进的采购进入人工取消、退款或物流拦截流程。部分退款默认整单暂停，运营可选择停止整单；只有订单仍待采购、没有远端 1688 采购且其余子单不在售后中时，才可确认仅履约未退款商品
- 部分退款处置绑定所有子单售后状态的 SHA-256 指纹；任一子单的 `after_sale_status/after_sale_type/refund_status` 变化都会作废旧决定并重新暂停，避免沿用过期核对结果
- `order.orderDetail` 只返回售后状态、类型与退款结果，不返回通用的实际退款金额；系统不按子单标价猜测。退款成功但整单仍有效时，由运营按抖店后台核对累计实际退款金额并绑定当前售后指纹与订单实付基准，任一售后字段或实付金额变化后自动失效
- 经营看板仅对已核对退款金额的有效订单按 `订单实付 - 累计退款` 计入净 GMV；未核对订单暂不进入 GMV、毛利和动销排行，并在订单页与看板明确提示。价保退款不停止履约，但仍需纳入财务退款核对
- 销售退款/关闭发生在 1688 采购创建后时，运营必须在完成取消、供应商退款或物流拦截后核对“最终实际采购成本”：未付款取消或全额追回填 0，部分追回填无法追回货款、退货运费与手续费合计；未核销前经营看板不展示可信毛利
- 未触达 1688 且处于 `pending/failed` 的采购由系统自动停止，最终采购成本按 0 计算。新的售后指纹或整单退款/关闭事件会重新打开远端采购异常并清空旧成本核销，避免复用过期结果
- 每次新的部分退款、整单退款或关闭事件都会递增采购异常 `exceptionRevision`；人工成本核销必须提交并条件匹配页面读取到的修订号，事件变化后的旧表单不能把新异常误标为已处理
- 1688 在发货前取消或关闭采购单时，系统将其标记为可重试人工待办而不是让销售订单静默停在 `purchasing`。运营核对本次实际成本后，旧 `outOrderId/orderId1688`、失败原因与处理依据归档到采购尝试历史，成本累计进入经营口径；当前采购单原子切换到新的 `-rN` 幂等单号，销售订单恢复为待采购。旧轮询因 `syncRevision` 变化不能覆盖新尝试
- 1688 已产生包裹但在抖店回传前进入取消/关闭时，不允许走重新采购或直接复用旧包裹。运营先在 1688 核实/恢复物流，再提交当前异常修订号和处理说明；旧包裹、订单项映射及操作人写入恢复历史后清空，采购状态仅重置为待重新校验。同一远端订单必须再次通过订单 ID、商品快照、状态和完整物流校验，才能形成新的回传包裹
- 可选后台巡检仅扫描抖店已发货/收货、1688 曾产生物流且当前无未处理异常的采购单。远端订单正常且运单、承运商、商品映射不变时可更新签收状态；后续取消/关闭、物流消失或路由变化时保留原包裹，转人工待办并触发主动告警，不允许静默改写已回传抖店的物流
- 库存联动使用 `sku.syncStockBatchMultiProducts` 的全量模式（`incremental=false`），单次最多 50 个 SKU；以发布时写入的 `outer_sku_id = 1688 specId` 定位规格
- 批量改价使用独立的 `sku.editPrice`，请求只携带 `product_id`、发布时写入的 `out_sku_id` 和绝对整数分 `price`；不得为了改价复用会同时覆盖标题、图片、库存等字段的 `product.editV2`
- 改价预览把比例或逐项目标起售价物化为逐 SKU 绝对价格。执行前后使用 `product.detail.spec_prices` 回读，并严格要求外部 SKU ID 非空且唯一、价格为正整数；平台已达目标时恢复成功，部分成功时只续跑剩余 SKU，出现额外价格漂移或 SKU 集合变化时同步真实快照并 fail-closed
- 后续执行完整 `product.editV2` 前必须先回读并保留平台最新 SKU 价格，防止标题或详情修正把独立批量改价覆盖回旧价格
- 批量改标题只使用 `product.partialEdit`，请求仅携带 `product_id + name`，不得复用会覆盖图片、价格、库存与 SKU 的完整 `product.editV2`
- 标题回读使用 `product.detail(show_draft=true).data.name`，同时保存平台状态、审核状态和实际标题；抖店标题统一按 8～30 个汉字、16～60 加权字符校验
- `partialEdit` 的网络错误、408/429/5xx、无法解析或缺失合法业务 `code` 的 2xx 响应均视为结果未知；写入 fence 未核验前禁止再次改标题或执行完整商品编辑。明确普通 4xx 才按确定失败处理
- 批量上架只使用 `product.setOnline`，且只允许已下架、1688 货源可售并具有完整 SKU 库存快照的商品。平台库存与 1688 目标不一致时，先在保持下架的状态下使用绝对库存接口补齐，不能先上架再异步追库存
- 上架前后与专用核验都使用 `product.detail` 的 `state → inventory → state` 强回读；每次详情响应必须返回与请求精确一致的 `product_id/product_id_str`，只有已识别的审核通过状态才能根据 `status` 映射在线或下架。缺失商品 ID、未知审核码、状态与库存不一致或逐 SKU 库存不一致均 fail-closed
- `product.setOnline` 的网络错误、408/429/5xx 和畸形 2xx 响应均视为结果未知。写入 fence 未核验前禁止普通重试、完整商品编辑和普通状态同步；系统只在持有共享商品锁、商品 revision 仍属于本任务时调用 `product.setOffline` 并回读确认隔离。若原上架请求在隔离后迟到生效，专用核验必须再次下架，不能把迟到在线当作成功
- 每次真实库存变化分配单调递增版本号，并生成店铺内 24 小时唯一、同一次重试稳定的 `idempotent_id`；平台返回“Token 已被使用”时按同一快照已落地处理
- 库存 worker 的执行、完成和失败必须同时匹配 `syncing + attempts + lockedBy + 目标版本/指纹`；stale recovery 或其他 worker 接管后，迟到结果只能返回 stale，不能覆盖新状态
- 人工库存重试按读取到的失败状态、尝试次数和目标版本做条件更新；若期间已被 worker 认领则返回冲突，不清除新 worker 的锁
- 货源缺货、下架、库存不可验证或已发布 SKU 消失时调用 `product.setOffline`；“已经下架”与“商品不存在”按幂等成功处理
- 类目目录使用 `shop.getShopCategory`，从 `cid=0` 开始按父节点递归，固定同步门捷列夫类目 `channel=0`；只把 `enable=true`、`is_leaf=true` 的节点作为可发布叶子类目
- 完整目录按授权店铺存储；远端全量拉取成功后才在单个数据库事务内替换旧快照，失败时保留上一次可用目录
- 类目候选使用抖店官方 `product.GetRecommendCategory`，并再次回查当前店铺已同步目录；平台未返回置信度时只展示官方排序，不伪造概率
- 用户确认类目时校验店铺目录，真实铺货入队和队列续跑前也会校验每个目标店铺的目录与叶子类目可用性
- 类目确认后按需调用 `product.getCatePropertyV2`，属性定义缓存到店铺类目快照并生成 schema 指纹；用户可主动刷新，新铺货和商品修正提交前也会刷新，变化后强制重新确认
- 常见文本、单选和多选属性支持官方选项与平台允许的自定义值；度量衡、级联、必填属性图等复杂规则在未支持前明确阻断，不把必然失败的任务送入平台
- 用户确认结果按货源商品 + 目标店铺存储，入队时固化到 `publish_tasks.category_property_snapshot`，`product.addV2` 使用官方 `product_format_new` 结构发布并在重试时复用
- 类目资质按需调用 `product.qualificationConfig`，缓存官方资质 schema、填写提示、基础必填状态和基于类目属性的动态必填规则；无法识别的规则安全阻断
- 资质确认按货源商品 + 目标店铺存储，类目资质 schema 或参与动态规则的属性值变化后旧确认失效；真实铺货入队前强制刷新官方规则并固化到 `publish_tasks.category_qualification_snapshot`
- 资质附件只接受公开 HTTPS URL，禁止本地路径、`data:`、HTTP、localhost 和私网 IP；`product.addV2` 使用官方 `quality_list` 提交，队列重试复用已校验快照
- 即使预检查通过，抖店仍可能根据店铺信息和商品属性在正式发布时追加资质要求；此类平台拒绝必须保留明确错误，不可降级为成功
- 已发布商品修正使用 `product.editV2`，提交前重新校验当前类目目录、类目属性、动态资质和发布 SKU；使用 `force_use_quality_list=true` 明确覆盖旧资质，空列表代表清空
- 抖店编辑接口不支持直接修改部分已发布商品类目；本地确认类目与首次发布类目不一致时拒绝编辑，要求按新类目重新铺货
- 每次修正记录尝试次数、尝试时间、最近成功时间与脱敏平台错误；平台驳回商品修正成功后本地转为待审核状态
- 真实 `product.addV2` 返回商品 ID 后本地先记为待审核，不把“已创建”误判为“已上线”；演示店铺仍直接在线
- 每个铺货任务按目标店铺持久化唯一 `supplier-${UUID}`，通过 `product.addV2.outer_product_id` 提交；同一任务的自动重试、人工重试和超时恢复始终复用原编码，不能重新生成
- `product.addV2` 报错或响应不确定时，使用 `product.detail` 的 `out_product_id` 查询，并设置 `show_draft=true` 覆盖草稿和审核中商品；查询结果必须包含合法商品 ID，若返回外部编码还必须与请求一致
- 真实平台适配器若不支持按外部编码恢复，必须在调用创建接口前阻断；平台恢复成功后，本地按 `task_id + shop_id` 幂等 upsert，避免数据库短暂失败或并发恢复产生重复铺货记录
- “我的铺货”可调用 `product.detail` 手工刷新平台状态；审核状态优先于上下架状态，将待审核/审核通过待上架映射为待审核，将审核不通过/封禁映射为驳回，将下线/删除映射为已下架
- 同步成功保存平台原始 `status/check_status` 与时间；失败保存脱敏错误且保留原本地业务状态，避免网络故障造成错误下架或错误上线
- 官方契约：[`sku.editPrice`](https://op.jinritemai.com/docs/api-docs/14/1822)、[`sku.syncStockBatchMultiProducts`](https://op.jinritemai.com/docs/api-docs/14/2847)、[`product.setOffline`](https://op.jinritemai.com/docs/api-docs/14/252)
- 类目官方契约：[`shop.getShopCategory`](https://op.jinritemai.com/docs/api-docs/14/1820)、[`product.GetRecommendCategory`](https://op.jinritemai.com/docs/api-docs/14/2004)
- 类目属性契约：[`product.getCatePropertyV2`](https://op.jinritemai.com/docs/api-docs/14/1373)、[`product.addV2`](https://op.jinritemai.com/docs/api-docs/14/249)
- 类目资质契约：[`product.qualificationConfig`](https://op.jinritemai.com/docs/api-docs/14/1382)、[`product.addV2`](https://op.jinritemai.com/docs/api-docs/14/249)
- 商品编辑与状态契约：[`product.editV2`](https://op.jinritemai.com/docs/api-docs/14/250)、[`product.detail`](https://op.jinritemai.com/docs/api-docs/14/56)
- 商品创建幂等恢复契约：[`product.addV2`](https://op.jinritemai.com/docs/api-docs/14/249) 推荐使用字符串 `outer_product_id` 建立开发者商品与抖店 `product_id` 的映射；[`product.detail`](https://op.jinritemai.com/docs/api-docs/14/56) 支持按 `out_product_id` 查询。官方 FAQ 192 说明外部编码由开发者定义，FAQ 3356 说明重复外部编码会拒绝再次创建
- 订单售后契约：[`order.orderDetail`](https://op.jinritemai.com/docs/api-docs/15/1343)；部分退款与已完成后退款的主状态限制参见官方 FAQ 451、3548、6053
- 演示店铺继续使用 Mock adapter；OAuth 抖店自动使用真实 adapter

## 4. R0-04 抖店 + 1688 真实联调权限清单

> 本节是 R0-04 的交付物，定义 R0-05 获取外部账号和权限时要逐项关闭的输入条件。清单完成不代表平台账号、权限或测试资金已经取得；在对应证据齐备前，R0-05 与 R1 真实 E2E 继续保持外部阻塞。

清单快照日期：2026-08-03。状态含义：`✅ 已具备` 表示已有可复核证据；`🟡 待核验` 表示需要在当前平台控制台读取准确值；`⛔ 待外部条件` 表示必须由主体持有人或平台完成；`⬜ 待工程验证` 表示外部条件齐备后才能执行。

本节列出的 `product.addV2`、`cross.keywords.search` 等是当前代码实际调用的 **API 方法名**，不是对官方 scope 名、权限包名或权限编码的推断。所有“官方 scope / 权限编码”必须由主体持有人从当前应用的权限页原样复制并留证；控制台没有显示或平台文档无法确认时统一记录为“待官方核验”，不得自行造名。

### 4.1 主体、测试账号与应用

| ID   | 平台 | 必备条件                                                                                                                               | 负责人                         | 当前状态      | 申请 / 配置入口                                                                | 关闭证据                                                                              |
| ---- | ---- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| D-01 | 抖店 | 可登录开放平台并创建工具型服务应用的主体账号；允许的主体类型、资质及应用与店铺的关系以当前控制台审核要求为准                           | 主体持有人（用户指定）         | ⛔ 待外部条件 | [抖店开放平台](https://op.jinritemai.com/)；具体应用类型和资质菜单待控制台核验 | 主体认证状态、主体名称脱敏截图、应用类型和审核要求截图                                |
| D-02 | 抖店 | 一家可绑定到测试应用的真实测试店，能创建测试商品、下单、退款、发货并查看平台订单；不得使用无授权的生产客户店                           | 抖店店主 / 主体持有人          | ⛔ 待外部条件 | 抖店开放平台应用控制台；“测试店 / 授权店”准确菜单名待控制台核验                | 脱敏店铺 ID、店铺状态、应用绑定关系和操作者授权记录                                   |
| D-03 | 抖店 | 已创建并审核到可联调状态的应用，取得 AppKey、AppSecret、Service ID；Secret 只写入密钥存储                                              | 主体持有人申请；工程负责人配置 | ⛔ 待外部条件 | [抖店开放平台](https://op.jinritemai.com/)应用控制台                           | 应用 ID、审核状态、Service ID、凭证配置时间；证据中不得出现 Secret                    |
| A-01 | 1688 | 可登录开放平台并创建买家采购场景应用的主体账号；主体类型、实名认证和应用类目以当前平台要求为准                                         | 主体持有人（用户指定）         | ⛔ 待外部条件 | [1688 开放平台](https://open.1688.com/)                                        | 主体认证状态、应用场景和审核要求的脱敏截图                                            |
| A-02 | 1688 | 一个已实名、可授权、可下单和人工付款的测试买家账号，配置测试人员控制的真实收货地址                                                     | 1688 买家账号持有人            | ⛔ 待外部条件 | 1688 买家账号与应用 OAuth 授权页                                               | 脱敏 member ID、账号状态、收货地址归属确认和付款人授权记录                            |
| A-03 | 1688 | 已创建并审核到可联调状态的应用，取得 AppKey、AppSecret，并为同一联调场景取得买家 OAuth 授权                                            | 主体持有人申请；工程负责人配置 | ⛔ 待外部条件 | [1688 开放平台](https://open.1688.com/)应用控制台                              | 应用 ID、审核状态、凭证配置时间、授权 member ID 和 Token 到期时间；不得保存明文 Token |
| A-04 | 1688 | 订购或开通 `cross.keywords.search`、`cross.productInfo.get` 所属的官方货源解决方案；方案准确名称、费用、配额和曝光回传义务以控制台为准 | 1688 主体持有人                | ⛔ 待外部条件 | 1688 开放平台的解决方案 / 能力订购入口；准确深链和菜单待官方核验               | 方案订单或开通状态、有效期、配额页、曝光回传要求截图                                  |

负责人使用角色而非个人姓名，是因为当前仓库没有主体持有人和店主名单。开始 R0-05 时必须在外部受控任务记录中补充具体姓名、联系方式和替补人；仓库只保留脱敏负责人和证据链接。

### 4.2 应用权限与待核验 scope

| ID   | 平台 | R1 必需能力                                 | 当前 adapter 实际调用                                                                                              | 官方 scope / 权限编码                                    | 负责人 / 状态           | 验证方式                                                                                                                       |
| ---- | ---- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| D-P1 | 抖店 | 商家 OAuth、Token 获取与刷新                | `token.create`、`token.refresh`                                                                                    | 待平台控制台核验                                         | 主体持有人 / 🟡 待核验  | 完成一次 OAuth，记录授权店铺、授权时间、Token 到期时间和刷新成功日志，不记录 Token 值                                          |
| D-P2 | 抖店 | 店铺类目、类目推荐、属性和资质规则          | `shop.getShopCategory`、`product.GetRecommendCategory`、`product.getCatePropertyV2`、`product.qualificationConfig` | 待平台控制台核验                                         | 主体持有人 / 🟡 待核验  | 每个方法至少一次真实成功响应；保存平台 request ID、类目 ID 和 schema 指纹                                                      |
| D-P3 | 抖店 | 商品创建、幂等恢复、编辑、状态回读和下架    | `product.addV2`、`product.detail`、`product.editV2`、`product.setOffline`                                          | 待平台控制台核验                                         | 主体持有人 / 🟡 待核验  | 同一测试商品完成创建、按外部编码恢复、状态回读、编辑重审和下架；记录 product ID 与审核截图                                     |
| D-P4 | 抖店 | SKU 改价与库存同步                          | `sku.editPrice`、`product.detail`、`sku.syncStockBatchMultiProducts`                                               | 待平台控制台核验                                         | 主体持有人 / 🟡 待核验  | 至少 2 个真实 SKU 分别完成比例改价、逐项目标价、价格回读和全量库存更新；保留请求 ID、改前/改后快照，并验证标题修正不回滚新价格 |
| D-P5 | 抖店 | 订单增量、单笔刷新与已付款订单隐私字段解密  | `order.searchList`、`order.orderDetail`、`order.batchDecrypt`                                                      | 待平台控制台核验；隐私字段能力是否需额外申请必须单独确认 | 主体持有人 / 🟡 待核验  | 同一已付款测试订单可查询、回读并解密测试人员授权的姓名 / 电话 / 地址；日志与仓库证据必须脱敏                                   |
| D-P6 | 抖店 | 承运商查询、单包 / 多包发货和已发货物流修正 | `order.logisticsCompanyList`、`order.logisticsAdd`、`order.logisticsAddMultiPack`、`order.logisticsEditByPack`     | 待平台控制台核验                                         | 主体持有人 / 🟡 待核验  | 单包和多包各成功一次；物流修正另做一次受控演练，保存 request ID、订单 ID 和平台回读快照                                        |
| A-P1 | 1688 | 买家 OAuth、Token 获取与刷新                | OAuth authorize、authorization code、refresh token 流程                                                            | 待平台控制台核验                                         | 主体持有人 / 🟡 待核验  | OAuth 后 readiness 出现真实买家，随后完成一次刷新；只保存 member ID、时间和结果                                                |
| A-P2 | 1688 | 买家货源搜索和详情                          | `cross.keywords.search`、`cross.productInfo.get`                                                                   | 待官方解决方案和应用权限页核验，不把方法名当 scope       | 主体持有人 / ⛔ 待 A-04 | 对同一 offer 保存搜索命中、详情、SKU、分销价、库存和图片的脱敏响应摘要，并记录配额消耗                                         |
| A-P3 | 1688 | 代发下单、未知结果恢复和买家订单详情        | `alibaba.trade.fastCreateOrder`、`alibaba.trade.getBuyerOrderList`、`alibaba.trade.get.buyerView`                  | 待平台控制台核验                                         | 主体持有人 / 🟡 待核验  | 用稳定 `outOrderId` 创建小额采购，按外部订单号恢复并回读同一远端订单及商品快照                                                 |
| A-P4 | 1688 | 买家物流查询                                | `alibaba.trade.getLogisticsInfos.buyerView`                                                                        | 待平台控制台核验                                         | 主体持有人 / 🟡 待核验  | 回读真实运单、承运商、状态和采购子项映射，平台数据与本地包裹逐项一致                                                           |

`alibaba.refund.create` 目前仅在能力规划中，当前采购 adapter 没有调用它；R1-05 首轮通过平台后台人工取消、退款或拦截并在 Supplier 中核销。因此它不是本轮 R0-05 的强制权限，后续实现自动售后时再按官方权限页补充，不能提前猜测 scope。

抖店 Webhook 同样不是 R1 首轮阻塞项：当前订单链路使用持久化增量轮询和单笔即时回读。若后续启用事件推送，必须另建验签、重放、乱序和对账清单，不得把“能配置回调”当作“事件已可靠消费”。

### 4.3 回调 URL 与环境变量

当前 staging 固定 BFF 入口为 `https://supplier-staging-gateway.chenjie.workers.dev`。平台控制台、BFF 平台变量和 OAuth 白名单必须使用下列 **完全一致** 的 URL；不允许通配符、HTTP、临时 Tunnel URL、末尾路径省略或另一个域名。

| 用途             | staging 目标值                                                                               | 配置位置                                            | 负责人                         | 当前状态 / 证据                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------- |
| 抖店 OAuth 回调  | `https://supplier-staging-gateway.chenjie.workers.dev/api/shops/oauth/douyin/callback`       | 抖店应用控制台 + `DOUYIN_OAUTH_REDIRECT_URI`        | 主体持有人登记；工程负责人回填 | ⛔ 控制台待登记；BFF 值待外部凭证就绪后复核                                     |
| 1688 OAuth 回调  | `https://supplier-staging-gateway.chenjie.workers.dev/api/shops/oauth/alibaba_1688/callback` | 1688 应用控制台 + `ALIBABA_1688_OAUTH_REDIRECT_URI` | 主体持有人登记；工程负责人回填 | ⛔ 控制台待登记；BFF 值待外部凭证就绪后复核                                     |
| BFF 精确白名单   | 上述两个 URL，以逗号分隔                                                                     | `OAUTH_CALLBACK_ALLOWLIST`                          | 工程负责人                     | ⬜ 部署时用 readiness 和授权跳转验证                                            |
| OAuth 安全回退页 | `https://<稳定 Web 域名>/settings`                                                           | `OAUTH_RESULT_REDIRECT_URL`                         | 工程负责人                     | ⛔ 依赖 R0-03 稳定 Web URL；同时限定上下文回跳的可信 origin，不得填预览随机域名 |
| Web 调用 BFF     | `https://supplier-staging-gateway.chenjie.workers.dev`                                       | Web 的 `NEXT_PUBLIC_BFF_URL`                        | 工程负责人                     | ⬜ 与最终 Web 部署一起复核                                                      |
| BFF 允许 Web     | `https://<稳定 Web 域名>`                                                                    | `CORS_ORIGINS`                                      | 工程负责人                     | ⛔ 依赖 R0-03 稳定 Web URL                                                      |

生产式 OAuth 还必须配置可用的 `REDIS_URL`、至少 32 字符随机 `ENCRYPTION_KEY` 和 60–900 秒的 `OAUTH_STATE_TTL_SECONDS`。Redis 保存一次性 state 和短期用户绑定结果 token，数据库只保存 AES-256-GCM 加密后的平台 Token；截图、日志、提交、工单和聊天中均不得出现 AppSecret、access token、refresh token、收货地址明文或完整手机号。

| 平台 / 阶段           | 必填环境变量                                                                                                                                                        | 开关顺序与安全约束                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 抖店授权与发布        | `DOUYIN_APP_KEY`、`DOUYIN_APP_SECRET`、`DOUYIN_SERVICE_ID`、`DOUYIN_CUSTOMER_MOBILE`、`DOUYIN_OAUTH_REDIRECT_URI`、`DOUYIN_OAUTH_SANDBOX=false`                     | 先写密钥并完成 OAuth；当前使用正式网关 + 测试店，不虚构独立 sandbox 域名                                                                                  |
| 抖店订单同步          | `DOUYIN_ORDER_SYNC_ENABLED`、`DOUYIN_ORDER_SYNC_INTERVAL_MS`、`DOUYIN_ORDER_SYNC_LOOKBACK_DAYS`、`DOUYIN_ORDER_SYNC_OVERLAP_SECONDS`、`DOUYIN_ORDER_SYNC_MAX_PAGES` | 凭证、真实店和订单读取权限未通过前保持 `false`；首次手工同步成功后再开启 worker                                                                           |
| 抖店库存同步          | `INVENTORY_SYNC_ENABLED`、`INVENTORY_SYNC_POLL_MS`、`INVENTORY_SYNC_MAX_ATTEMPTS`                                                                                   | 真实商品、`outer_sku_id = 1688 specId` 和库存权限验证前保持 `false`                                                                                       |
| 1688 OAuth 与人工支付 | `ALIBABA_1688_APP_KEY`、`ALIBABA_1688_APP_SECRET`、`ALIBABA_1688_OAUTH_REDIRECT_URI`、`ALIBABA_1688_PAYMENT_MODE=manual`                                            | 首期禁止免密自动扣款；必须由授权付款人到 1688 核对 offer、SKU、数量、地址和金额后付款                                                                     |
| 1688 真实采购         | `ALIBABA_1688_PURCHASE_ENABLED`                                                                                                                                     | 初始保持 `false`；其余 7 项 1688 readiness 通过、预算获批并完成创建前人工复核后，才由工程负责人显式改为 `true`                                            |
| 1688 已履约巡检       | `ALIBABA_1688_PURCHASE_AUDIT_ENABLED`、`ALIBABA_1688_PURCHASE_AUDIT_INTERVAL_MS`、`ALIBABA_1688_PURCHASE_AUDIT_BATCH_SIZE`                                          | 只有真实采购已开启且首笔已发货订单对账完成后才启用；首次 E2E 不把巡检开关当成前置条件                                                                     |
| 1688 持久货源采集     | `SOURCE_IMPORT_ENABLED`、`SOURCE_IMPORT_POLL_MS`、`SOURCE_IMPORT_MAX_ATTEMPTS`、`ALIBABA_1688_SOURCE_DATA_SCOPE`、1688 OAuth 凭证                                   | 初始保持 `false`；应用最新 migration、验证买家 Token/配额/曝光回传和跨买家数据一致后，才设置 `global_offer` 并启用 worker；Redis 限流不可用时 fail-closed |
| 1688 货源采集 CLI     | 临时进程变量 `ALIBABA_1688_APP_KEY`、`ALIBABA_1688_APP_SECRET`、`ALIBABA_1688_ACCESS_TOKEN`；可选搜索场景与筛选变量                                                 | 只保留为受控联调/诊断入口，不作为 SaaS 用户工作流；短时注入 Token 并在结束后清除，不写入仓库、命令历史或证据                                              |

### 4.4 测试商品、订单、金额与物流数据

所有测试对象都必须是平台上的真实业务对象，但只能使用测试人员明确控制的账号、店铺、电话和收货地址。不得使用虚假运单、随机他人地址、生产客户订单或无法追回的高额商品。

| ID   | 测试数据        | 最低准备要求                                                                                                                    | 负责人                                    | 当前状态      | 需记录的脱敏证据                                                                         |
| ---- | --------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------- | ---------------------------------------------------------------------------------------- |
| T-01 | 1688 基准货源 A | 在线且支持一件代发；至少 2 个可售 SKU；有主图、稳定 offerId / supplierId / specId、分销价和可验证库存；供应商确认可正常单包发货 | 选品负责人 + 1688 买家                    | ⛔ 待外部条件 | offerId、supplierId、两个 specId、采集时间、价格 / 库存快照和一件代发标记                |
| T-02 | 1688 多包货源 B | 第二供应商的一件代发商品，或已书面确认会拆成两包的供应商 / 商品组合；不能在下单后才假设会多包                                   | 选品负责人 + 供应商联系人                 | ⛔ 待外部条件 | offer / spec / supplier ID、拆包约定、预计承运商和联系记录                               |
| T-03 | 抖店发布候选    | T-01 映射到测试店当前可发布叶子类目；主图合规；所有必填属性、动态资质和客服电话齐全；初次选择低风险、低客诉类目                 | 商品运营 + 店主                           | ⛔ 待外部条件 | 类目 ID、属性 / 资质 schema 指纹、确认快照、外部商品编码和发布前利润预览                 |
| T-04 | 单包订单        | 测试买家购买 1 个 SKU × 1；使用测试人员同意的真实姓名、电话和地址；订单完成支付后由 T-01 对应采购生成一个真实包裹               | 抖店测试买家 + 1688 付款人                | ⛔ 待外部条件 | 抖店父 / 子订单 ID、实付金额、1688 订单 ID、outOrderId、采购金额、一个真实运单及平台回读 |
| T-05 | 多包订单        | 购买能稳定路由到两个采购单或两个真实包裹的至少 2 个子项；付款前确认供应商可履约，包裹必须覆盖全部子项且不重不漏                 | 抖店测试买家 + 1688 付款人 + 供应商联系人 | ⛔ 待外部条件 | 两侧订单 ID、每包承运商 / 运单号、采购子项 → 销售子项 → 包裹的数量映射和抖店回读         |
| T-06 | 退款 / 取消数据 | 至少准备一次采购前整单退款或关闭、一次部分退款暂停；采购后的取消 / 退款只在供应商明确可配合且预算已批准时执行                   | 商品运营 + 付款人                         | ⛔ 待外部条件 | 售后状态指纹、平台退款结果、实际退款金额、最终采购成本和人工处置依据                     |
| T-07 | 物流修正数据    | 在测试人员和供应商均确认的订单上准备一次运单或承运商修正；原路由、新路由和修正时间可从两端回读                                  | 物流测试负责人 + 供应商联系人             | ⛔ 待外部条件 | 修正前后平台快照、异常 revision、租约 / 审计记录和最终一致性核对                         |

金额不是平台门槛，而是内部风险上限。开始前由主体持有人在外部测试单中填写并批准以下三个值：`单笔抖店实付上限`、`单笔 1688 采购上限`、`本轮总现金占用上限`。默认建议每笔实付和采购均不超过 ¥100，但这只是建议上限，不是已获授权的预算；未填写批准人、金额和退款去向时不得付款。每次 1688 付款前仍需人工核对采购商品、规格、数量、收货地址、供应商和最终金额。

物流必须使用供应商真实发出的承运商与运单号。测试记录需同时保存 `抖店子订单 ID ↔ 1688 order entry ID ↔ 包裹 ↔ 运单` 的数量映射；单包、多包、物流修正分别验收，不能用同一张静态截图替代平台回读。

### 4.5 自动准备度与人工缺口

使用已登录的 staging 测试用户访问下列只读接口。返回值不包含密钥；证据中仍要脱敏店铺名、商品名和业务 ID。两个接口的 `ready=true` 是开始真实动作的必要条件，不是平台权限已获批的充分条件。

| 接口                                          | 自动检查 ID                                                                                                                                                   | 自动证明的内容                                                                                                                                 | 仍不能证明                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET /api/shops/oauth/douyin/readiness`       | `app_credentials`、`oauth_security`、`customer_mobile`、`order_sync`、`authorized_shop`、`publish_candidate`                                                  | 应用变量、精确回调 / 返回页、加密与 Redis、客服电话、订单 worker 开关、真实授权店和至少一个有主图且已确认抖店类目的货源                        | 官方 scope / 权限编码、应用审核状态、测试店绑定资格、API 配额、隐私字段权限、真实发布 / 下单 / 发货成功           |
| `GET /api/shops/oauth/alibaba_1688/readiness` | `app_credentials`、`oauth_security`、`payment_strategy`、`purchase_enabled`、`authorized_buyer`、`structured_address`、`sku_binding`、`multi_purchase_orders` | 应用变量、OAuth 安全、人工支付模式、真实采购开关、真实买家 Token、订单结构化地址、销售 SKU 到 offer / spec / supplier 的绑定和按供应商拆单能力 | 官方方案订购、scope / 权限编码、搜索 / 详情配额、曝光回传义务、买家余额 / 付款授权、供应商真实发货和平台 API 成功 |

开关验证顺序：

1. 所有凭证写入受控密钥存储，真实动作开关保持 `false`。
2. 完成两个平台 OAuth；从设置页确认真实授权对象，不接受 `demo-` 店铺。
3. 抖店除 `order_sync` 外全部通过后，先手工同步一笔测试订单，再开启 `DOUYIN_ORDER_SYNC_ENABLED=true` 并复查 readiness。
4. 1688 除 `purchase_enabled` 外全部通过后，由付款人批准预算和首笔采购快照，再开启 `ALIBABA_1688_PURCHASE_ENABLED=true` 并复查 readiness。
5. 只有 readiness 全绿且 4.2 的官方权限证据齐备，才执行 T-04；T-04 对账成功后再执行 T-05～T-07。

### 4.6 证据包与 R0-05 解锁条件

| 证据组            | 必须包含                                                                                 | 禁止包含                                             | 验收人                      |
| ----------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------- |
| E-01 主体与应用   | 主体 / 店铺 / 应用脱敏 ID、应用类型、审核状态、测试店绑定关系                            | 身份证、营业执照原图等非必要高敏材料                 | 产品负责人 + 主体持有人     |
| E-02 权限         | 每个 D-P / A-P 行对应的控制台准确权限名、scope / 编码、状态、有效期、配额和申请单号      | 推测名称、仅有 API 文档但没有本应用授权状态          | 工程负责人 + 主体持有人     |
| E-03 OAuth 与配置 | 两个精确回调截图、授权对象、授权 / 刷新时间、Token 到期时间、两份 readiness JSON         | AppSecret、access token、refresh token、完整环境文件 | 工程负责人                  |
| E-04 商品与订单   | offer / spec / supplier、抖店 product / order、1688 order / outOrderId、金额和状态时间线 | 生产客户数据、未脱敏姓名 / 电话 / 地址               | 商品运营 + 工程负责人       |
| E-05 物流与售后   | 单包 / 多包映射、真实运单平台回读、退款 / 取消结果、最终成本核销、异常恢复审计           | 虚假运单、只有本地成功而无平台回读的结论             | 物流测试负责人 + 财务核对人 |
| E-06 API 运行证据 | 时间、环境、脱敏 trace / request ID、方法名、结果码、重试 / 恢复结果和对账结论           | 原始敏感请求体、签名、Token 和 Secret                | 工程负责人                  |

R0-05 只有在 D-01～D-03、A-01～A-04、D-P1～D-P6、A-P1～A-P4 全部有证据，并且测试预算、收货信息和供应商配合人已批准后才能从“待外部条件”转为“进行中”。R1-02～R1-04 只有在相应测试对象真实完成且两端回读一致后才能转绿；readiness、截图或 Mock 测试均不能单独替代真实 E2E。

证据原件放在访问受控的测试记录中，仓库仅在 [09-main-flow.md](./09-main-flow.md) 写入脱敏摘要和证据链接。任何密钥或个人信息一旦误入证据，先撤销 / 轮换并清理，再继续联调。

## 5. 淘宝开放平台（TOP）

### 5.1 关键能力

| 能力     | API                                      |
| -------- | ---------------------------------------- |
| OAuth    | `taobao.oauth2`                          |
| 商品发布 | `taobao.item.add` / `taobao.item.update` |
| 类目     | `taobao.itemcats.get`                    |
| 类目属性 | `taobao.itemprops.get`                   |
| 订单     | `taobao.trades.sold.get`                 |
| 物流     | `taobao.logistics.online.send`           |

### 5.2 商家类型差异

- 普通卖家、天猫商家接口权限不同
- 千牛工作台插件 vs 服务市场应用走不同入口

## 6. 拼多多开放平台

| 能力  | API                             |
| ----- | ------------------------------- |
| OAuth | `pdd.oauth.access.token.create` |
| 商品  | `pdd.goods.add`                 |
| 订单  | `pdd.order.list.get`            |
| 物流  | `pdd.logistics.online.send`     |

特点：审核严格，对图文合规要求最高。

## 7. 抽象适配层设计

### 7.1 统一接口（TypeScript）

```typescript
// packages/platform-sdk/src/types.ts
export interface PlatformAdapter {
  platform: PlatformType;

  // 授权
  buildAuthUrl(state: string): string;
  exchangeToken(code: string): Promise<TokenSet>;
  refreshToken(refreshToken: string): Promise<TokenSet>;

  // 商品
  publishProduct(token: string, dto: PublishProductDto): Promise<PublishResult>;
  updateProduct(token: string, dto: UpdateProductDto): Promise<void>;
  offlineProduct(token: string, productId: string): Promise<void>;

  // 类目
  getCategoryTree(token: string): Promise<CategoryNode[]>;
  getCategoryAttributes(token: string, categoryId: string): Promise<CategoryAttr[]>;

  // 订单
  listOrders(token: string, query: OrderQuery): Promise<Order[]>;
  getOrder?(token: string, platformOrderId: string): Promise<Order>;
  shipOrder(token: string, dto: ShipDto): Promise<void>;
}
```

### 7.2 实现按平台拆分

```
packages/platform-sdk/
├── src/
│   ├── types.ts
│   ├── base.ts            # 通用 OAuth、签名、重试
│   ├── adapters/
│   │   ├── alibaba1688.ts
│   │   ├── douyin.ts
│   │   ├── taobao.ts
│   │   ├── pdd.ts
│   │   └── kuaishou.ts
│   └── index.ts
```

### 7.3 核心横切关注点

| 关注点     | 实现                                      |
| ---------- | ----------------------------------------- |
| 签名       | 各平台不同（HMAC-SHA256 / MD5），统一封装 |
| Token 刷新 | 提前 5min 自动刷新；失败回退 OAuth        |
| 限流       | 令牌桶 + 平台维度独立                     |
| 重试       | 幂等键 + 指数退避（仅安全方法）           |
| 错误映射   | 各平台错误码 → 统一枚举                   |
| 日志       | 全量出入参（敏感信息脱敏）                |

## 8. 类目映射策略

### 8.1 离线建表

```
1688 类目（全量） + 抖音/淘宝/拼多多 类目 → 多模态 Embedding → Milvus
```

### 8.2 在线映射

```
商品标题 + 主图 → Embedding → Milvus 检索 → 候选 Top5 → LLM 裁决 → 返回 Top1
```

### 8.3 准确率提升

- 用历史成功铺货数据做反馈，迭代向量与规则
- 高频类目人工兜底校准

## 9. 鉴权与 Token 安全

- Token 加密存储：AES-256-GCM + KMS
- 解密只在内存中、用完即弃
- 审计：每次 Token 使用记录 trace_id
- 异常检测：Token 异地调用告警

## 10. Webhook 接入

| 平台   | 事件                            |
| ------ | ------------------------------- |
| 抖店   | 订单创建/支付/退款/发货状态变更 |
| 淘宝   | TMC 消息（订单、退款、商品）    |
| 拼多多 | 订单状态变更                    |

**架构**：网关接收 → 验签 → 入 Kafka → 业务消费

## 11. 开发与测试

| 环境    | 用途                                      |
| ------- | ----------------------------------------- |
| sandbox | 平台测试环境；抖店使用正式网关 + 测试店铺 |
| dev     | 内部联调，使用真实测试店铺                |
| staging | 上线前验证，真实账号但限流                |
| prod    | 生产                                      |

## 12. 上架服务市场流程（1688）

1. 注册开发者账号 + 实名认证
2. 创建应用，获取 AppKey/AppSecret
3. 开发完成 + 等保备案
4. 提交服务市场审核（资质、合规、隐私）
5. 内测发布（小范围邀请码）
6. 正式发布 + 推荐位申请
