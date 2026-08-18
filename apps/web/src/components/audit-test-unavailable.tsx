import Link from 'next/link';

export function AuditTestUnavailable({
  title,
  description,
  backHref,
  backLabel,
}: {
  title: string;
  description: string;
  backHref: string;
  backLabel: string;
}) {
  return (
    <main className="app-page">
      <section className="ledger-panel mx-auto max-w-2xl px-6 py-14 text-center sm:px-10">
        <span className="inline-flex rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">
          邀请制审核测试版
        </span>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-[var(--muted)]">{description}</p>
        <Link href={backHref} className="secondary-button mt-6 inline-flex">
          {backLabel}
        </Link>
      </section>
    </main>
  );
}
