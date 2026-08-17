# @supplier/db

Prisma schema + 数据访问层。**数据库：Supabase / PostgreSQL**。

## 准备

复制并填写 `.env`：

```bash
cp packages/db/.env.example packages/db/.env
# 编辑后填入 Supabase 的两个连接串：
# DATABASE_URL  → Shared pooler transaction mode (6543)，当前内测 BFF 运行时用
# DIRECT_URL    → Direct connection (5432)，迁移用
```

日常开发和内部 staging 均直连 Supabase；仓库中的 Docker PostgreSQL 仅供隔离 CI / 恢复演练，不作为运行时数据源。

## 常用命令

```bash
make db-migrate name=init   # 第一次创建迁移并应用
make db-migrate             # 后续应用未执行的迁移
make db-studio              # 打开 Prisma Studio
```

## 注意

- 敏感字段（手机号、地址、Token）以加密形式存储，由业务层透明加解密
- BigInt 主键 — 客户端 JSON 序列化需 `.toString()`
- Json 字段统一用 `@db.JsonB`（PG 性能更好）
- 货源大表 `source_products` 量级达到亿级再考虑 Citus 分区
- `scripts/seed.mjs` 仅供 GitHub Actions 的可销毁隔离数据库，不得对开发、staging 或 production Supabase 执行
