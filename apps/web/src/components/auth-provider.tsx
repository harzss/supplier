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
import Link from 'next/link';
import type { Session } from '@supabase/supabase-js';
import {
  ArrowRight,
  CheckCircle,
  CirclesFour,
  EnvelopeSimple,
  Key,
  LockKey,
  Package,
  ShieldCheck,
  Storefront,
  Truck,
  WarningCircle,
  type Icon,
} from '@phosphor-icons/react';
import {
  clearPendingPasswordSetup,
  getPasswordSetupStorage,
  readPasswordSetupReason,
  readPendingPasswordSetup,
  savePendingPasswordSetup,
  type PasswordSetupReason,
} from '../lib/auth-password-setup';
import { getSupabaseConfiguration, isLegalPagesEnabled } from '../lib/environment';
import {
  authMode,
  getSupabaseClient,
  isDemoAuthMode,
  isSignupEnabled,
  setAccessToken,
} from '../lib/supabase';
import { Button } from '@/components/ui/button';

interface AuthContextValue {
  session: Session | null;
  loading: boolean;
  configurationError?: string;
  passwordSetupReason?: PasswordSetupReason;
  completePasswordSetup: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  session: null,
  loading: true,
  completePasswordSetup: () => undefined,
});

const PASSWORD_SETUP_STORAGE_ERROR =
  '浏览器本地存储不可用，无法安全确认密码设置状态。请允许本站使用本地存储后，重新打开邀请或找回密码链接。';

const AUTH_FLOW_STEPS = [
  { icon: Storefront, title: '货源判断', description: '核对成本、库存与风险' },
  { icon: Package, title: '商品发布', description: '先预览，再人工确认' },
  { icon: CirclesFour, title: '订单采购', description: '稳定关联，避免重复下单' },
  { icon: Truck, title: '履约售后', description: '物流与异常持续回读' },
] as const satisfies ReadonlyArray<{ icon: Icon; title: string; description: string }>;

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(!isDemoAuthMode);
  const [configurationError, setConfigurationError] = useState<string>();
  const [passwordSetupReason, setPasswordSetupReason] = useState<PasswordSetupReason>();
  const previousUserId = useRef<string | null>(null);
  const closingSession = useRef(false);

  useEffect(() => {
    if (isDemoAuthMode) return;

    let active = true;
    let callbackReason = readPasswordSetupReason(window.location.href);
    let supabase: ReturnType<typeof getSupabaseClient>;
    let authProject: string;
    try {
      authProject = getSupabaseConfiguration().url;
      supabase = getSupabaseClient();
    } catch (error) {
      setConfigurationError((error as Error).message);
      setLoading(false);
      return;
    }

    const storage = getPasswordSetupStorage();
    const closeSession = (configurationError?: string) => {
      callbackReason = undefined;
      queryClient.clear();
      previousUserId.current = null;
      setAccessToken(null);
      setSession(null);
      setPasswordSetupReason(undefined);
      setLoading(false);
      if (configurationError) setConfigurationError(configurationError);
      if (!closingSession.current) {
        closingSession.current = true;
        void supabase.auth.signOut({ scope: 'local' });
      }
    };
    const applySession = (next: Session | null) => {
      if (!active || (closingSession.current && next)) return;
      const nextUserId = next?.user.id ?? null;
      if (previousUserId.current && previousUserId.current !== nextUserId) queryClient.clear();
      previousUserId.current = nextUserId;
      if (!next) {
        clearPendingPasswordSetup(storage);
        callbackReason = undefined;
        setPasswordSetupReason(undefined);
      } else if (callbackReason) {
        const persisted = savePendingPasswordSetup(
          storage,
          authProject,
          next.user.id,
          callbackReason,
        );
        if (!persisted) {
          closeSession(PASSWORD_SETUP_STORAGE_ERROR);
          return;
        }
        setPasswordSetupReason(callbackReason);
        callbackReason = undefined;
        clearAuthCallbackUrl();
      } else {
        const pendingSetup = readPendingPasswordSetup(storage, authProject, next.user.id);
        if (pendingSetup.status === 'unavailable') {
          closeSession(PASSWORD_SETUP_STORAGE_ERROR);
          return;
        }
        if (pendingSetup.status === 'expired') {
          closeSession(
            clearPendingPasswordSetup(storage) ? undefined : PASSWORD_SETUP_STORAGE_ERROR,
          );
          return;
        }
        setPasswordSetupReason(pendingSetup.status === 'pending' ? pendingSetup.reason : undefined);
      }
      setAccessToken(next?.access_token ?? null);
      setSession(next);
      setLoading(false);
    };

    void supabase.auth.getSession().then(({ data, error }) => {
      if (error) setConfigurationError(error.message);
      applySession(data.session);
    });
    const { data } = supabase.auth.onAuthStateChange((event, next) => {
      if (!closingSession.current && event === 'PASSWORD_RECOVERY' && next) {
        callbackReason = 'recovery';
      }
      applySession(next);
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [queryClient]);

  const completePasswordSetup = () => {
    if (!clearPendingPasswordSetup(getPasswordSetupStorage())) {
      closingSession.current = true;
      queryClient.clear();
      previousUserId.current = null;
      setAccessToken(null);
      setSession(null);
      setPasswordSetupReason(undefined);
      setLoading(false);
      setConfigurationError(PASSWORD_SETUP_STORAGE_ERROR);
      void getSupabaseClient().auth.signOut({ scope: 'local' });
      return;
    }
    setPasswordSetupReason(undefined);
    clearAuthCallbackUrl();
  };

  return (
    <AuthContext.Provider
      value={{
        session,
        loading,
        configurationError,
        passwordSetupReason,
        completePasswordSetup,
      }}
    >
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
  if (auth.passwordSetupReason) {
    return (
      <PasswordSetupStudio
        email={auth.session.user.email}
        reason={auth.passwordSetupReason}
        onComplete={auth.completePasswordSetup}
      />
    );
  }
  return children;
}

export function useAuthStorageIdentity(): string | null {
  const { session } = useContext(AuthContext);
  return isDemoAuthMode ? 'demo-user:1' : (session?.user.id ?? null);
}

export function AuthStatus({ compact = false }: { compact?: boolean }) {
  const { session } = useContext(AuthContext);
  if (isDemoAuthMode || !session) return null;

  const signOut = async () => {
    await getSupabaseClient().auth.signOut();
  };
  if (compact) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-11"
        onClick={() => void signOut()}
        aria-label={`退出账号 ${session.user.email ?? ''}`.trim()}
      >
        退出
      </Button>
    );
  }
  return (
    <div className="space-y-2">
      <p className="truncate text-xs text-muted-foreground">{session.user.email ?? '已登录'}</p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void signOut()}
        aria-label={`退出账号 ${session.user.email ?? ''}`.trim()}
        className="h-11 w-full lg:h-8"
      >
        退出
      </Button>
    </div>
  );
}

function LoginStudio() {
  const [mode, setMode] = useState<'signin' | 'signup' | 'forgot'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const headingRef = useRef<HTMLHeadingElement>(null);

  const selectMode = (nextMode: 'signin' | 'signup' | 'forgot') => {
    setMode(nextMode);
    setError(undefined);
    setMessage(undefined);
    requestAnimationFrame(() => headingRef.current?.focus());
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const supabase = getSupabaseClient();
      if (mode === 'forgot') {
        const result = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin,
        });
        if (result.error) {
          setError(authErrorMessage(result.error, 'forgot'));
          return;
        }
        setMessage('密码重置邮件已发送，请通过邮件中的安全链接设置新密码。');
        return;
      }
      const result =
        mode === 'signin'
          ? await supabase.auth.signInWithPassword({ email, password })
          : await supabase.auth.signUp({ email, password });
      if (result.error) {
        setError(authErrorMessage(result.error, mode));
        return;
      }
      if (mode === 'signup' && !result.data.session) {
        setMessage('注册成功，请前往邮箱完成验证后登录。');
      }
    } catch {
      setError('暂时无法连接登录服务，请稍后重试。');
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="auth-shell">
      <aside className="auth-rail" aria-label="Supplier 产品信息">
        <div className="auth-brand">
          <span className="auth-brand-mark" aria-hidden="true">
            <CirclesFour weight="fill" />
          </span>
          <span>
            <strong>Supplier</strong>
            <small>分销经营台</small>
          </span>
        </div>

        <div className="auth-rail-message">
          <p>Supplier 商家工作台</p>
          <strong>把分销经营，放进一条清晰的链路。</strong>
          <span>
            连接 1688 与销售店铺，把利润试算、发布、采购、物流和售后状态集中在一个工作台。
          </span>
        </div>

        <section className="auth-rail-preview" aria-label="Supplier 经营链路预览">
          <header>
            <span>经营链路</span>
            <small>从判断到平台回读</small>
          </header>
          <ol>
            {AUTH_FLOW_STEPS.map((step, index) => {
              const IconComponent = step.icon;
              return (
                <li key={step.title}>
                  <span className="auth-flow-index" aria-hidden="true">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span className="auth-flow-icon" aria-hidden="true">
                    <IconComponent weight="duotone" />
                  </span>
                  <span className="auth-flow-copy">
                    <strong>{step.title}</strong>
                    <small>{step.description}</small>
                  </span>
                </li>
              );
            })}
          </ol>
        </section>

        <div className="auth-rail-status">
          <ShieldCheck aria-hidden="true" weight="duotone" />
          <span>
            <strong>邀请制内部测试</strong>
            <small>身份隔离 · 高风险动作人工确认</small>
          </span>
        </div>
      </aside>

      <section className="auth-stage">
        <header className="auth-stage-header">
          <span>内部测试访问</span>
          <span className="auth-stage-environment">
            <span aria-hidden="true" />
            安全连接
          </span>
        </header>

        <div className="auth-stage-center">
          <div className="auth-panel">
            <div className="auth-panel-heading">
              <div>
                <p className="auth-panel-kicker">
                  {mode === 'forgot' ? '找回访问权限' : 'Supplier workspace'}
                </p>
                <h1 ref={headingRef} tabIndex={-1}>
                  {mode === 'signin'
                    ? '进入 Supplier'
                    : mode === 'signup'
                      ? '创建商家账号'
                      : '找回登录密码'}
                </h1>
                <p>
                  {mode === 'forgot'
                    ? '输入受邀邮箱，我们会发送安全重置链接。'
                    : '使用受邀邮箱登录内部测试工作区。'}
                </p>
              </div>
            </div>

            <form
              className="auth-form"
              aria-busy={pending}
              onSubmit={(event) => void submit(event)}
            >
              <label className="auth-field">
                <span id="auth-email-label">登录邮箱</span>
                <span className="auth-input-wrap">
                  <EnvelopeSimple aria-hidden="true" />
                  <input
                    id="auth-email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    aria-labelledby="auth-email-label"
                    aria-describedby={error || message ? 'auth-form-message' : undefined}
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </span>
              </label>
              {mode !== 'forgot' ? (
                <label className="auth-field">
                  <span id="auth-password-label">密码</span>
                  <span className="auth-input-wrap">
                    <Key aria-hidden="true" />
                    <input
                      id="auth-password"
                      name="password"
                      type="password"
                      autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                      required
                      minLength={8}
                      aria-labelledby="auth-password-label"
                      aria-describedby={error || message ? 'auth-form-message' : undefined}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </span>
                </label>
              ) : null}

              {error ? (
                <p id="auth-form-message" className="auth-message is-error" role="alert">
                  <WarningCircle aria-hidden="true" weight="fill" />
                  {error}
                </p>
              ) : null}
              {message ? (
                <p id="auth-form-message" className="auth-message is-success" role="status">
                  <CheckCircle aria-hidden="true" weight="fill" />
                  {message}
                </p>
              ) : null}

              <button type="submit" disabled={pending} className="auth-primary-action">
                <span>
                  {pending
                    ? '处理中'
                    : mode === 'signin'
                      ? '进入工作台'
                      : mode === 'signup'
                        ? '注册并验证邮箱'
                        : '发送重置邮件'}
                </span>
                <ArrowRight aria-hidden="true" weight="bold" />
              </button>
            </form>

            <div className="auth-panel-footer">
              {mode === 'signin' ? (
                <button type="button" onClick={() => selectMode('forgot')}>
                  忘记密码
                </button>
              ) : null}

              {isSignupEnabled && mode !== 'forgot' ? (
                <button
                  type="button"
                  onClick={() => selectMode(mode === 'signin' ? 'signup' : 'signin')}
                >
                  {mode === 'signin' ? '创建账号' : '返回登录'}
                </button>
              ) : !isSignupEnabled && mode !== 'forgot' ? (
                <p>
                  <ShieldCheck aria-hidden="true" weight="fill" />
                  内部测试仅限受邀账号
                </p>
              ) : null}

              {mode === 'forgot' ? (
                <button type="button" onClick={() => selectMode('signin')}>
                  返回密码登录
                </button>
              ) : null}
            </div>
          </div>
        </div>

        <footer className="auth-stage-footer">
          <span>Supplier · 邀请制内部测试</span>
          {isLegalPagesEnabled ? (
            <nav className="auth-legal-links" aria-label="帮助与法律信息">
              <Link href="/help">帮助中心</Link>
              <Link href="/privacy">隐私政策</Link>
              <Link href="/terms">用户协议</Link>
              <Link href="/account-deletion">账号注销</Link>
            </nav>
          ) : null}
        </footer>
      </section>
    </main>
  );
}

function PasswordSetupStudio({
  email,
  reason,
  onComplete,
}: {
  email?: string;
  reason: PasswordSetupReason;
  onComplete: () => void;
}) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    if (password !== confirmation) {
      setError('两次输入的密码不一致。');
      return;
    }
    setPending(true);
    const result = await getSupabaseClient().auth.updateUser({
      password,
      data: { supplier_password_initialized: true },
    });
    setPending(false);
    if (result.error) {
      setError(authErrorMessage(result.error, 'password'));
      return;
    }
    onComplete();
  };

  return (
    <main className="auth-utility-shell">
      <div className="auth-utility-brand" aria-label="Supplier 分销经营台">
        <span className="auth-brand-mark" aria-hidden="true">
          <CirclesFour weight="fill" />
        </span>
        <span>
          <strong>Supplier</strong>
          <small>安全账号设置</small>
        </span>
      </div>
      <section className="auth-panel auth-utility-panel">
        <div className="auth-panel-heading">
          <span className="auth-panel-icon" aria-hidden="true">
            <Key weight="duotone" />
          </span>
          <div>
            <p className="auth-utility-context">
              {reason === 'invite' ? '完成受邀账号' : '恢复账号访问'}
            </p>
            <h1>设置登录密码</h1>
            <p>
              {email ? `${email} 已通过安全链接验证。` : '安全链接已验证。'}
              设置密码后即可继续进入工作台。
            </p>
          </div>
        </div>
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          <label className="auth-field">
            <span>新密码</span>
            <span className="auth-input-wrap">
              <Key aria-hidden="true" />
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </span>
          </label>
          <label className="auth-field">
            <span>再次输入</span>
            <span className="auth-input-wrap">
              <Key aria-hidden="true" />
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </span>
          </label>
          {error ? (
            <p className="auth-message is-error" role="alert">
              <WarningCircle aria-hidden="true" weight="fill" />
              {error}
            </p>
          ) : null}
          <button type="submit" disabled={pending} className="auth-primary-action">
            <span>{pending ? '保存中' : '保存密码并进入工作台'}</span>
            <ArrowRight aria-hidden="true" weight="bold" />
          </button>
        </form>
      </section>
    </main>
  );
}

function clearAuthCallbackUrl(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.hash = '';
  for (const key of ['type', 'code', 'access_token', 'refresh_token', 'expires_in', 'token_type']) {
    url.searchParams.delete(key);
  }
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}`);
}

function AuthLoading() {
  return (
    <main className="auth-utility-shell">
      <div className="auth-utility-loading" role="status" aria-live="polite">
        <span className="auth-panel-icon" aria-hidden="true">
          <LockKey weight="duotone" />
        </span>
        <span>
          <strong>正在验证会话</strong>
          <small>安全确认完成后将自动进入工作台</small>
        </span>
      </div>
    </main>
  );
}

function AuthConfigurationError({ message }: { message: string }) {
  return (
    <main className="auth-utility-shell">
      <section className="auth-panel auth-utility-panel">
        <div className="auth-panel-heading">
          <span className="auth-panel-icon is-danger" aria-hidden="true">
            <WarningCircle weight="duotone" />
          </span>
          <div>
            <p className="auth-utility-context is-danger">身份服务不可用</p>
            <h1>身份服务配置不完整</h1>
            <p>{message}</p>
          </div>
        </div>
      </section>
    </main>
  );
}

function authErrorMessage(
  error: { message?: string; status?: number; code?: string },
  context: 'signin' | 'signup' | 'forgot' | 'password',
): string {
  const message = error.message?.toLowerCase() ?? '';
  const code = error.code?.toLowerCase() ?? '';

  if (message.includes('invalid login credentials') || code.includes('invalid_credentials')) {
    return '邮箱或密码不正确，请检查后重试。';
  }
  if (message.includes('email not confirmed') || code.includes('email_not_confirmed')) {
    return '邮箱尚未完成验证，请先查看验证邮件。';
  }
  if (message.includes('already registered') || code.includes('user_already_exists')) {
    return '该邮箱已注册，请直接登录或找回密码。';
  }
  if (message.includes('password') && (message.includes('least') || message.includes('short'))) {
    return '密码至少需要 8 位，请重新设置。';
  }
  if (
    error.status === 429 ||
    message.includes('rate limit') ||
    message.includes('too many requests')
  ) {
    return '操作过于频繁，请稍后再试。';
  }
  if (message.includes('fetch') || message.includes('network') || message.includes('connection')) {
    return '身份服务暂时无法连接，请检查网络后重试。';
  }

  if (context === 'signin') return '登录暂时失败，请稍后重试。';
  if (context === 'signup') return '账号创建暂时失败，请稍后重试。';
  if (context === 'forgot') return '重置邮件暂时无法发送，请稍后重试。';
  return '密码暂时无法保存，请稍后重试。';
}
