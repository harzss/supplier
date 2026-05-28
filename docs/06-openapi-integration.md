# 平台 OpenAPI 接入方案

> **原则**：仅使用官方 OpenAPI，不做账号 Cookie、不做爬虫黑产。所有授权走 OAuth 2.0。

## 1. 平台清单

| 平台 | 接入入口 | 角色 | 优先级 |
|---|---|---|---|
| 1688 | open.1688.com | 采购方（货源 + 代发） | P0 |
| 抖音小店 | op.jinritemai.com | 销售方 | P0 |
| 淘宝 / 天猫 | open.taobao.com | 销售方 | P0 |
| 拼多多 | open.pinduoduo.com | 销售方 | P1 |
| 快手小店 | open.kwaixiaodian.com | 销售方 | P1 |
| 视频号小店 | open.weixin.qq.com | 销售方 | P2 |

## 2. 1688 OpenAPI 接入

### 2.1 关键能力

| 能力 | 接口（示意） | 说明 |
|---|---|---|
| OAuth 授权 | `/auth/authorize` | 买家授权 |
| 商品搜索 | `alibaba.product.search` | 选品采集 |
| 商品详情 | `alibaba.product.get` | SKU、图片 |
| 类目树 | `alibaba.category.get` | 类目映射 |
| 下单 | `alibaba.trade.fastCreate` | 代发下单 |
| 物流查询 | `alibaba.logistics.trace` | 运单跟踪 |
| 售后 | `alibaba.refund.create` | 退款 |

### 2.2 服务市场上架要求

- 完成开发者实名认证
- 应用通过审核（隐私政策、用户协议）
- 等保 2.0 三级（硬要求之一）
- 提供测试账号供平台审核

### 2.3 限流与配额

- 普通应用：500 次 / 分钟 / 接口
- 服务市场应用：可申请提升到 5000 次 / 分钟
- **应对**：本地缓存 + 增量同步 + 异步队列

## 3. 抖音小店 OpenAPI

### 3.1 关键能力

| 能力 | 接口 | 说明 |
|---|---|---|
| OAuth 授权 | `oauth/authorize` | 商家授权 |
| 商品发布 | `product.add` | 上架 |
| 商品编辑 | `product.editV2` | 修改 |
| 类目获取 | `shop.category.get` | 类目树 |
| 类目属性 | `category.getAttrInfo` | 属性必填项 |
| 订单列表 | `order.searchList` | 订单同步 |
| 订单详情 | `order.detail` | 详情 |
| 物流回填 | `order.logisticsAdd` | 发货 |

### 3.2 关键约束

- 主图必须 800x800 以上、白底或纯色背景（部分类目）
- 标题不能含极限词、明星名
- 类目属性必填项每个类目不同（要做属性映射表）
- Webhook 推送订单/退款事件

### 3.3 沙箱

抖店有 sandbox 环境，开发期可用，避免污染线上。

## 4. 淘宝开放平台（TOP）

### 4.1 关键能力

| 能力 | API |
|---|---|
| OAuth | `taobao.oauth2` |
| 商品发布 | `taobao.item.add` / `taobao.item.update` |
| 类目 | `taobao.itemcats.get` |
| 类目属性 | `taobao.itemprops.get` |
| 订单 | `taobao.trades.sold.get` |
| 物流 | `taobao.logistics.online.send` |

### 4.2 商家类型差异

- 普通卖家、天猫商家接口权限不同
- 千牛工作台插件 vs 服务市场应用走不同入口

## 5. 拼多多开放平台

| 能力 | API |
|---|---|
| OAuth | `pdd.oauth.access.token.create` |
| 商品 | `pdd.goods.add` |
| 订单 | `pdd.order.list.get` |
| 物流 | `pdd.logistics.online.send` |

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

| 关注点 | 实现 |
|---|---|
| 签名 | 各平台不同（HMAC-SHA256 / MD5），统一封装 |
| Token 刷新 | 提前 5min 自动刷新；失败回退 OAuth |
| 限流 | 令牌桶 + 平台维度独立 |
| 重试 | 幂等键 + 指数退避（仅安全方法） |
| 错误映射 | 各平台错误码 → 统一枚举 |
| 日志 | 全量出入参（敏感信息脱敏） |

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

| 平台 | 事件 |
|---|---|
| 抖店 | 订单创建/支付/退款/发货状态变更 |
| 淘宝 | TMC 消息（订单、退款、商品） |
| 拼多多 | 订单状态变更 |

**架构**：网关接收 → 验签 → 入 Kafka → 业务消费

## 10. 开发与测试

| 环境 | 用途 |
|---|---|
| sandbox | 平台沙箱（抖店/淘宝有，1688/拼多多基本没有） |
| dev | 内部联调，使用真实测试店铺 |
| staging | 上线前验证，真实账号但限流 |
| prod | 生产 |

## 11. 上架服务市场流程（1688）

1. 注册开发者账号 + 实名认证
2. 创建应用，获取 AppKey/AppSecret
3. 开发完成 + 等保备案
4. 提交服务市场审核（资质、合规、隐私）
5. 内测发布（小范围邀请码）
6. 正式发布 + 推荐位申请
