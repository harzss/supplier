export function optionalGitSha(value, name = 'SUPPLIER_GIT_SHA') {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error(`${name} must be a 40-character lowercase Git SHA`);
  }
  return value;
}

export function isCurrentBffReadiness(body, expectedRevision) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (body.status !== 'ready' || body.service !== 'supplier-bff') return false;
  if (expectedRevision !== undefined && body.revision !== expectedRevision) return false;

  const checks = body.checks;
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) return false;
  const checkNames = Object.keys(checks).sort();
  if (checkNames.length !== 2 || checkNames[0] !== 'database' || checkNames[1] !== 'runtimeState') {
    return false;
  }
  return checks.database?.status === 'up' && checks.runtimeState?.status === 'up';
}

export async function isCurrentBffReadinessResponse(response, expectedRevision) {
  if (!response?.ok || typeof response.json !== 'function') return false;
  try {
    return isCurrentBffReadiness(await response.json(), expectedRevision);
  } catch {
    return false;
  }
}
