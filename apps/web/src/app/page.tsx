export default function HomePage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <header className="mb-12">
        <p className="text-sm font-medium uppercase tracking-widest text-brand-500">
          Supplier · v0.1
        </p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight md:text-5xl">
          AI 驱动的 1688 精品铺货工具
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-zinc-600">
          今天搬什么款，AI 替你选；标题主图详情，AI 替你做。
          <br />
          为抖音小店新手与白牌商家而生。
        </p>
      </header>

      <section className="grid gap-4 md:grid-cols-3">
        <Card title="智能选品" desc="AI 多平台爆款雷达 + 五维打分" />
        <Card title="一键优化" desc="标题 / 详情 / 主图全自动" />
        <Card title="多店铺铺货" desc="抖店 / 淘宝 / 拼多多 一站式" />
      </section>

      <footer className="mt-20 text-sm text-zinc-500">
        当前阶段：Phase 0 · 规划与方案设计 ·{' '}
        <a className="underline hover:text-brand-500" href="/api/docs">
          BFF API 文档
        </a>
      </footer>
    </main>
  );
}

function Card({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm transition hover:border-brand-500 hover:shadow-md">
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="mt-2 text-sm text-zinc-600">{desc}</p>
    </div>
  );
}
