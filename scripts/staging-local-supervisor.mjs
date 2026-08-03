#!/usr/bin/env node

import { spawn as nodeSpawn } from 'node:child_process';
import { access as nodeAccess } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
export const repositoryRoot = resolve(dirname(scriptPath), '..');

const LOCAL_BFF_ORIGIN = 'http://127.0.0.1:3001';
const LOCAL_READY_URL = `${LOCAL_BFF_ORIGIN}/api/health/ready`;
const BFF_ENV_FILE = 'apps/bff/.env.staging.local';
const BFF_ENTRYPOINT = 'apps/bff/dist/main.js';
const GATEWAY_DIRECTORY = 'deploy/cloudflare/staging-gateway';
const WRANGLER_ENTRYPOINT = 'node_modules/wrangler/bin/wrangler.js';
const READY_ATTEMPTS = 90;
const READY_INTERVAL_MS = 1_000;
const TUNNEL_START_TIMEOUT_MS = 45_000;
const CHILD_STOP_TIMEOUT_MS = 5_000;

class SupervisorStopped extends Error {
  constructor() {
    super('staging supervisor stopped');
    this.name = 'SupervisorStopped';
  }
}

export function readSupervisorConfiguration(environment = process.env) {
  const accountId = environment.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is required');
  if (!/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account id');
  }

  const gatewayOrigin = exactHttpsOrigin(environment.STAGING_GATEWAY_URL, 'STAGING_GATEWAY_URL');
  return { accountId, gatewayOrigin };
}

export function parseTryCloudflareOrigin(value) {
  const match = String(value).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i);
  if (!match) return undefined;
  const url = new URL(match[0]);
  return url.origin;
}

export async function waitForHttpReady(
  fetcher,
  url,
  {
    attempts = READY_ATTEMPTS,
    intervalMs = READY_INTERVAL_MS,
    delay = abortableDelay,
    signal,
  } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfAborted(signal);
    try {
      const requestSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(5_000)])
        : AbortSignal.timeout(5_000);
      const response = await fetcher(url, { signal: requestSignal });
      if (response.ok) return;
    } catch (error) {
      if (signal?.aborted) throw new SupervisorStopped();
    }
    if (attempt < attempts) await delay(intervalMs, signal);
  }
  throw new Error('readiness endpoint did not become ready');
}

export function waitForTunnelOrigin(child, { signal, timeoutMs = TUNNEL_START_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffer = '';
    let settled = false;
    const streams = [child.stdout, child.stderr].filter(Boolean);

    const finish = (error, origin) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      for (const stream of streams) {
        stream.removeListener('data', onData);
        // Keep draining cloudflared output after the origin is found. Leaving a
        // piped stream paused can eventually fill its buffer and stall the
        // long-running tunnel process.
        stream.resume?.();
      }
      if (error) rejectPromise(error);
      else resolvePromise(origin);
    };
    const onData = (chunk) => {
      buffer = `${buffer}${chunk.toString()}`.slice(-32_768);
      const origin = parseTryCloudflareOrigin(buffer);
      if (origin) finish(undefined, origin);
    };
    const onAbort = () => finish(new SupervisorStopped());
    const onError = (error) => finish(new Error(`cloudflared failed to start: ${error.message}`));
    const onExit = (code, exitSignal) =>
      finish(
        new Error(
          `cloudflared exited before publishing a tunnel (${describeExit(code, exitSignal)})`,
        ),
      );
    const timer = setTimeout(
      () => finish(new Error('cloudflared did not publish a Quick Tunnel in time')),
      timeoutMs,
    );

    for (const stream of streams) stream.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function runStagingSupervisor({
  environment = process.env,
  root = repositoryRoot,
  spawn = nodeSpawn,
  fetcher = fetch,
  access = nodeAccess,
  delay = abortableDelay,
  logger = console,
  signal,
  readyAttempts = READY_ATTEMPTS,
  readyIntervalMs = READY_INTERVAL_MS,
  tunnelStartTimeoutMs = TUNNEL_START_TIMEOUT_MS,
  childStopTimeoutMs = CHILD_STOP_TIMEOUT_MS,
} = {}) {
  const { accountId, gatewayOrigin } = readSupervisorConfiguration(environment);
  await Promise.all([
    access(join(root, BFF_ENV_FILE)),
    access(join(root, BFF_ENTRYPOINT)),
    access(join(root, GATEWAY_DIRECTORY, 'wrangler.jsonc')),
    access(join(root, WRANGLER_ENTRYPOINT)),
  ]);

  const lifecycle = new AbortController();
  const termination = deferred();
  const children = new Set();
  let stopping = false;

  const stopForSignal = () => {
    termination.resolve({ kind: 'stop' });
    lifecycle.abort();
  };
  const fail = (error) => {
    if (stopping) return;
    termination.resolve({ kind: 'failure', error });
    lifecycle.abort();
  };
  const monitor = (child, name) => {
    child.once('error', (error) => fail(new Error(`${name} failed: ${error.message}`)));
    child.once('exit', (code, exitSignal) => {
      if (!stopping) {
        fail(new Error(`${name} exited (${describeExit(code, exitSignal)})`));
      }
    });
  };
  const runStep = async (operation) => {
    const outcome = await Promise.race([
      Promise.resolve(operation).then(
        (value) => ({ kind: 'value', value }),
        (error) => ({ kind: 'failure', error }),
      ),
      termination.promise,
    ]);
    if (outcome.kind === 'value') return outcome.value;
    if (outcome.kind === 'stop') throw new SupervisorStopped();
    throw outcome.error;
  };

  if (signal?.aborted) stopForSignal();
  else signal?.addEventListener('abort', stopForSignal, { once: true });

  try {
    if (signal?.aborted) throw new SupervisorStopped();
    log(logger, 'Starting production BFF.');
    const bff = spawn(process.execPath, [`--env-file=${BFF_ENV_FILE}`, BFF_ENTRYPOINT], {
      cwd: root,
      env: environment,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    children.add(bff);
    monitor(bff, 'BFF');

    await runStep(
      waitForHttpReady(fetcher, LOCAL_READY_URL, {
        attempts: readyAttempts,
        intervalMs: readyIntervalMs,
        delay,
        signal: lifecycle.signal,
      }),
    );
    log(logger, 'Local BFF is ready; starting Quick Tunnel.');

    const tunnel = spawn('cloudflared', ['tunnel', '--url', LOCAL_BFF_ORIGIN, '--no-autoupdate'], {
      cwd: root,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(tunnel);
    monitor(tunnel, 'Quick Tunnel');

    const tunnelOrigin = await runStep(
      waitForTunnelOrigin(tunnel, {
        signal: lifecycle.signal,
        timeoutMs: tunnelStartTimeoutMs,
      }),
    );
    log(logger, 'Quick Tunnel established; updating the staging gateway.');

    await runStep(
      runOneShot(
        spawn,
        process.execPath,
        [join(root, WRANGLER_ENTRYPOINT), 'secret', 'put', 'BFF_ORIGIN'],
        {
          cwd: join(root, GATEWAY_DIRECTORY),
          env: { ...environment, CLOUDFLARE_ACCOUNT_ID: accountId },
          input: `${tunnelOrigin}\n`,
          signal: lifecycle.signal,
          children,
        },
      ),
    );

    await runStep(
      waitForHttpReady(fetcher, `${gatewayOrigin}/api/health/ready`, {
        attempts: readyAttempts,
        intervalMs: readyIntervalMs,
        delay,
        signal: lifecycle.signal,
      }),
    );
    log(logger, 'Staging gateway is ready; supervisor is monitoring child processes.');

    const outcome = await termination.promise;
    if (outcome.kind === 'failure') throw outcome.error;
  } catch (error) {
    if (!(error instanceof SupervisorStopped)) throw error;
  } finally {
    stopping = true;
    lifecycle.abort();
    signal?.removeEventListener('abort', stopForSignal);
    await Promise.all(
      [...children].reverse().map((child) => terminateChild(child, childStopTimeoutMs)),
    );
  }
}

async function runOneShot(spawn, command, args, { cwd, env, input, signal, children }) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  children.add(child);

  try {
    await new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
        if (error) rejectPromise(error);
        else resolvePromise();
      };
      const onAbort = () => {
        child.kill('SIGTERM');
        finish(new SupervisorStopped());
      };
      const onError = (error) => finish(new Error(`${command} failed: ${error.message}`));
      const onExit = (code, exitSignal) => {
        if (code === 0) finish();
        else finish(new Error(`${command} exited (${describeExit(code, exitSignal)})`));
      };

      child.once('error', onError);
      child.once('exit', onExit);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else child.stdin.end(input);
    });
  } finally {
    // On abort, SIGTERM may not have stopped the one-shot process yet. Keep it
    // registered so the supervisor's final cleanup can escalate to SIGKILL.
    if (hasExited(child)) children.delete(child);
  }
}

async function terminateChild(child, timeoutMs) {
  if (hasExited(child)) return;

  await new Promise((resolvePromise) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(giveUpTimer);
      child.removeListener('exit', finish);
      resolvePromise();
    };
    const forceTimer = setTimeout(() => {
      if (!hasExited(child)) child.kill('SIGKILL');
    }, timeoutMs);
    const giveUpTimer = setTimeout(finish, timeoutMs + 1_000);
    child.once('exit', finish);
    if (!child.kill('SIGTERM')) finish();
  });
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function abortableDelay(milliseconds, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const timer = setTimeout(() => finish(), milliseconds);
    const onAbort = () => {
      finish(new SupervisorStopped());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function exactHttpsOrigin(value, name) {
  if (!value?.trim()) throw new Error(`${name} is required`);
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (url.protocol !== 'https:' || url.origin !== value.trim() || url.pathname !== '/') {
    throw new Error(`${name} must be an exact HTTPS origin`);
  }
  return url.origin;
}

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function describeExit(code, signal) {
  if (signal) return `signal ${signal}`;
  return `code ${code ?? 'unknown'}`;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new SupervisorStopped();
}

function log(logger, message) {
  const writer =
    typeof logger.info === 'function' ? logger.info.bind(logger) : logger.log.bind(logger);
  writer(`[staging-supervisor] ${message}`);
}

async function main() {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    await runStagingSupervisor({ signal: controller.signal });
  } catch (error) {
    console.error(`[staging-supervisor] ${error instanceof Error ? error.message : 'failed'}`);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  void main();
}
