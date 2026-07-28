# 核心数据模型

> 当前数据层：Supabase / PostgreSQL 15（业务主库 + Auth + Storage）、Redis（缓存与锁）；Milvus 为后续向量规模化选项。
> 货源大表（source_products）若达到亿级再考虑 Citus 分区或独立 PG 集群。

> **权威说明**：当前可执行数据库定义以 `packages/db/prisma/schema.prisma` 和 `packages/db/prisma/migrations/` 为准。下方 MySQL DDL 是早期容量设计草案，不能用于当前环境建库、迁移或 schema diff。

## 1. 实体关系（ER 概览）

```mermaid
erDiagram
    USER ||--o{ SHOP : owns
    SHOP ||--o{ SHOP_CATEGORY : exposes
    SHOP ||--o{ PRODUCT_CATEGORY_PROPERTY_MAPPING : validates
    USER ||--o{ SUBSCRIPTION : has
    SHOP ||--o{ PUBLISH_TASK : creates
    SHOP ||--o{ ORDER : receives
    SOURCE_PRODUCT ||--o{ PUBLISH_TASK : selected_in
    SOURCE_PRODUCT ||--|| PRODUCT_SCORE : scored_by
    SOURCE_PRODUCT ||--o{ PRODUCT_CATEGORY_PROPERTY_MAPPING : configures
    PUBLISH_TASK ||--o{ PUBLISHED_PRODUCT : produces
    PUBLISHED_PRODUCT ||--o{ ORDER : sold_in
    ORDER ||--o| PURCHASE_ORDER : triggers
    USER ||--o{ AI_USAGE : consumes
    USER ||--o{ AUDIT_LOG : acts

    USER {
        bigint id PK
        string phone
        string wechat_unionid
        string nickname
        enum plan
        timestamp created_at
    }
    SHOP {
        bigint id PK
        bigint user_id FK
        enum platform
        string platform_shop_id
        string shop_name
        string access_token_enc
        timestamp token_expire_at
    }
    SHOP_CATEGORY {
        bigint id PK
        bigint shop_id FK
        int channel
        string category_id
        string parent_id
        string path
        boolean is_leaf
        boolean enabled
        timestamp synced_at
    }
    PRODUCT_CATEGORY_PROPERTY_MAPPING {
        bigint id PK
        bigint user_id FK
        bigint source_product_id FK
        bigint shop_id FK
        string category_id
        string schema_fingerprint
        json values
        timestamp confirmed_at
    }
    SOURCE_PRODUCT {
        bigint id PK
        string product_id_1688
        string title
        decimal price
        string main_image
        json sku_list
        string category_path
    }
    PRODUCT_SCORE {
        bigint product_id PK
        float demand_score
        float competition_score
        float profit_score
        float compliance_score
        float overall_score
        json reason
    }
    PUBLISH_TASK {
        bigint id PK
        bigint shop_id FK
        bigint source_product_id FK
        enum status
        json ai_optimized
        timestamp created_at
    }
    PUBLISHED_PRODUCT {
        bigint id PK
        bigint task_id FK
        bigint shop_id FK
        string platform_product_id
        decimal sale_price
        timestamp published_at
    }
    ORDER {
        bigint id PK
        bigint shop_id FK
        bigint published_product_id FK
        string platform_order_id
        decimal amount
        enum status
        timestamp paid_at
    }
    PURCHASE_ORDER {
        bigint id PK
        bigint order_id FK
        string order_id_1688
        enum status
        string tracking_no
    }
    AI_USAGE {
        bigint id PK
        bigint user_id FK
        enum module
        string model
        int input_tokens
        int output_tokens
        decimal cost_cny
        timestamp created_at
    }
    SUBSCRIPTION {
        bigint id PK
        bigint user_id FK
        enum plan
        date start_date
        date end_date
        enum status
    }
    AUDIT_LOG {
        bigint id PK
        bigint user_id FK
        string action
        enum outcome
        int status_code
        string request_id
        string ip_hash
        timestamp created_at
    }
    OPERATIONAL_ALERT {
        bigint id PK
        string key UK
        string type
        enum severity
        enum status
        int occurrences
        timestamp last_seen_at
    }
```

## 2. 核心表 Schema（历史 MySQL 设计草案）

本节仅保留早期字段和容量规划背景。当前应用使用 PostgreSQL、Prisma snake_case 映射和正式 migration；字段、enum、索引、外键与默认值必须从权威 schema 读取。

### 2.1 用户与店铺

```sql
-- 用户表
CREATE TABLE users (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  phone         VARCHAR(20)  UNIQUE,
  wechat_unionid VARCHAR(64) UNIQUE,
  nickname      VARCHAR(64),
  avatar_url    VARCHAR(512),
  plan          ENUM('free','basic','pro','flagship') DEFAULT 'free',
  status        ENUM('active','disabled') DEFAULT 'active',
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_plan (plan)
);

-- 店铺授权表（销售店铺 + 1688 采购账号）
CREATE TABLE shops (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id         BIGINT NOT NULL,
  platform        ENUM('taobao','tmall','douyin','pdd','kuaishou','alibaba_buyer') NOT NULL,
  platform_shop_id VARCHAR(64) NOT NULL,
  shop_name       VARCHAR(128),
  role            ENUM('seller','buyer') NOT NULL DEFAULT 'seller',
  access_token_enc VARCHAR(1024),  -- KMS 加密
  refresh_token_enc VARCHAR(1024),
  token_expire_at DATETIME,
  status          ENUM('active','expired','revoked') DEFAULT 'active',
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_user_platform_shop (user_id, platform, platform_shop_id),
  INDEX idx_user (user_id)
);
```

### 2.2 选品与货源

```sql
-- 1688 货源池（TiDB，亿级，分区按 category_l1）
CREATE TABLE source_products (
  id                 BIGINT PRIMARY KEY AUTO_INCREMENT,
  product_id_1688    VARCHAR(32) NOT NULL,
  supplier_id        VARCHAR(32),
  title              VARCHAR(255),
  price              DECIMAL(10,2),
  price_min          DECIMAL(10,2),
  price_max          DECIMAL(10,2),
  main_image         VARCHAR(512),
  detail_images      JSON,
  category_path      VARCHAR(255),
  category_l1        VARCHAR(64),
  category_l2        VARCHAR(64),
  sku_list           JSON,
  attributes         JSON,
  monthly_sold       INT DEFAULT 0,
  is_cross_border    BOOLEAN DEFAULT FALSE,
  is_one_piece_drop  BOOLEAN DEFAULT FALSE,  -- 是否支持一件代发
  raw_payload        JSON,
  synced_at          DATETIME,
  UNIQUE KEY uk_product_id (product_id_1688),
  INDEX idx_category_l1 (category_l1),
  INDEX idx_synced_at (synced_at)
) PARTITION BY HASH(id) PARTITIONS 16;

-- 选品打分
CREATE TABLE product_scores (
  product_id          BIGINT PRIMARY KEY,
  demand_score        FLOAT,    -- 需求度（外部爆款信号）
  competition_score   FLOAT,    -- 竞争度（同款数量）
  profit_score        FLOAT,    -- 利润空间
  compliance_score    FLOAT,    -- 合规风险（反向）
  trend_score         FLOAT,    -- 趋势热度
  overall_score       FLOAT,    -- 综合分
  reason              JSON,     -- LLM 生成的推荐理由
  features            JSON,     -- 模型特征快照
  scored_at           DATETIME,
  INDEX idx_overall (overall_score DESC)
);

-- 用户收藏夹
CREATE TABLE user_favorites (
  id                BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id           BIGINT NOT NULL,
  source_product_id BIGINT NOT NULL,
  folder_name       VARCHAR(64) DEFAULT 'default',
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_user_product (user_id, source_product_id)
);
```

### 2.3 铺货与商品

```sql
-- 铺货任务（一个货源 → 多个目标店铺）
CREATE TABLE publish_tasks (
  id                BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id           BIGINT NOT NULL,
  source_product_id BIGINT NOT NULL,
  target_shop_ids   JSON,  -- [shop_id1, shop_id2]
  status            ENUM('pending','optimizing','publishing','partial','success','failed') DEFAULT 'pending',
  ai_optimized      JSON,  -- AI 处理后的标题、详情、主图等
  pricing_strategy  JSON,
  sku_snapshot      JSON,  -- 入队时固化的平台 SKU 规格、价格和库存
  category_property_snapshot JSON,       -- 入队时固化的类目属性
  category_qualification_snapshot JSON,  -- 入队时固化的类目资质 quality_list
  error_msg         TEXT,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  finished_at       DATETIME,
  INDEX idx_user_status (user_id, status)
);

-- 已铺货商品（每个目标店铺一条）
CREATE TABLE published_products (
  id                  BIGINT PRIMARY KEY AUTO_INCREMENT,
  task_id             BIGINT NOT NULL,
  shop_id             BIGINT NOT NULL,
  source_product_id   BIGINT NOT NULL,
  platform_product_id VARCHAR(64),
  title               VARCHAR(255),
  sale_price          DECIMAL(10,2),
  cost_price          DECIMAL(10,2),
  status              ENUM('online','offline','draft','rejected') DEFAULT 'online',
  category_id         VARCHAR(64),
  main_image          VARCHAR(512),
  edit_attempts       INT DEFAULT 0,
  last_edit_attempt_at DATETIME,
  last_edited_at      DATETIME,
  last_edit_error     TEXT,
  published_at        DATETIME,
  INDEX idx_shop (shop_id),
  INDEX idx_platform_product (platform_product_id)
);
```

### 2.4 订单与代发

```sql
-- 销售订单
CREATE TABLE orders (
  id                    BIGINT PRIMARY KEY AUTO_INCREMENT,
  shop_id               BIGINT NOT NULL,
  published_product_id  BIGINT,
  platform_order_id     VARCHAR(64) NOT NULL,
  buyer_nick            VARCHAR(64),
  receiver_name         VARCHAR(64),
  receiver_phone_enc    VARCHAR(256),  -- 加密
  receiver_address_enc  TEXT,
  sku_info              JSON,
  amount                DECIMAL(10,2),
  status                ENUM('paid','purchasing','shipped','received','refunded','closed'),
  after_sale_status     ENUM('none','pending','partial_refund','refunded','failed'),
  partial_refund_fingerprint VARCHAR(64),
  refund_amount         DECIMAL(10,2),      -- 平台未返回实际退款金额时由运营核对
  refund_amount_fingerprint VARCHAR(64),    -- 绑定当前子单售后状态/类型/退款结果
  refund_amount_confirmed_at DATETIME,
  refund_amount_note    TEXT,
  paid_at               DATETIME,
  UNIQUE KEY uk_platform_order (shop_id, platform_order_id),
  INDEX idx_status (status)
);

-- 1688 代发采购单
CREATE TABLE purchase_orders (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_id        BIGINT NOT NULL,
  order_id_1688   VARCHAR(64),
  purchase_cost   DECIMAL(10,2),       -- 采购原始/远端总金额
  reconciled_cost DECIMAL(10,2),       -- 退款或关闭后最终实际承担成本
  status          ENUM('pending','placed','shipped','received','failed'),
  tracking_no     VARCHAR(64),
  carrier         VARCHAR(64),
  failure_reason  TEXT,
  retry_count     INT DEFAULT 0,
  attempt_no      INT DEFAULT 1,
  prior_incurred_cost DECIMAL(10,2) DEFAULT 0,
  retry_eligible  BOOLEAN DEFAULT FALSE,
  ever_shipped    BOOLEAN DEFAULT FALSE,
  exception_revision INT DEFAULT 0,   -- 售后/关闭事件修订号，防止旧人工核销覆盖新事件
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_order (order_id),
  INDEX idx_status (status)
);

-- 被 1688 取消/关闭后已归档的采购尝试；保留远端单号与本次实际成本
CREATE TABLE purchase_order_attempts (
  id                BIGINT PRIMARY KEY AUTO_INCREMENT,
  purchase_order_id BIGINT NOT NULL,
  attempt_no        INT NOT NULL,
  out_order_id      VARCHAR(128) NOT NULL UNIQUE,
  order_id_1688     VARCHAR(64) NOT NULL,
  actual_cost       DECIMAL(10,2) NOT NULL,
  resolution_note   TEXT NOT NULL,
  started_at        DATETIME NOT NULL,
  resolved_at       DATETIME NOT NULL,
  UNIQUE KEY uk_purchase_attempt_no (purchase_order_id, attempt_no)
);

-- 发货后异常处理记录；旧包裹在清空前连同操作人和说明完整归档
CREATE TABLE purchase_order_recoveries (
  id                 BIGINT PRIMARY KEY AUTO_INCREMENT,
  purchase_order_id  BIGINT NOT NULL,
  operator_user_id   BIGINT NOT NULL,
  exception_revision INT NOT NULL,
  order_id_1688      VARCHAR(64) NOT NULL,
  previous_shipments JSON NOT NULL,
  note               TEXT NOT NULL,
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 2.5 AI 使用与计费

```sql
-- AI 调用流水（成本核算 + 风控）
CREATE TABLE ai_usage_logs (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id         BIGINT NOT NULL,
  module          ENUM('title','detail','image_remove','image_relight','category','compliance','customer_service'),
  model           VARCHAR(64),
  input_tokens    INT DEFAULT 0,
  output_tokens   INT DEFAULT 0,
  image_count     INT DEFAULT 0,
  cost_cny        DECIMAL(10,4),
  trace_id        VARCHAR(64),
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_created (user_id, created_at),
  INDEX idx_module (module)
);

-- 订阅
CREATE TABLE subscriptions (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id     BIGINT NOT NULL,
  plan        ENUM('basic','pro','flagship') NOT NULL,
  start_date  DATE NOT NULL,
  end_date    DATE NOT NULL,
  amount_cny  DECIMAL(10,2),
  status      ENUM('active','expired','cancelled') DEFAULT 'active',
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id),
  INDEX idx_end_date (end_date)
);
```

## 3. 当前审计与告警模型（PostgreSQL / Prisma）

### 3.1 `audit_logs`

| 字段组       | 当前定义                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------- |
| 主体与动作   | `user_id` 可空并关联 `users`（删除用户时 `SetNull`）；`action`、`method`、`route`、资源标识 |
| 结果与追踪   | `outcome=success/failure`、`status_code`、`request_id`、`duration_ms`                       |
| 最小化上下文 | `ip_hash` 仅保存 HMAC、截断后的 `user_agent`、经过白名单控制的 `metadata`、`created_at`     |
| 查询索引     | 用户+时间、动作+时间、结果+时间、request ID                                                 |

审计覆盖写操作、失败鉴权和 OAuth 流程。禁止写入请求 body、Authorization、Cookie、明文 token、密钥或原始 IP。租户审计 API 只能读取当前用户的数据；运维汇总只暴露必要计数。`AuditRetentionService` 默认删除 180 天前记录，可通过 `AUDIT_RETENTION_DAYS` 调整。

### 3.2 `operational_alerts`

| 字段组     | 当前定义                                                                  |
| ---------- | ------------------------------------------------------------------------- |
| 唯一身份   | `key` 唯一；`type` 区分 dependency、queue、http、credential 等类别        |
| 状态       | `severity=warning/critical`、`status=active/resolved`                     |
| 生命周期   | `occurrences`、首次/最后发现、最后通知、恢复、创建与更新时间              |
| 内容与索引 | 脱敏 `summary/details`；按状态+严重度+最后发现时间及类型+最后发现时间查询 |

告警记录支持同 key 去重、严重度升级、重通知窗口和条件消失后的自动 resolved。通知 Webhook 使用 timestamp + HMAC-SHA256；数据库记录是状态源，外部通知失败不能导致告警状态丢失。

## 4. 向量库（Milvus）

| Collection            | 维度          | 用途                 |
| --------------------- | ------------- | -------------------- |
| `product_embeddings`  | 1024 (bge-m3) | 选品语义检索、相似款 |
| `category_embeddings` | 1024          | 类目映射             |
| `image_embeddings`    | 768 (CLIP)    | 主图相似搜索         |

**Schema 示例**：

```python
{
  "id": int64,
  "product_id": int64,
  "platform": "1688|taobao|douyin|...",
  "title_vector": float[1024],
  "image_vector": float[768],
  "category_l1": str,
  "price": float,
  "synced_at": int64
}
```

## 5. 数据流（关键事件）

| 事件                    | 来源         | 消费方                                  |
| ----------------------- | ------------ | --------------------------------------- |
| `source.product.synced` | 采集 Worker  | product 服务（写库 + 触发打分）         |
| `score.updated`         | 打分 Worker  | 看板缓存刷新                            |
| `publish.job.queued`    | publish API  | PostgreSQL `publish_jobs` + Nest worker |
| `publish.job.finished`  | Nest worker  | 铺货记录、审计、告警与看板              |
| `order.paid`            | 平台 Webhook | order 服务                              |
| `purchase.placed`       | order 服务   | 1688 代发                               |
| `ai.usage.recorded`     | ai-gateway   | 计费 + 限流                             |

## 6. 缓存策略

| Key 模式                       | 用途         | TTL                |
| ------------------------------ | ------------ | ------------------ |
| `product:{id}`                 | 货源详情     | 1h                 |
| `score:top:{cat}:{date}`       | 类目每日推荐 | 24h                |
| `shop:token:{shop_id}`         | OAuth Token  | 提前 5min 过期刷新 |
| `ratelimit:user:{id}:{module}` | AI 限流      | 滑动窗口           |
| `compliance:words`             | 敏感词库     | 24h                |

## 7. 数据合规

- **手机号、地址**：当前使用 AES-256-GCM；生产密钥必须由 Secret Manager/KMS 注入和轮换
- **OAuth Token**：当前加密落库、仅在调用时解密；生产环境须完成密钥轮换演练
- **审计日志**：写入专用 `audit_logs` 表，默认留存 180 天，不保存请求体、凭证或原始 IP
- **数据删除**：用户注销后删除/匿名化的期限和范围仍须法务确认并实现自动化，当前不得宣称已完成 GDPR/个保法注销闭环
