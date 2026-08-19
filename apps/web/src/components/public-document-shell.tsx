import type { ReactNode } from 'react';
import Link from 'next/link';

const PUBLIC_LINKS = [
  { href: '/privacy', label: '隐私政策' },
  { href: '/terms', label: '用户协议' },
  { href: '/help', label: '帮助与常见问题' },
  { href: '/account-deletion', label: '账号注销说明' },
] as const;

export function PublicDocumentShell({
  eyebrow,
  title,
  summary,
  updatedAt,
  children,
}: {
  eyebrow: string;
  title: string;
  summary: string;
  updatedAt: string;
  children: ReactNode;
}) {
  return (
    <div className="public-document-shell">
      <a className="public-skip-link" href="#public-document-content">
        跳到正文
      </a>

      <header className="public-document-header">
        <Link href="/" className="public-document-brand" aria-label="Supplier 工作台">
          <span aria-hidden="true">S</span>
          <strong>Supplier</strong>
        </Link>
        <nav aria-label="审核材料导航">
          <Link href="/help">帮助中心</Link>
          <Link href="/">返回工作台</Link>
        </nav>
      </header>

      <main id="public-document-content" className="public-document-main">
        <div className="public-document-hero">
          <div>
            <p className="public-document-eyebrow">{eyebrow}</p>
            <h1>{title}</h1>
            <p className="public-document-summary">{summary}</p>
          </div>
          <dl className="public-document-meta">
            <div>
              <dt>文档状态</dt>
              <dd>内部审阅草案</dd>
            </div>
            <div>
              <dt>最近更新</dt>
              <dd>{updatedAt}</dd>
            </div>
            <div>
              <dt>生效状态</dt>
              <dd>待主体与法务确认</dd>
            </div>
          </dl>
        </div>

        <div className="public-document-notice" role="note">
          <strong>当前边界</strong>
          <p>
            本页面只在显式审阅开关开启时可见，用于核对候选文案与真实产品边界；它不是已经生效的正式法律文件。主体、法务、客服和工程证据全部签字前，部署配置必须保持关闭，也不得用于提审或正式商用承诺。
          </p>
        </div>

        <article className="public-document-body">{children}</article>
      </main>

      <footer className="public-document-footer">
        <p>Supplier · 抖店 + 1688 邀请制审核测试版</p>
        <nav aria-label="法律与帮助页面">
          {PUBLIC_LINKS.map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
        </nav>
      </footer>
    </div>
  );
}

export function PublicDocumentSection({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="public-document-section">
      <header>
        <span>{number}</span>
        <h2>{title}</h2>
      </header>
      <div>{children}</div>
    </section>
  );
}

export function PublicTodo({ children }: { children: ReactNode }) {
  return (
    <p className="public-document-todo">
      <strong>提审前必须确认</strong>
      <span>{children}</span>
    </p>
  );
}
