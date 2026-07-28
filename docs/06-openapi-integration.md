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
| 商品状态   | `product.detail`                  | 查询上下架状态与审核状态                       |
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
- OAuth 完成后由 BFF 通过 `OAUTH_RESULT_REDIRECT_URL` 安全跳回 Web 设置页，页面展示成功/失败结果后清理 URL 参数
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
- 官方契约：[`sku.syncStockBatchMultiProducts`](https://op.jinritemai.com/docs/api-docs/14/2847)、[`product.setOffline`](https://op.jinritemai.com/docs/api-docs/14/252)
- 类目官方契约：[`shop.getShopCategory`](https://op.jinritemai.com/docs/api-docs/14/1820)、[`product.GetRecommendCategory`](https://op.jinritemai.com/docs/api-docs/14/2004)
- 类目属性契约：[`product.getCatePropertyV2`](https://op.jinritemai.com/docs/api-docs/14/1373)、[`product.addV2`](https://op.jinritemai.com/docs/api-docs/14/249)
- 类目资质契约：[`product.qualificationConfig`](https://op.jinritemai.com/docs/api-docs/14/1382)、[`product.addV2`](https://op.jinritemai.com/docs/api-docs/14/249)
- 商品编辑与状态契约：[`product.editV2`](https://op.jinritemai.com/docs/api-docs/14/250)、[`product.detail`](https://op.jinritemai.com/docs/api-docs/14/56)
- 商品创建幂等恢复契约：[`product.addV2`](https://op.jinritemai.com/docs/api-docs/14/249) 推荐使用字符串 `outer_product_id` 建立开发者商品与抖店 `product_id` 的映射；[`product.detail`](https://op.jinritemai.com/docs/api-docs/14/56) 支持按 `out_product_id` 查询。官方 FAQ 192 说明外部编码由开发者定义，FAQ 3356 说明重复外部编码会拒绝再次创建
- 订单售后契约：[`order.orderDetail`](https://op.jinritemai.com/docs/api-docs/15/1343)；部分退款与已完成后退款的主状态限制参见官方 FAQ 451、3548、6053
- 演示店铺继续使用 Mock adapter；OAuth 抖店自动使用真实 adapter

## 4. 淘宝开放平台（TOP）

### 4.1 关键能力

| 能力     | API                                      |
| -------- | ---------------------------------------- |
| OAuth    | `taobao.oauth2`                          |
| 商品发布 | `taobao.item.add` / `taobao.item.update` |
| 类目     | `taobao.itemcats.get`                    |
| 类目属性 | `taobao.itemprops.get`                   |
| 订单     | `taobao.trades.sold.get`                 |
| 物流     | `taobao.logistics.online.send`           |

### 4.2 商家类型差异

- 普通卖家、天猫商家接口权限不同
- 千牛工作台插件 vs 服务市场应用走不同入口

## 5. 拼多多开放平台

| 能力  | API                             |
| ----- | ------------------------------- |
| OAuth | `pdd.oauth.access.token.create` |
| 商品  | `pdd.goods.add`                 |
| 订单  | `pdd.order.list.get`            |
| 物流  | `pdd.logistics.online.send`     |

特点：审核严格，对图文合规要求最高。

## 6. 抽象适配层设计

### 6.1 统一接口（TypeScript）

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

### 6.2 实现按平台拆分

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

### 6.3 核心横切关注点

| 关注点     | 实现                                      |
| ---------- | ----------------------------------------- |
| 签名       | 各平台不同（HMAC-SHA256 / MD5），统一封装 |
| Token 刷新 | 提前 5min 自动刷新；失败回退 OAuth        |
| 限流       | 令牌桶 + 平台维度独立                     |
| 重试       | 幂等键 + 指数退避（仅安全方法）           |
| 错误映射   | 各平台错误码 → 统一枚举                   |
| 日志       | 全量出入参（敏感信息脱敏）                |

## 7. 类目映射策略

### 7.1 离线建表

```
1688 类目（全量） + 抖音/淘宝/拼多多 类目 → 多模态 Embedding → Milvus
```

### 7.2 在线映射

```
商品标题 + 主图 → Embedding → Milvus 检索 → 候选 Top5 → LLM 裁决 → 返回 Top1
```

### 7.3 准确率提升

- 用历史成功铺货数据做反馈，迭代向量与规则
- 高频类目人工兜底校准

## 8. 鉴权与 Token 安全

- Token 加密存储：AES-256-GCM + KMS
- 解密只在内存中、用完即弃
- 审计：每次 Token 使用记录 trace_id
- 异常检测：Token 异地调用告警

## 9. Webhook 接入

| 平台   | 事件                            |
| ------ | ------------------------------- |
| 抖店   | 订单创建/支付/退款/发货状态变更 |
| 淘宝   | TMC 消息（订单、退款、商品）    |
| 拼多多 | 订单状态变更                    |

**架构**：网关接收 → 验签 → 入 Kafka → 业务消费

## 10. 开发与测试

| 环境    | 用途                                      |
| ------- | ----------------------------------------- |
| sandbox | 平台测试环境；抖店使用正式网关 + 测试店铺 |
| dev     | 内部联调，使用真实测试店铺                |
| staging | 上线前验证，真实账号但限流                |
| prod    | 生产                                      |

## 11. 上架服务市场流程（1688）

1. 注册开发者账号 + 实名认证
2. 创建应用，获取 AppKey/AppSecret
3. 开发完成 + 等保备案
4. 提交服务市场审核（资质、合规、隐私）
5. 内测发布（小范围邀请码）
6. 正式发布 + 推荐位申请
