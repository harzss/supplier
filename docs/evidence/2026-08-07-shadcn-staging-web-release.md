# 2026-08-07 shadcn staging Web release

This record captures the verified deployment of the shadcn-based Supplier Web
candidate and the forward recovery of the existing internal staging BFF/Gateway
chain. It is staging evidence only and does not prove real Auth, Douyin, 1688,
or production readiness.

## Candidate

- Git commit: `dd648f13d67dfd7fe4342cd9f6e75c31f2abb123`.
- Branch: `codex/internal-test-deploy`.
- Local `HEAD` and `origin/codex/internal-test-deploy` matched before deployment.
- [GitHub Release gates #32](https://github.com/harzss/supplier/actions/runs/31139134369)
  completed with the `verify`, `browser`, and `images` jobs passing.
- No database schema or migration changed in this candidate.

## Release gates

The candidate passed the release commands required by
`docs/12-internal-staging.md`:

- production dependency audit: no known vulnerabilities;
- lint: 2/2 tasks;
- typecheck: 15/15 tasks;
- forced test run: 14/14 tasks and 1,249 tests total, including BFF 808,
  Web 99, DB 78, Platform SDK 166, Crawler 62, Entitlements 14, LLM 8, and
  Scoring 14;
- forced build: 9/9 tasks;
- Prisma schema validation;
- operations tests: 63/63;
- staging gateway tests: 7/7;
- Prettier checks and `git diff --check`;
- Cloudflare static dry-run: 84 assets and no Worker bindings.

## Cloudflare Web deployment

- Stable URL: `https://supplier-staging-web.chenjie.workers.dev`.
- Cloudflare version ID: `3c75d6ea-5444-49c2-ac50-47e2ff3990f4`.
- Wrangler uploaded 39 new or modified assets and reused 22 existing assets.
- `wrangler tail` returned Cloudflare code `100311`, `Cannot tail a Worker
which only has assets`, confirming that requests do not execute Worker code.
- The deployed root response and local `apps/web/out/index.html` both had
  SHA256 `ee6ed0a1ab856b4e2736bc3cae9688eca1a3cdd5830a1fa58306db7aa0894328`.
- `/settings`, `/orders`, and `/products?id=mock-1001` returned 200.
- `/products/mock-1001` returned 301 to `/products?id=mock-1001`.
- The removed `/prototypes/supplier-desk` route returned 404.

## Staging BFF and Gateway recovery

Before the deployment verification, the fixed Web returned 200 but the local
BFF readiness returned 503 after the 8-second database timeout and the fixed
Gateway returned 530. A fresh read-only Prisma connection using the existing
private staging configuration succeeded, so the database and credentials were
not treated as unavailable.

The installed `com.supplier.staging-local` supervisor could not take over
because an orphaned BFF process from 2026-08-06 still owned port 3001 with
`ppid=1`. The target process, command, start time, and listening socket were
resolved before intervention. SIGTERM did not stop it, so the same exact PID
was terminated with SIGKILL. Launchd then started the current BFF build, created
a new Quick Tunnel, and updated the fixed Gateway origin.

Post-recovery evidence:

- the new BFF process was owned by the current supervisor;
- local liveness returned 200;
- local readiness returned 200 in about 0.9 seconds;
- fixed Gateway liveness and readiness returned 200.

No database migration, seed, backfill, or platform automation switch was run.

## Deployment verification

The fixed Web and Gateway passed all 18 ordered checks from
`scripts/verify-deployment.mjs`:

- BFF live/ready;
- four production documentation-route 404 gates;
- three authentication rejection cases;
- public OAuth callback behavior;
- operations authentication, status, check, and Prometheus metrics;
- publish-draft PUT and DELETE CORS preflights;
- malicious-origin negative preflight;
- Web root.

The publish-draft checks used non-mutating `OPTIONS` preflights only and did not
write business state.

## Remaining boundaries

- R0-03 remains in progress.
- Real invitation email receipt, password setup, login, refresh, logout,
  recovery callback, previous-password rejection, and two-tenant isolation are
  still unverified.
- Douyin, 1688, LLM, image-service, product-batch, source-import, exception
  scanner, inventory, purchase, and purchase-audit automation switches remain
  off.
- The Quick Tunnel has no SLA and remains suitable only for internal staging.
- The current commit has Release gates evidence, but CodeQL still requires a PR,
  `main`, or a manual `security-scans.yml` run.
