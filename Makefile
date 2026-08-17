.PHONY: help install dev db-migrate db-migrate-deploy db-studio llm-test typecheck build release-check clean

help:
	@echo "Supplier — 常用命令"
	@echo ""
	@echo "  make install       安装依赖（pnpm install）"
	@echo "  make db-migrate    创建 / 应用 Prisma 迁移（首次跑：make db-migrate name=init）"
	@echo "  make db-migrate-deploy  仅应用已有迁移（生产发布）"
	@echo "  make db-studio     打开 Prisma Studio"
	@echo "  make llm-test      测试 LLM API Key 是否可用"
	@echo "  make dev           启动 Web + BFF（并行）"
	@echo "  make typecheck     全 monorepo 类型检查"
	@echo "  make build         全量构建"
	@echo "  make release-check 执行完整发布门禁"
	@echo "  make clean         清理构建产物"

install:
	pnpm install

db-migrate:
	pnpm --filter @supplier/db exec prisma migrate dev $(if $(name),--name $(name),)

db-migrate-deploy:
	pnpm db:migrate:deploy

db-studio:
	pnpm db:studio

llm-test:
	pnpm llm:test

dev:
	pnpm dev

typecheck:
	pnpm typecheck

build:
	pnpm build

release-check:
	pnpm audit:prod
	pnpm lint
	pnpm typecheck
	pnpm test
	node --test deploy/cloudflare/staging-gateway/worker.test.mjs
	pnpm build
	pnpm exec prettier --check "**/*.{ts,tsx,md,json,yml,yaml}"
	git diff --check

clean:
	pnpm clean
