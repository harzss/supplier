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
    <main className="relative min-h-screen overflow-hidden bg-[#f4f5f8] px-5 py-8 text-[#15171c] sm:px-8">
      <div className="pointer-events-none absolute -left-40 -top-56 h-[34rem] w-[34rem] rounded-full bg-brand-200/45 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-64 -right-32 h-[38rem] w-[38rem] rounded-full bg-blue-100/70 blur-3xl" />
      <div className="relative mx-auto grid min-h-[calc(100vh-4rem)] max-w-6xl overflow-hidden rounded-3xl border border-black/5 bg-white shadow-[0_28px_90px_-40px_rgba(16,24,40,0.34)] lg:grid-cols-[1.06fr_0.94fr]">
        <section className="relative flex flex-col justify-between overflow-hidden bg-[#121419] p-7 text-white sm:p-10">
          <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-brand-500/25 blur-3xl" />
          <div>
            <p className="relative text-xs font-semibold text-brand-300">Supplier · Merchant OS</p>
            <h1 className="relative mt-8 max-w-xl text-4xl font-semibold leading-[1.04] tracking-[-0.04em] sm:text-6xl">
              从货源到订单，
              <br />
              每一步都可追溯。
            </h1>
            <p className="relative mt-7 max-w-lg text-sm leading-7 text-[#aab0bc] sm:text-base">
              可信身份会隔离你的店铺、铺货任务、订单、收藏与模型密钥。登录后才会连接真实商家工作台。
            </p>
          </div>
          <div className="relative mt-12 grid grid-cols-3 gap-2 text-[10px] font-medium text-[#aab0bc]">
            {['Tenant isolated', 'Token verified', 'Audit ready'].map((item) => (
              <span
                key={item}
                className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-3"
              >
                {item}
              </span>
            ))}
          </div>
        </section>

        <section className="flex items-center p-7 sm:p-10 lg:p-14">
          <div className="w-full">
            <div className="mb-8 flex items-end justify-between">
              <div>
                <p className="text-xs font-semibold text-brand-600">安全访问</p>
                <h2 className="mt-1 text-3xl font-semibold tracking-[-0.025em]">
                  {mode === 'signin' ? '进入工作台' : '创建商家账号'}
                </h2>
              </div>
            </div>

            <form className="space-y-5" onSubmit={(event) => void submit(event)}>
              <label className="grid gap-2 text-xs font-semibold text-zinc-700">
                登录邮箱
                <input
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="h-12 rounded-xl border border-zinc-200 bg-white px-3 text-sm outline-none transition focus:border-brand-500 focus:ring-4 focus:ring-brand-100"
                />
              </label>
              <label className="grid gap-2 text-xs font-semibold text-zinc-700">
                密码
                <input
                  type="password"
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  required
                  minLength={8}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="h-12 rounded-xl border border-zinc-200 bg-white px-3 text-sm outline-none transition focus:border-brand-500 focus:ring-4 focus:ring-brand-100"
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
                className="h-12 w-full rounded-xl bg-brand-600 text-sm font-semibold text-white shadow-[0_10px_24px_-14px_rgba(88,88,204,0.9)] transition hover:bg-brand-700 active:scale-[0.97] disabled:cursor-wait disabled:opacity-60"
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
              className="mt-5 text-sm text-zinc-500 transition hover:text-brand-700"
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
    <main className="grid min-h-screen place-items-center bg-[#f4f5f8] text-[#15171c]">
      <div className="rounded-2xl border border-zinc-200 bg-white px-8 py-6 text-sm font-medium shadow-[0_18px_50px_-32px_rgba(16,24,40,0.4)]">
        正在验证会话…
      </div>
    </main>
  );
}

function AuthConfigurationError({ message }: { message: string }) {
  return (
    <main className="grid min-h-screen place-items-center bg-[#f4f5f8] p-6 text-[#15171c]">
      <div className="max-w-lg rounded-2xl border border-red-200 bg-white p-6 shadow-[0_18px_50px_-32px_rgba(16,24,40,0.4)]">
        <p className="text-xs font-semibold text-red-700">Auth unavailable</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">身份服务配置不完整</h1>
        <p className="mt-4 text-sm leading-6 text-red-800">{message}</p>
      </div>
    </main>
  );
}
