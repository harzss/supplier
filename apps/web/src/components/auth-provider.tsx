'use client';

import {
  createContext,
  type FormEvent,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Session } from '@supabase/supabase-js';
import { authMode, getSupabaseClient, isDemoAuthMode, setAccessToken } from '@/lib/supabase';

interface AuthContextValue {
  session: Session | null;
  loading: boolean;
  configurationError?: string;
}

const AuthContext = createContext<AuthContextValue>({ session: null, loading: true });

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(!isDemoAuthMode);
  const [configurationError, setConfigurationError] = useState<string>();
  const previousUserId = useRef<string | null>(null);

  useEffect(() => {
    if (isDemoAuthMode) return;

    let active = true;
    let supabase: ReturnType<typeof getSupabaseClient>;
    try {
      supabase = getSupabaseClient();
    } catch (error) {
      setConfigurationError((error as Error).message);
      setLoading(false);
      return;
    }

    const applySession = (next: Session | null) => {
      if (!active) return;
      const nextUserId = next?.user.id ?? null;
      if (previousUserId.current && previousUserId.current !== nextUserId) queryClient.clear();
      previousUserId.current = nextUserId;
      setAccessToken(next?.access_token ?? null);
      setSession(next);
      setLoading(false);
    };

    void supabase.auth.getSession().then(({ data, error }) => {
      if (error) setConfigurationError(error.message);
      applySession(data.session);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => applySession(next));
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [queryClient]);

  return (
    <AuthContext.Provider value={{ session, loading, configurationError }}>
      {children}
    </AuthContext.Provider>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useContext(AuthContext);
  if (authMode === 'demo') return children;
  if (auth.loading) return <AuthLoading />;
  if (auth.configurationError) return <AuthConfigurationError message={auth.configurationError} />;
  if (!auth.session) return <LoginStudio />;
  return children;
}

export function AuthStatus({ compact = false }: { compact?: boolean }) {
  const { session } = useContext(AuthContext);
  if (isDemoAuthMode || !session) return null;

  const signOut = async () => {
    await getSupabaseClient().auth.signOut();
  };
  if (compact) {
    return (
      <button
        type="button"
        onClick={() => void signOut()}
        aria-label={`退出账号 ${session.user.email ?? ''}`.trim()}
        className="min-h-11 border border-[var(--line-strong)] bg-[var(--surface)] px-3 text-xs font-bold text-[var(--ink-soft)] transition hover:border-[var(--ink)]"
      >
        退出
      </button>
    );
  }
  return (
    <div className="grid gap-2 border-t border-[#34403b] pt-3 text-xs text-[#9eaaa4]">
      <span className="max-w-48 truncate">{session.user.email ?? '已登录'}</span>
      <button
        type="button"
        onClick={() => void signOut()}
        className="min-h-11 border border-[#56625c] px-3 py-2 font-medium text-[#dce3df] transition hover:border-white hover:text-white"
      >
        退出
      </button>
    </div>
  );
}

function LoginStudio() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    setMessage(undefined);
    const supabase = getSupabaseClient();
    const result =
      mode === 'signin'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });
    setPending(false);
    if (result.error) {
      setError(result.error.message);
      return;
    }
    if (mode === 'signup' && !result.data.session) {
      setMessage('注册成功，请前往邮箱完成验证后登录。');
    }
  };

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#e9e3d8] px-5 py-8 text-[#20211e] sm:px-8">
      <div className="pointer-events-none absolute inset-0 opacity-30 [background-image:linear-gradient(#20211e_1px,transparent_1px),linear-gradient(90deg,#20211e_1px,transparent_1px)] [background-size:44px_44px]" />
      <div className="relative mx-auto grid min-h-[calc(100vh-4rem)] max-w-6xl overflow-hidden border border-[#20211e] bg-[#f7f3eb] shadow-[8px_8px_0_#20211e] lg:grid-cols-[1.08fr_0.92fr]">
        <section className="flex flex-col justify-between border-b border-[#20211e] p-7 sm:p-10 lg:border-b-0 lg:border-r">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-brand-700">
              Supplier · Merchant OS
            </p>
            <h1 className="mt-8 max-w-xl font-serif text-5xl font-semibold leading-[0.98] sm:text-7xl">
              从货源到订单，
              <br />
              每一步都可追溯。
            </h1>
            <p className="mt-7 max-w-lg text-sm leading-7 text-[#5c5b55] sm:text-base">
              可信身份会隔离你的店铺、铺货任务、订单、收藏与模型密钥。登录后才会连接真实商家工作台。
            </p>
          </div>
          <div className="mt-12 grid grid-cols-3 border border-[#b8b2a8] font-mono text-[10px] uppercase tracking-[0.08em] text-[#686a63]">
            {['Tenant isolated', 'Token verified', 'Audit ready'].map((item) => (
              <span key={item} className="border-r border-[#b8b2a8] px-3 py-3 last:border-r-0">
                {item}
              </span>
            ))}
          </div>
        </section>

        <section className="flex items-center p-7 sm:p-10">
          <div className="w-full">
            <div className="mb-8 flex items-end justify-between border-b border-[#20211e] pb-4">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#777970]">
                  Secure access
                </p>
                <h2 className="mt-1 font-serif text-3xl font-semibold">
                  {mode === 'signin' ? '进入工作台' : '创建商家账号'}
                </h2>
              </div>
              <span className="font-mono text-xs">01 / AUTH</span>
            </div>

            <form className="space-y-5" onSubmit={(event) => void submit(event)}>
              <label className="grid gap-2 font-mono text-[11px] uppercase tracking-[0.1em]">
                登录邮箱
                <input
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="h-12 border border-[#8e8b83] bg-white px-3 font-sans text-sm normal-case tracking-normal outline-none transition focus:border-[#20211e] focus:shadow-[3px_3px_0_#20211e]"
                />
              </label>
              <label className="grid gap-2 font-mono text-[11px] uppercase tracking-[0.1em]">
                密码
                <input
                  type="password"
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  required
                  minLength={8}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="h-12 border border-[#8e8b83] bg-white px-3 font-sans text-sm normal-case tracking-normal outline-none transition focus:border-[#20211e] focus:shadow-[3px_3px_0_#20211e]"
                />
              </label>

              {error ? (
                <p className="border-l-2 border-red-600 pl-3 text-sm text-red-700">{error}</p>
              ) : null}
              {message ? (
                <p className="border-l-2 border-green-700 pl-3 text-sm text-green-800">{message}</p>
              ) : null}

              <button
                type="submit"
                disabled={pending}
                className="h-12 w-full border border-[#20211e] bg-[#20211e] font-mono text-xs uppercase tracking-[0.14em] text-white transition hover:bg-brand-700 disabled:cursor-wait disabled:opacity-60"
              >
                {pending ? '验证中…' : mode === 'signin' ? '安全登录 →' : '注册并验证邮箱 →'}
              </button>
            </form>

            <button
              type="button"
              onClick={() => {
                setMode((current) => (current === 'signin' ? 'signup' : 'signin'));
                setError(undefined);
                setMessage(undefined);
              }}
              className="mt-5 text-sm text-[#5c5b55] underline decoration-[#aaa49a] underline-offset-4 hover:text-[#20211e]"
            >
              {mode === 'signin' ? '首次使用？创建账号' : '已有账号？返回登录'}
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}

function AuthLoading() {
  return (
    <main className="grid min-h-screen place-items-center bg-[#f4f1ea] text-[#20211e]">
      <div className="border border-[#20211e] bg-[#faf8f2] px-8 py-6 font-mono text-xs uppercase tracking-[0.16em] shadow-[4px_4px_0_#20211e]">
        正在验证会话…
      </div>
    </main>
  );
}

function AuthConfigurationError({ message }: { message: string }) {
  return (
    <main className="grid min-h-screen place-items-center bg-[#f4f1ea] p-6 text-[#20211e]">
      <div className="max-w-lg border border-red-700 bg-[#fff8f2] p-6 shadow-[5px_5px_0_#991b1b]">
        <p className="font-mono text-xs uppercase tracking-[0.14em] text-red-700">
          Auth unavailable
        </p>
        <h1 className="mt-2 font-serif text-3xl font-semibold">身份服务配置不完整</h1>
        <p className="mt-4 text-sm leading-6 text-red-800">{message}</p>
      </div>
    </main>
  );
}
