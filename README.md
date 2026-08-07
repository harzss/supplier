# Supplier — 更简单、更安全、价格透明的 1688 分销经营工具

Supplier 连接 **1688 货源 → 选品与利润判断 → 多店铺货 → 订单采购 → 物流发货 → 售后 → 经营分析**。AI 是选品、内容、定价和风控的增强层，而不是独立产品或基础经营功能的门槛。

首发聚焦 **抖店 + 1688** 的真实闭环；验证稳定后，再按需求逐个平台扩展淘宝、拼多多、快手、小红书等。

## 当前阶段

应用侧已经具备较完整的选品、抖店发布、订单同步、1688 采购、物流回传、退款保护和经营分析基础，但真实抖店/1688 小额订单 E2E、目标云部署、服务市场订购生命周期和部分生产门禁仍未完成，**当前不能宣称生产可用或已可正式上架**。

当前推进顺序和每项状态只看 [产品路线图](docs/00-roadmap.md)；工程实现证据看 [主流程工程台账](docs/09-main-flow.md)；上线结论看 [生产准备度](docs/10-production-readiness.md)。

## 文档索引

| 文档                                                               | 职责                                 |
| ------------------------------------------------------------------ | ------------------------------------ |
| [docs/00-roadmap.md](docs/00-roadmap.md)                           | 产品方向、优先级和总体进度的唯一来源 |
| [docs/01-market-research.md](docs/01-market-research.md)           | 竞品证据、功能矩阵和市场结论         |
| [docs/02-prd-mvp.md](docs/02-prd-mvp.md)                           | 当前抖店 + 1688 验证版产品契约       |
| [docs/03-architecture.md](docs/03-architecture.md)                 | 技术架构与选型                       |
| [docs/04-data-model.md](docs/04-data-model.md)                     | 核心数据模型                         |
| [docs/05-ai-pipeline.md](docs/05-ai-pipeline.md)                   | AI 管线设计                          |
| [docs/06-openapi-integration.md](docs/06-openapi-integration.md)   | 平台 OpenAPI 接入方案                |
| [docs/07-compliance.md](docs/07-compliance.md)                     | 合规与风控                           |
| [docs/08-go-to-market.md](docs/08-go-to-market.md)                 | 商业假设、定价原则与上架验证         |
| [docs/09-main-flow.md](docs/09-main-flow.md)                       | 工程实施、测试与真实验收证据         |
| [docs/10-production-readiness.md](docs/10-production-readiness.md) | 能否上线的生产硬门禁                 |
| [docs/11-deployment-runbook.md](docs/11-deployment-runbook.md)     | 部署、迁移、回滚与恢复手册           |
| [docs/12-internal-staging.md](docs/12-internal-staging.md)         | 免费内部测试环境部署手册             |

## 工程结构

```text
supplier/
├── apps/
│   ├── web/               # Next.js 商家工作台
│   └── bff/               # NestJS API、业务服务与后台 worker
├── packages/
│   ├── db/                # Prisma schema 与 PostgreSQL migration
│   ├── platform-sdk/      # 抖店 / 1688 等平台 adapter
│   ├── crawler/           # 货源采集能力
│   ├── scoring/           # 选品评分
│   ├── entitlements/      # 套餐与权益
│   ├── llm-client/        # AI 模型调用与成本控制
│   └── shared-types/      # 前后端共享类型
├── deploy/                # Cloudflare 等部署配置
├── infra/                 # 隔离测试与恢复演练基础设施
├── scripts/               # 验证、迁移和运维脚本
└── docs/                  # 产品、工程与上线文档
```

## 本地开发

具体环境变量和部署步骤见 [内部测试环境手册](docs/12-internal-staging.md)。常用命令以根目录 `package.json` 和各 workspace 的 `package.json` 为准。

日常开发、预览、staging 与 production 都直接使用托管 Supabase，不启动本机 PostgreSQL、Redis 或其他常驻中间件。`DATABASE_URL` 使用 Supabase transaction pooler，migration 使用同项目 `DIRECT_URL`；创建开发 migration 可执行根目录 `pnpm db:migrate`（需要命名时使用 `make db-migrate name=...`）。

`pnpm db:test:up` / `make test-db-up` 只用于 CI、浏览器回归和恢复演练的可销毁隔离 PostgreSQL，数据位于 tmpfs，测试完成必须执行 `pnpm db:test:down` / `make test-db-down`；它不是开发或部署依赖，禁止被 staging/production 连接。
