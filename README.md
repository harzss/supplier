# Supplier — AI 驱动的 1688 精品铺货工具

> 不做"又一个铺货工具"，做**AI 选品 + 智能优化**的精品 SaaS。
> 切入点：抖音小店新手 + 白牌选品。

## 文档索引

| 文档                                                               | 说明                         |
| ------------------------------------------------------------------ | ---------------------------- |
| [docs/00-roadmap.md](docs/00-roadmap.md)                           | 项目路线图与 TODO            |
| [docs/01-market-research.md](docs/01-market-research.md)           | 市场调研与竞品分析           |
| [docs/02-prd-mvp.md](docs/02-prd-mvp.md)                           | MVP 产品需求文档             |
| [docs/03-architecture.md](docs/03-architecture.md)                 | 技术架构与选型               |
| [docs/04-data-model.md](docs/04-data-model.md)                     | 核心数据模型                 |
| [docs/05-ai-pipeline.md](docs/05-ai-pipeline.md)                   | AI 中台设计                  |
| [docs/06-openapi-integration.md](docs/06-openapi-integration.md)   | 平台 OpenAPI 接入方案        |
| [docs/07-compliance.md](docs/07-compliance.md)                     | 合规与风控                   |
| [docs/08-go-to-market.md](docs/08-go-to-market.md)                 | 商业化与冷启动               |
| [docs/09-main-flow.md](docs/09-main-flow.md)                       | 已实现主流程与里程碑进度     |
| [docs/10-production-readiness.md](docs/10-production-readiness.md) | 生产准备度、硬门禁与上线顺序 |
| [docs/11-deployment-runbook.md](docs/11-deployment-runbook.md)     | 部署、迁移、回滚与恢复手册   |
| [docs/12-internal-staging.md](docs/12-internal-staging.md)         | 免费内部测试环境部署手册     |

## 当前阶段

核心 Mock 闭环与真实 Supabase 数据链路已完成，当前优先补齐**系统功能闭环与真实平台应用侧能力**；镜像、云部署和切流演练留到上线阶段集中处理。已实现范围与真实验收证据以 `docs/09-main-flow.md` 为准；尚未满足的上线硬门禁以 `docs/10-production-readiness.md` 为准。

## 工程结构（规划中）

```
supplier/
├── apps/
│   ├── web/              # Next.js 工作台
│   ├── extension/        # Chrome 浏览器插件
│   └── bff/              # NestJS BFF 网关
├── services/
│   ├── product/          # 选品服务
│   ├── publish/          # 铺货服务
│   ├── order/            # 订单服务
│   ├── ai-gateway/       # AI 编排
│   └── vision/           # 视觉处理（Python/FastAPI）
├── packages/
│   ├── shared-types/     # 共享 TS 类型
│   ├── ui/               # 共享组件库
│   └── eslint-config/    # 共享配置
├── docs/                 # 项目文档
└── infra/                # K8s / Terraform
```
