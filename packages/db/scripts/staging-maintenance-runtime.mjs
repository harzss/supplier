import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const packageDir = dirname(dirname(scriptPath));
const repositoryRoot = dirname(dirname(packageDir));

export const SUPABASE_CA_CERT_PATH = join(
  repositoryRoot,
  'infra',
  'postgres',
  'certs',
  'supabase-prod-ca-2021.crt',
);

export function assertStagingMaintenanceRuntime(environment, platform) {
  if (
    platform !== 'linux' ||
    environment.SUPPLIER_STAGING_MAINTENANCE_IMAGE !== '1' ||
    !/^[a-f0-9]{40}$/.test(environment.SUPPLIER_STAGING_MAINTENANCE_GIT_SHA ?? '')
  ) {
    throw new Error(
      'Strict Prisma staging maintenance must run in the verified Linux staging-maintenance image.',
    );
  }
  return { gitSha: environment.SUPPLIER_STAGING_MAINTENANCE_GIT_SHA };
}

export function buildStrictSupabasePrismaDatasource(directUrl, datasource) {
  const username = encodeURIComponent(
    decodeUrlComponent(directUrl.username, 'DIRECT_URL username'),
  );
  const password = encodeURIComponent(
    decodeUrlComponent(directUrl.password, 'DIRECT_URL password'),
  );
  return (
    `postgresql://${username}:${password}@${datasource.direct.host}:` +
    `${datasource.direct.port}/${encodeURIComponent(datasource.database)}` +
    `?sslmode=require&sslcert=${encodeURIComponent(SUPABASE_CA_CERT_PATH)}` +
    '&sslaccept=strict'
  );
}

export function decodeUrlComponent(value, label) {
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.includes('\0')) throw new Error('NUL');
    return decoded;
  } catch {
    throw new Error(`${label} must use valid percent encoding without NUL bytes.`);
  }
}
