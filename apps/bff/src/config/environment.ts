const DEVELOPMENT_ORIGIN = 'http://localhost:3000';
const PRODUCTION = 'production';
const INSECURE_SECRETS = new Set(['change-me-in-production', 'supplier-dev-encryption-key']);

export type RuntimeEnvironment = Record<string, unknown>;

/**
 * Nest ConfigModule 启动校验。除隔离测试外，所有运行环境都只允许连接托管 Supabase。
 */
export function validateEnvironment(input: RuntimeEnvironment): RuntimeEnvironment {
  const environment = { ...input };
  const nodeEnv = optionalString(environment.NODE_ENV) ?? 'development';
  if (!['development', 'test', PRODUCTION].includes(nodeEnv)) {
    throw new Error('NODE_ENV must be development, test, or production');
  }
  environment.NODE_ENV = nodeEnv;
  const bffHost = optionalString(environment.BFF_HOST) ?? '0.0.0.0';
  if (!['127.0.0.1', '0.0.0.0'].includes(bffHost)) {
    throw new Error('BFF_HOST must be 127.0.0.1 or 0.0.0.0');
  }
  environment.BFF_HOST = bffHost;
  const gitSha = optionalString(environment.SUPPLIER_GIT_SHA);
  if (gitSha !== undefined) {
    if (!/^[a-f0-9]{40}$/.test(gitSha)) {
      throw new Error('SUPPLIER_GIT_SHA must be a 40-character lowercase Git SHA');
    }
    environment.SUPPLIER_GIT_SHA = gitSha;
  }
  environment.PORT = integer(environment.PORT, 3001, 1, 65_535, 'PORT');
  environment.HEALTH_CHECK_TIMEOUT_MS = integer(
    environment.HEALTH_CHECK_TIMEOUT_MS,
    2_000,
    100,
    10_000,
    'HEALTH_CHECK_TIMEOUT_MS',
  );
  environment.ALERT_WEBHOOK_TIMEOUT_MS = integer(
    environment.ALERT_WEBHOOK_TIMEOUT_MS,
    3_000,
    100,
    10_000,
    'ALERT_WEBHOOK_TIMEOUT_MS',
  );
  environment.ALERT_WEBHOOK_MAX_ATTEMPTS = integer(
    environment.ALERT_WEBHOOK_MAX_ATTEMPTS,
    3,
    1,
    5,
    'ALERT_WEBHOOK_MAX_ATTEMPTS',
  );
  environment.ALERT_WEBHOOK_RETRY_BASE_MS = integer(
    environment.ALERT_WEBHOOK_RETRY_BASE_MS,
    500,
    100,
    5_000,
    'ALERT_WEBHOOK_RETRY_BASE_MS',
  );
  environment.ALERT_RENOTIFY_SECONDS = integer(
    environment.ALERT_RENOTIFY_SECONDS,
    900,
    60,
    86_400,
    'ALERT_RENOTIFY_SECONDS',
  );
  environment.ALERT_MONITOR_INTERVAL_MS = integer(
    environment.ALERT_MONITOR_INTERVAL_MS,
    60_000,
    5_000,
    300_000,
    'ALERT_MONITOR_INTERVAL_MS',
  );
  environment.ALERT_QUEUE_BACKLOG_THRESHOLD = integer(
    environment.ALERT_QUEUE_BACKLOG_THRESHOLD,
    20,
    1,
    100_000,
    'ALERT_QUEUE_BACKLOG_THRESHOLD',
  );
  environment.ALERT_QUEUE_MAX_AGE_SECONDS = integer(
    environment.ALERT_QUEUE_MAX_AGE_SECONDS,
    300,
    30,
    86_400,
    'ALERT_QUEUE_MAX_AGE_SECONDS',
  );
  environment.ALERT_ERROR_RATE_PERCENT = integer(
    environment.ALERT_ERROR_RATE_PERCENT,
    5,
    1,
    100,
    'ALERT_ERROR_RATE_PERCENT',
  );
  environment.ALERT_ERROR_RATE_MIN_REQUESTS = integer(
    environment.ALERT_ERROR_RATE_MIN_REQUESTS,
    20,
    1,
    100_000,
    'ALERT_ERROR_RATE_MIN_REQUESTS',
  );
  environment.AUDIT_RETENTION_DAYS = integer(
    environment.AUDIT_RETENTION_DAYS,
    180,
    30,
    3_650,
    'AUDIT_RETENTION_DAYS',
  );
  environment.DOUYIN_ORDER_SYNC_INTERVAL_MS = integer(
    environment.DOUYIN_ORDER_SYNC_INTERVAL_MS,
    60_000,
    10_000,
    3_600_000,
    'DOUYIN_ORDER_SYNC_INTERVAL_MS',
  );
  environment.DOUYIN_ORDER_SYNC_LOOKBACK_DAYS = integer(
    environment.DOUYIN_ORDER_SYNC_LOOKBACK_DAYS,
    30,
    1,
    365,
    'DOUYIN_ORDER_SYNC_LOOKBACK_DAYS',
  );
  environment.DOUYIN_ORDER_SYNC_OVERLAP_SECONDS = integer(
    environment.DOUYIN_ORDER_SYNC_OVERLAP_SECONDS,
    300,
    0,
    3_600,
    'DOUYIN_ORDER_SYNC_OVERLAP_SECONDS',
  );
  environment.DOUYIN_ORDER_SYNC_MAX_PAGES = integer(
    environment.DOUYIN_ORDER_SYNC_MAX_PAGES,
    100,
    1,
    1_000,
    'DOUYIN_ORDER_SYNC_MAX_PAGES',
  );
  environment.ALIBABA_1688_PURCHASE_AUDIT_INTERVAL_MS = integer(
    environment.ALIBABA_1688_PURCHASE_AUDIT_INTERVAL_MS,
    300_000,
    60_000,
    3_600_000,
    'ALIBABA_1688_PURCHASE_AUDIT_INTERVAL_MS',
  );
  environment.ALIBABA_1688_PURCHASE_AUDIT_BATCH_SIZE = integer(
    environment.ALIBABA_1688_PURCHASE_AUDIT_BATCH_SIZE,
    100,
    1,
    500,
    'ALIBABA_1688_PURCHASE_AUDIT_BATCH_SIZE',
  );
  environment.EXCEPTION_CENTER_SCAN_INTERVAL_MS = integer(
    environment.EXCEPTION_CENTER_SCAN_INTERVAL_MS,
    300_000,
    60_000,
    3_600_000,
    'EXCEPTION_CENTER_SCAN_INTERVAL_MS',
  );
  environment.EXCEPTION_CENTER_SCAN_BATCH_SIZE = integer(
    environment.EXCEPTION_CENTER_SCAN_BATCH_SIZE,
    50,
    1,
    500,
    'EXCEPTION_CENTER_SCAN_BATCH_SIZE',
  );
  environment.INVENTORY_SYNC_POLL_MS = integer(
    environment.INVENTORY_SYNC_POLL_MS,
    5_000,
    500,
    60_000,
    'INVENTORY_SYNC_POLL_MS',
  );
  environment.INVENTORY_SYNC_MAX_ATTEMPTS = integer(
    environment.INVENTORY_SYNC_MAX_ATTEMPTS,
    3,
    1,
    10,
    'INVENTORY_SYNC_MAX_ATTEMPTS',
  );
  environment.PRODUCT_BATCH_POLL_MS = integer(
    environment.PRODUCT_BATCH_POLL_MS,
    2_000,
    500,
    60_000,
    'PRODUCT_BATCH_POLL_MS',
  );
  environment.PRODUCT_BATCH_MAX_ATTEMPTS = integer(
    environment.PRODUCT_BATCH_MAX_ATTEMPTS,
    3,
    1,
    10,
    'PRODUCT_BATCH_MAX_ATTEMPTS',
  );
  environment.SOURCE_IMPORT_POLL_MS = integer(
    environment.SOURCE_IMPORT_POLL_MS,
    2_000,
    500,
    60_000,
    'SOURCE_IMPORT_POLL_MS',
  );
  environment.SOURCE_IMPORT_MAX_ATTEMPTS = integer(
    environment.SOURCE_IMPORT_MAX_ATTEMPTS,
    3,
    1,
    10,
    'SOURCE_IMPORT_MAX_ATTEMPTS',
  );
  environment.MARKETPLACE_EVENT_POLL_MS = integer(
    environment.MARKETPLACE_EVENT_POLL_MS,
    2_000,
    500,
    60_000,
    'MARKETPLACE_EVENT_POLL_MS',
  );
  environment.MARKETPLACE_EVENT_BATCH_SIZE = integer(
    environment.MARKETPLACE_EVENT_BATCH_SIZE,
    20,
    1,
    100,
    'MARKETPLACE_EVENT_BATCH_SIZE',
  );
  environment.MARKETPLACE_EVENT_LEASE_MS = integer(
    environment.MARKETPLACE_EVENT_LEASE_MS,
    60_000,
    5_000,
    300_000,
    'MARKETPLACE_EVENT_LEASE_MS',
  );
  validateOptionalBoolean(environment.SWAGGER_ENABLED, 'SWAGGER_ENABLED');
  validateOptionalBoolean(
    environment.EXCEPTION_CENTER_SCAN_ENABLED,
    'EXCEPTION_CENTER_SCAN_ENABLED',
  );
  if (typeof environment.EXCEPTION_CENTER_SCAN_ENABLED === 'boolean') {
    environment.EXCEPTION_CENTER_SCAN_ENABLED = String(environment.EXCEPTION_CENTER_SCAN_ENABLED);
  }
  validateOptionalBoolean(environment.DOUYIN_ORDER_SYNC_ENABLED, 'DOUYIN_ORDER_SYNC_ENABLED');
  if (typeof environment.DOUYIN_ORDER_SYNC_ENABLED === 'boolean') {
    environment.DOUYIN_ORDER_SYNC_ENABLED = String(environment.DOUYIN_ORDER_SYNC_ENABLED);
  }
  validateOptionalBoolean(environment.INVENTORY_SYNC_ENABLED, 'INVENTORY_SYNC_ENABLED');
  if (typeof environment.INVENTORY_SYNC_ENABLED === 'boolean') {
    environment.INVENTORY_SYNC_ENABLED = String(environment.INVENTORY_SYNC_ENABLED);
  }
  validateOptionalBoolean(environment.PRODUCT_BATCH_ENABLED, 'PRODUCT_BATCH_ENABLED');
  if (typeof environment.PRODUCT_BATCH_ENABLED === 'boolean') {
    environment.PRODUCT_BATCH_ENABLED = String(environment.PRODUCT_BATCH_ENABLED);
  }
  validateOptionalBoolean(
    environment.PRODUCT_BATCH_SKU_EDIT_ENABLED,
    'PRODUCT_BATCH_SKU_EDIT_ENABLED',
  );
  if (typeof environment.PRODUCT_BATCH_SKU_EDIT_ENABLED === 'boolean') {
    environment.PRODUCT_BATCH_SKU_EDIT_ENABLED = String(environment.PRODUCT_BATCH_SKU_EDIT_ENABLED);
  }
  validateOptionalBoolean(environment.SOURCE_IMPORT_ENABLED, 'SOURCE_IMPORT_ENABLED');
  if (typeof environment.SOURCE_IMPORT_ENABLED === 'boolean') {
    environment.SOURCE_IMPORT_ENABLED = String(environment.SOURCE_IMPORT_ENABLED);
  }
  validateOptionalBoolean(
    environment.MARKETPLACE_EVENT_PROCESSING_ENABLED,
    'MARKETPLACE_EVENT_PROCESSING_ENABLED',
  );
  if (typeof environment.MARKETPLACE_EVENT_PROCESSING_ENABLED === 'boolean') {
    environment.MARKETPLACE_EVENT_PROCESSING_ENABLED = String(
      environment.MARKETPLACE_EVENT_PROCESSING_ENABLED,
    );
  }
  validateOptionalBoolean(
    environment.ALIBABA_1688_PURCHASE_ENABLED,
    'ALIBABA_1688_PURCHASE_ENABLED',
  );
  if (typeof environment.ALIBABA_1688_PURCHASE_ENABLED === 'boolean') {
    environment.ALIBABA_1688_PURCHASE_ENABLED = String(environment.ALIBABA_1688_PURCHASE_ENABLED);
  }
  validateOptionalBoolean(
    environment.ALIBABA_1688_PURCHASE_AUDIT_ENABLED,
    'ALIBABA_1688_PURCHASE_AUDIT_ENABLED',
  );
  if (typeof environment.ALIBABA_1688_PURCHASE_AUDIT_ENABLED === 'boolean') {
    environment.ALIBABA_1688_PURCHASE_AUDIT_ENABLED = String(
      environment.ALIBABA_1688_PURCHASE_AUDIT_ENABLED,
    );
  }
  if (
    environment.ALIBABA_1688_PURCHASE_AUDIT_ENABLED === 'true' &&
    environment.ALIBABA_1688_PURCHASE_ENABLED !== 'true'
  ) {
    throw new Error(
      'ALIBABA_1688_PURCHASE_AUDIT_ENABLED requires ALIBABA_1688_PURCHASE_ENABLED=true',
    );
  }
  const authMode = optionalString(environment.AUTH_MODE) ?? 'demo';
  if (!['demo', 'supabase'].includes(authMode)) {
    throw new Error('AUTH_MODE must be demo or supabase');
  }
  environment.AUTH_MODE = authMode;
  if (authMode === 'supabase') validateSupabaseAuth(environment, nodeEnv === PRODUCTION);
  if (nodeEnv === PRODUCTION && authMode !== 'supabase') {
    throw new Error('AUTH_MODE must be supabase in production');
  }

  if (nodeEnv !== 'test') validateSupabaseOnlyRuntime(environment);
  if (nodeEnv === PRODUCTION) validateProductionEnvironment(environment);
  return environment;
}

export function corsOrigins(value: unknown, production: boolean): string[] {
  const configured = optionalString(value) ?? (production ? '' : DEVELOPMENT_ORIGIN);
  const origins = configured
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (!origins.length) throw new Error('CORS_ORIGINS is required');

  for (const origin of origins) {
    if (origin === '*') throw new Error('CORS_ORIGINS must not contain wildcard origins');
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`CORS_ORIGINS contains an invalid origin: ${origin}`);
    }
    if (url.origin !== origin || url.pathname !== '/' || url.search || url.hash) {
      throw new Error(`CORS_ORIGINS must contain origins without paths: ${origin}`);
    }
    if (production && url.protocol !== 'https:') {
      throw new Error(`CORS_ORIGINS must use HTTPS in production: ${origin}`);
    }
  }
  return origins;
}

export function swaggerEnabled(nodeEnv: unknown, configured: unknown): boolean {
  if (nodeEnv === PRODUCTION) return false;
  const value = optionalString(configured);
  if (value !== undefined) return value === 'true';
  return true;
}

function validateProductionEnvironment(environment: RuntimeEnvironment): void {
  validateSecret(requiredString(environment, 'ENCRYPTION_KEY'), 'ENCRYPTION_KEY');
  validateSecret(requiredString(environment, 'OPERATIONS_TOKEN'), 'OPERATIONS_TOKEN');
  const alertWebhookUrl = requiredString(environment, 'ALERT_WEBHOOK_URL');
  validateUrl(alertWebhookUrl, 'ALERT_WEBHOOK_URL', ['https:']);
  validateSecret(requiredString(environment, 'ALERT_WEBHOOK_SECRET'), 'ALERT_WEBHOOK_SECRET');
  corsOrigins(environment.CORS_ORIGINS, true);

  validateProductionPurchase(environment);
  validateProductionSourceImport(environment);
  validateProductionDouyinAutomation(environment);
}

function validateSupabaseOnlyRuntime(environment: RuntimeEnvironment): void {
  if (optionalString(environment.REDIS_URL)) {
    throw new Error('REDIS_URL must not be configured; runtime state is stored in Supabase');
  }

  const supabaseUrl = requiredRuntimeString(environment, 'SUPABASE_URL');
  const databaseUrl = requiredRuntimeString(environment, 'DATABASE_URL');
  validateSupabaseRuntimeDatabase(databaseUrl, supabaseUrl);

  const directUrl = optionalString(environment.DIRECT_URL);
  if (directUrl) {
    validateSupabaseDirectDatabase(directUrl, supabaseUrl);
    environment.DIRECT_URL = directUrl;
  }

  const queueMode = optionalString(environment.PUBLISH_QUEUE_MODE) ?? 'database';
  if (queueMode !== 'database') {
    throw new Error('PUBLISH_QUEUE_MODE must be database outside isolated tests');
  }
  environment.PUBLISH_QUEUE_MODE = queueMode;
}

function validateProductionPurchase(environment: RuntimeEnvironment): void {
  if (environment.ALIBABA_1688_PURCHASE_ENABLED !== 'true') return;
  const paymentMode = optionalString(environment.ALIBABA_1688_PAYMENT_MODE);
  if (paymentMode !== 'manual') {
    throw new Error('ALIBABA_1688_PAYMENT_MODE must be manual');
  }
  environment.ALIBABA_1688_PAYMENT_MODE = paymentMode;
  requiredString(environment, 'ALIBABA_1688_APP_KEY');
  requiredString(environment, 'ALIBABA_1688_APP_SECRET');
  const redirectUri = requiredString(environment, 'ALIBABA_1688_OAUTH_REDIRECT_URI');
  validateUrl(redirectUri, 'ALIBABA_1688_OAUTH_REDIRECT_URI', ['https:']);
}

function validateProductionSourceImport(environment: RuntimeEnvironment): void {
  if (environment.SOURCE_IMPORT_ENABLED !== 'true') return;
  requiredString(environment, 'ALIBABA_1688_APP_KEY');
  requiredString(environment, 'ALIBABA_1688_APP_SECRET');
  const redirectUri = normalizeOAuthHttpsUrl(
    requiredString(environment, 'ALIBABA_1688_OAUTH_REDIRECT_URI'),
    'ALIBABA_1688_OAUTH_REDIRECT_URI',
  );
  environment.ALIBABA_1688_OAUTH_REDIRECT_URI = redirectUri;
  const allowlist = requiredString(environment, 'OAUTH_CALLBACK_ALLOWLIST')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => normalizeOAuthHttpsUrl(value, 'OAUTH_CALLBACK_ALLOWLIST'));
  if (!allowlist.includes(redirectUri)) {
    throw new Error('OAUTH_CALLBACK_ALLOWLIST must contain ALIBABA_1688_OAUTH_REDIRECT_URI');
  }
  if (optionalString(environment.ALIBABA_1688_SOURCE_DATA_SCOPE) !== 'global_offer') {
    throw new Error(
      'ALIBABA_1688_SOURCE_DATA_SCOPE must be global_offer when source import is enabled',
    );
  }
}

function validateProductionDouyinAutomation(environment: RuntimeEnvironment): void {
  if (
    environment.DOUYIN_ORDER_SYNC_ENABLED !== 'true' &&
    environment.INVENTORY_SYNC_ENABLED !== 'true'
  ) {
    return;
  }
  requiredString(environment, 'DOUYIN_APP_KEY');
  requiredString(environment, 'DOUYIN_APP_SECRET');
  requiredString(environment, 'DOUYIN_SERVICE_ID');
  const redirectUri = normalizeOAuthHttpsUrl(
    requiredString(environment, 'DOUYIN_OAUTH_REDIRECT_URI'),
    'DOUYIN_OAUTH_REDIRECT_URI',
  );
  environment.DOUYIN_OAUTH_REDIRECT_URI = redirectUri;
  const allowlist = requiredString(environment, 'OAUTH_CALLBACK_ALLOWLIST')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => normalizeOAuthHttpsUrl(value, 'OAUTH_CALLBACK_ALLOWLIST'));
  if (!allowlist.includes(redirectUri)) {
    throw new Error('OAUTH_CALLBACK_ALLOWLIST must contain DOUYIN_OAUTH_REDIRECT_URI');
  }
}

function validateSupabaseAuth(environment: RuntimeEnvironment, production: boolean): void {
  const supabaseUrl = optionalString(environment.SUPABASE_URL);
  if (!supabaseUrl) throw new Error('SUPABASE_URL is required when AUTH_MODE=supabase');
  environment.SUPABASE_URL = supabaseUrl;
  validateUrl(supabaseUrl, 'SUPABASE_URL', production ? ['https:'] : ['http:', 'https:']);

  const jwksUrl = optionalString(environment.SUPABASE_JWKS_URL);
  if (jwksUrl) {
    validateUrl(jwksUrl, 'SUPABASE_JWKS_URL', production ? ['https:'] : ['http:', 'https:']);
    environment.SUPABASE_JWKS_URL = jwksUrl;
  }

  const legacySecret = optionalString(environment.SUPABASE_JWT_SECRET);
  if (legacySecret && legacySecret.length < 32) {
    throw new Error('SUPABASE_JWT_SECRET must contain at least 32 characters');
  }
}

export function validateSupabaseRuntimeDatabase(databaseUrl: string, supabaseUrl: string): void {
  const projectRef = supabaseProjectRef(supabaseUrl);
  let database: URL;
  try {
    database = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid URL');
  }
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) {
    throw new Error('DATABASE_URL must use postgres: or postgresql:');
  }
  if (database.pathname !== '/postgres') {
    throw new Error('DATABASE_URL must target the Supabase postgres database');
  }
  if (!database.password) throw new Error('DATABASE_URL must contain a database password');
  const sslMode = database.searchParams.get('sslmode');
  if (sslMode !== null && sslMode !== 'require') {
    throw new Error('DATABASE_URL must not disable or weaken Supabase TLS');
  }

  const directHost = `db.${projectRef}.supabase.co`;
  if (database.hostname === directHost) {
    if ((database.port || '5432') !== '5432' || database.username !== 'postgres') {
      throw new Error('DATABASE_URL must use the matching Supabase direct connection');
    }
    return;
  }

  if (
    !database.hostname.endsWith('.pooler.supabase.com') ||
    database.username !== `postgres.${projectRef}` ||
    !['5432', '6543'].includes(database.port)
  ) {
    throw new Error('DATABASE_URL must use the matching Supabase pooler');
  }
  if (database.port === '6543' && database.searchParams.get('pgbouncer') !== 'true') {
    throw new Error('Supabase transaction pooler DATABASE_URL must set pgbouncer=true');
  }
  if (database.port === '5432' && database.searchParams.has('pgbouncer')) {
    throw new Error('Supabase session pooler DATABASE_URL must not set pgbouncer');
  }
  const connectionLimit = Number(database.searchParams.get('connection_limit'));
  if (!Number.isInteger(connectionLimit) || connectionLimit < 3 || connectionLimit > 10) {
    throw new Error('Supabase transaction pooler connection_limit must be between 3 and 10');
  }
}

export function validateSupabaseDirectDatabase(directUrl: string, supabaseUrl: string): void {
  const projectRef = supabaseProjectRef(supabaseUrl);
  let database: URL;
  try {
    database = new URL(directUrl);
  } catch {
    throw new Error('DIRECT_URL must be a valid URL');
  }
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) {
    throw new Error('DIRECT_URL must use postgres: or postgresql:');
  }
  if (database.pathname !== '/postgres') {
    throw new Error('DIRECT_URL must target the Supabase postgres database');
  }
  if (!database.password) throw new Error('DIRECT_URL must contain a database password');
  const sslMode = database.searchParams.get('sslmode');
  if (sslMode !== null && sslMode !== 'require') {
    throw new Error('DIRECT_URL must not disable or weaken Supabase TLS');
  }

  const directHost = `db.${projectRef}.supabase.co`;
  const directConnection =
    database.hostname === directHost &&
    (database.port || '5432') === '5432' &&
    database.username === 'postgres';
  const sessionPooler =
    database.hostname.endsWith('.pooler.supabase.com') &&
    database.port === '5432' &&
    database.username === `postgres.${projectRef}`;
  if (!directConnection && !sessionPooler) {
    throw new Error('DIRECT_URL must use the matching Supabase direct or session connection');
  }
}

function supabaseProjectRef(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('SUPABASE_URL must be a valid URL');
  }
  const match = url.hostname.match(/^([a-z0-9]{20})\.supabase\.co$/);
  if (
    !match ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('SUPABASE_URL must be the exact HTTPS project origin');
  }
  return match[1]!;
}

function validateUrl(value: string, name: string, protocols: string[]): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (!protocols.includes(url.protocol)) {
    throw new Error(`${name} must use ${protocols.join(' or ')}`);
  }
}

function normalizeOAuthHttpsUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`${name} must use https:`);
  if (url.username || url.password || url.hash) {
    throw new Error(`${name} must not contain credentials or fragments`);
  }
  return url.toString();
}

function validateSecret(value: string, name: string): void {
  if (value.length < 32 || INSECURE_SECRETS.has(value)) {
    throw new Error(`${name} must be a non-default secret with at least 32 characters`);
  }
}

function requiredString(environment: RuntimeEnvironment, name: string): string {
  const value = optionalString(environment[name]);
  if (!value) throw new Error(`${name} is required in production`);
  environment[name] = value;
  return value;
}

function requiredRuntimeString(environment: RuntimeEnvironment, name: string): string {
  const value = optionalString(environment[name]);
  if (!value) throw new Error(`${name} is required outside isolated tests`);
  environment[name] = value;
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function integer(
  value: unknown,
  defaultValue: number,
  min: number,
  max: number,
  name: string,
): number {
  if (value === undefined || value === '') return defaultValue;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function validateOptionalBoolean(value: unknown, name: string): void {
  if (value === undefined || value === '') return;
  if (value !== true && value !== false && value !== 'true' && value !== 'false') {
    throw new Error(`${name} must be true or false`);
  }
}
