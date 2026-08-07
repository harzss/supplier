import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  parseTryCloudflareOrigin,
  readSupervisorConfiguration,
  runStagingSupervisor,
  waitForHttpReady,
  waitForTunnelOrigin,
} from './staging-local-supervisor.mjs';
import {
  LAUNCH_AGENT_LABEL,
  buildLaunchAgentPlist,
  installLaunchAgent,
} from './install-staging-launchagent.mjs';

const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const GATEWAY_ORIGIN = 'https://supplier-staging.example.com';
const TUNNEL_ORIGIN = 'https://quiet-river.trycloudflare.com';
const GIT_SHA = 'a'.repeat(40);
const ROOT = '/virtual/supplier';
const WRANGLER_ENTRYPOINT = join(ROOT, 'node_modules/wrangler/bin/wrangler.js');

test('validates the public supervisor configuration', () => {
  assert.deepEqual(
    readSupervisorConfiguration({
      CLOUDFLARE_ACCOUNT_ID: ` ${ACCOUNT_ID} `,
      STAGING_GATEWAY_URL: ` ${GATEWAY_ORIGIN} `,
      SUPPLIER_GIT_SHA: GIT_SHA,
    }),
    { accountId: ACCOUNT_ID, gatewayOrigin: GATEWAY_ORIGIN, expectedRevision: GIT_SHA },
  );
  for (const environment of [
    {},
    {
      CLOUDFLARE_ACCOUNT_ID: 'not-an-account',
      STAGING_GATEWAY_URL: GATEWAY_ORIGIN,
    },
    {
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      STAGING_GATEWAY_URL: GATEWAY_ORIGIN,
    },
    {
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      STAGING_GATEWAY_URL: 'http://supplier-staging.example.com',
    },
    {
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      STAGING_GATEWAY_URL: `${GATEWAY_ORIGIN}/api`,
    },
    {
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      STAGING_GATEWAY_URL: `${GATEWAY_ORIGIN}?unexpected=true`,
    },
    {
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      STAGING_GATEWAY_URL: GATEWAY_ORIGIN,
      SUPPLIER_GIT_SHA: 'short',
    },
  ]) {
    assert.throws(() => readSupervisorConfiguration(environment));
  }
});

test('rejects stale Redis readiness and mismatched build revisions', async () => {
  for (const body of [
    {
      status: 'ready',
      service: 'supplier-bff',
      revision: GIT_SHA,
      checks: { database: { status: 'up' }, redis: { status: 'up' } },
    },
    {
      status: 'ready',
      service: 'supplier-bff',
      revision: 'b'.repeat(40),
      checks: { database: { status: 'up' }, runtimeState: { status: 'up' } },
    },
  ]) {
    await assert.rejects(
      waitForHttpReady(
        async () =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        'https://supplier-staging.example.com/api/health/ready',
        { attempts: 1, expectedRevision: GIT_SHA },
      ),
      /readiness endpoint did not become ready/,
    );
  }
});

test('parses a Quick Tunnel origin split across output chunks and keeps draining output', async () => {
  assert.equal(
    parseTryCloudflareOrigin(`INF Your quick Tunnel has been created! Visit ${TUNNEL_ORIGIN}/`),
    TUNNEL_ORIGIN,
  );
  assert.equal(parseTryCloudflareOrigin('https://example.com'), undefined);

  const child = new FakeChild();
  const originPromise = waitForTunnelOrigin(child, { timeoutMs: 100 });
  child.stderr.write('INF URL https://quiet-river.trycloud');
  child.stderr.write('flare.com is ready');

  assert.equal(await originPromise, TUNNEL_ORIGIN);
  assert.equal(child.stdout.readableFlowing, true);
  assert.equal(child.stderr.readableFlowing, true);
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.stderr.listenerCount('data'), 0);
});

test('starts BFF, tunnel, Wrangler, and gateway checks in order without logging the tunnel origin', async () => {
  const events = [];
  const logs = [];
  const controller = new AbortController();
  const children = createHappyChildren(events);

  await runStagingSupervisor({
    environment: supervisorEnvironment(),
    root: ROOT,
    access: async (path) => events.push(`access:${path}`),
    spawn: children.spawn,
    fetcher: async (url) => {
      events.push(`fetch:${url}`);
      return readyResponse(GIT_SHA);
    },
    logger: {
      info(message) {
        logs.push(message);
        events.push(`log:${message}`);
        if (message.includes('monitoring child processes')) {
          queueMicrotask(() => controller.abort());
        }
      },
    },
    signal: controller.signal,
    readyAttempts: 1,
    tunnelStartTimeoutMs: 100,
    childStopTimeoutMs: 20,
  });

  assertOrdered(events, [
    'spawn:bff',
    'fetch:http://127.0.0.1:3001/api/health/ready',
    'spawn:tunnel',
    'spawn:wrangler',
    `fetch:${GATEWAY_ORIGIN}/api/health/ready`,
  ]);
  assert.deepEqual(
    events.filter((event) => event.startsWith('access:')),
    [
      `access:${join(ROOT, 'apps/bff/.env.staging.local')}`,
      `access:${join(ROOT, 'apps/bff/dist/main.js')}`,
      `access:${join(ROOT, 'deploy/cloudflare/staging-gateway/wrangler.jsonc')}`,
      `access:${WRANGLER_ENTRYPOINT}`,
    ],
  );
  assert.deepEqual(children.calls[0].args, [
    '--env-file=apps/bff/.env.staging.local',
    'apps/bff/dist/main.js',
  ]);
  assert.deepEqual(children.calls[1].args, [
    'tunnel',
    '--url',
    'http://127.0.0.1:3001',
    '--no-autoupdate',
  ]);
  assert.equal(children.calls[2].command, process.execPath);
  assert.deepEqual(children.calls[2].args, [WRANGLER_ENTRYPOINT, 'secret', 'put', 'BFF_ORIGIN']);
  assert.equal(
    children.calls.some(({ command }) => command === 'npx'),
    false,
  );
  assert.equal(children.calls[2].options.cwd, join(ROOT, 'deploy/cloudflare/staging-gateway'));
  assert.equal(children.calls[2].options.env.CLOUDFLARE_ACCOUNT_ID, ACCOUNT_ID);
  assert.equal(children.wranglerInput, `${TUNNEL_ORIGIN}\n`);
  assert.equal(logs.join('\n').includes(TUNNEL_ORIGIN), false);
  assert.deepEqual(children.bff.killSignals, ['SIGTERM']);
  assert.deepEqual(children.tunnel.killSignals, ['SIGTERM']);
});

test('refuses to start when the repository-local Wrangler entrypoint is missing', async () => {
  let spawnCount = 0;

  await assert.rejects(
    runStagingSupervisor({
      environment: supervisorEnvironment(),
      root: ROOT,
      access: async (path) => {
        if (path === WRANGLER_ENTRYPOINT) throw new Error('local Wrangler is missing');
      },
      spawn() {
        spawnCount += 1;
        return new FakeChild();
      },
    }),
    /local Wrangler is missing/,
  );

  assert.equal(spawnCount, 0);
});

test('rejects when either monitored process exits and cleans up its peer', async (t) => {
  for (const failure of [
    { child: 'bff', label: 'BFF', peer: 'tunnel' },
    { child: 'tunnel', label: 'Quick Tunnel', peer: 'bff' },
  ]) {
    await t.test(failure.label, async () => {
      const events = [];
      const children = createHappyChildren(events);

      await assert.rejects(
        runStagingSupervisor({
          environment: supervisorEnvironment(),
          root: ROOT,
          access: async () => {},
          spawn: children.spawn,
          fetcher: async (url, init) => {
            if (url === 'http://127.0.0.1:3001/api/health/ready') {
              return readyResponse(GIT_SHA);
            }
            queueMicrotask(() => children[failure.child].exit(12));
            return pendingUntilAbort(init.signal);
          },
          logger: { info() {} },
          readyAttempts: 1,
          tunnelStartTimeoutMs: 100,
          childStopTimeoutMs: 20,
        }),
        new RegExp(`${failure.label} exited \\(code 12\\)`),
      );

      assert.deepEqual(children[failure.peer].killSignals, ['SIGTERM']);
      assert.deepEqual(children[failure.child].killSignals, []);
    });
  }
});

test('a pre-aborted supervisor does not start child processes', async () => {
  const controller = new AbortController();
  controller.abort();
  let spawnCount = 0;

  await runStagingSupervisor({
    environment: supervisorEnvironment(),
    root: ROOT,
    access: async () => {},
    spawn() {
      spawnCount += 1;
      return new FakeChild();
    },
    signal: controller.signal,
  });

  assert.equal(spawnCount, 0);
});

test('an aborted Wrangler process remains registered for forced cleanup', async () => {
  const controller = new AbortController();
  const bff = new FakeChild();
  const tunnel = new FakeChild();
  const wrangler = new FakeChild({ ignoreSigterm: true });

  await runStagingSupervisor({
    environment: supervisorEnvironment(),
    root: ROOT,
    access: async () => {},
    spawn(command, args) {
      if (command === process.execPath && args[0].startsWith('--env-file=')) return bff;
      if (command === 'cloudflared') {
        queueMicrotask(() => tunnel.stderr.write(`${TUNNEL_ORIGIN}\n`));
        return tunnel;
      }
      if (command === process.execPath && args[0] === WRANGLER_ENTRYPOINT) {
        queueMicrotask(() => controller.abort());
        return wrangler;
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    fetcher: async () => readyResponse(GIT_SHA),
    logger: { info() {} },
    signal: controller.signal,
    readyAttempts: 1,
    tunnelStartTimeoutMs: 100,
    childStopTimeoutMs: 1,
  });

  assert.deepEqual(wrangler.killSignals, ['SIGTERM', 'SIGTERM', 'SIGKILL']);
  assert.equal(wrangler.signalCode, 'SIGKILL');
});

test('builds an escaped LaunchAgent plist with only public runtime configuration', () => {
  const plist = buildLaunchAgentPlist({
    repoRoot: '/virtual/supplier<&',
    nodePath: '/node/with"quote',
    accountId: ACCOUNT_ID,
    gatewayOrigin: GATEWAY_ORIGIN,
    gitSha: GIT_SHA,
    homeDirectory: "/virtual/user's-home",
    executablePath: '/node/bin:/usr/bin',
  });

  assert.match(plist, new RegExp(`<string>${LAUNCH_AGENT_LABEL}</string>`));
  assert.match(plist, /\/virtual\/supplier&lt;&amp;/);
  assert.match(plist, /\/node\/with&quot;quote/);
  assert.match(plist, /\/virtual\/user&apos;s-home/);
  assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, new RegExp(GIT_SHA));
});

test('installs through injected filesystem and launchctl functions without persisting secrets', async () => {
  const accesses = [];
  const directories = [];
  const writes = [];
  const moves = [];
  const stats = [];
  const launchctlCalls = [];
  const homeDirectory = '/virtual/user';

  const plistPath = await installLaunchAgent({
    environment: {
      ...supervisorEnvironment(),
      PATH: '/custom/bin',
      DATABASE_URL: 'postgresql://database-secret',
      OPERATIONS_TOKEN: 'operations-secret',
      CLOUDFLARE_API_TOKEN: 'cloudflare-secret',
    },
    repoRoot: ROOT,
    nodePath: '/opt/node/bin/node',
    homeDirectory,
    uid: 501,
    accessFile: async (path) => accesses.push(path),
    statFile: async (path) => {
      stats.push(path);
      return { isFile: () => true, mode: 0o100600 };
    },
    makeDirectory: async (...args) => directories.push(args),
    write: async (...args) => writes.push(args),
    move: async (...args) => moves.push(args),
    launchctl: async (...args) => launchctlCalls.push(args),
  });

  const expectedPath = join(homeDirectory, 'Library/LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
  assert.equal(plistPath, expectedPath);
  assert.deepEqual(stats, [join(ROOT, 'apps/bff/.env.staging.local')]);
  assert.deepEqual(accesses, [
    join(ROOT, 'scripts/staging-local-supervisor.mjs'),
    join(ROOT, 'apps/bff/dist/main.js'),
    join(ROOT, 'deploy/cloudflare/staging-gateway/wrangler.jsonc'),
    WRANGLER_ENTRYPOINT,
  ]);
  assert.deepEqual(directories, [
    [join(homeDirectory, 'Library/LaunchAgents'), { recursive: true, mode: 0o700 }],
  ]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0].startsWith(`${expectedPath}.`), true);
  assert.deepEqual(writes[0][2], { encoding: 'utf8', mode: 0o600 });
  assert.deepEqual(moves, [[writes[0][0], expectedPath]]);

  const plist = writes[0][1];
  for (const secret of [
    'postgresql://database-secret',
    'operations-secret',
    'cloudflare-secret',
    'DATABASE_URL',
    'OPERATIONS_TOKEN',
    'CLOUDFLARE_API_TOKEN',
  ]) {
    assert.equal(plist.includes(secret), false);
  }
  assert.match(plist, new RegExp(ACCOUNT_ID));
  assert.match(plist, new RegExp(GATEWAY_ORIGIN));
  assert.match(plist, new RegExp(GIT_SHA));
  assert.match(plist, /\/opt\/node\/bin:\/custom\/bin:/);
  assert.deepEqual(launchctlCalls, [
    [['bootout', 'gui/501', expectedPath], { allowFailure: true }],
    [['bootstrap', 'gui/501', expectedPath]],
  ]);
  assert.equal(launchctlCalls.filter(([args]) => args[0] === 'bootstrap').length, 1);
  assert.equal(
    launchctlCalls.some(([args]) => args[0] === 'kickstart'),
    false,
  );
});

test('refuses to install when the BFF environment is not a private regular file', async (t) => {
  for (const scenario of [
    {
      name: 'directory',
      fileStat: { isFile: () => false, mode: 0o100600 },
      expected: /must be a regular file/,
    },
    {
      name: 'group readable',
      fileStat: { isFile: () => true, mode: 0o100640 },
      expected: /permissions must be 0600 or stricter/,
    },
    {
      name: 'owner executable',
      fileStat: { isFile: () => true, mode: 0o100700 },
      expected: /permissions must be 0600 or stricter/,
    },
  ]) {
    await t.test(scenario.name, async () => {
      let mutationCount = 0;
      await assert.rejects(
        installLaunchAgent({
          environment: supervisorEnvironment(),
          repoRoot: ROOT,
          nodePath: '/opt/node/bin/node',
          homeDirectory: '/virtual/user',
          uid: 501,
          statFile: async () => scenario.fileStat,
          accessFile: async () => {},
          makeDirectory: async () => {
            mutationCount += 1;
          },
          write: async () => {
            mutationCount += 1;
          },
          move: async () => {
            mutationCount += 1;
          },
          launchctl: async () => {
            mutationCount += 1;
          },
        }),
        scenario.expected,
      );
      assert.equal(mutationCount, 0);
    });
  }
});

function supervisorEnvironment() {
  return {
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    STAGING_GATEWAY_URL: GATEWAY_ORIGIN,
    SUPPLIER_GIT_SHA: GIT_SHA,
    PATH: '/usr/bin:/bin',
  };
}

function readyResponse(revision) {
  return new Response(
    JSON.stringify({
      status: 'ready',
      service: 'supplier-bff',
      revision,
      checks: { database: { status: 'up' }, runtimeState: { status: 'up' } },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function createHappyChildren(events) {
  const state = {
    bff: new FakeChild(),
    tunnel: new FakeChild(),
    wrangler: undefined,
    wranglerInput: '',
    calls: [],
  };
  state.spawn = (command, args, options) => {
    state.calls.push({ command, args, options });
    if (command === process.execPath && args[0].startsWith('--env-file=')) {
      events.push('spawn:bff');
      return state.bff;
    }
    if (command === 'cloudflared') {
      events.push('spawn:tunnel');
      queueMicrotask(() => state.tunnel.stderr.write(`INF ${TUNNEL_ORIGIN}\n`));
      return state.tunnel;
    }
    if (command === process.execPath && args[0] === WRANGLER_ENTRYPOINT) {
      events.push('spawn:wrangler');
      state.wrangler = new FakeChild();
      state.wrangler.stdin.on('data', (chunk) => {
        state.wranglerInput += chunk.toString();
      });
      state.wrangler.stdin.once('finish', () => {
        queueMicrotask(() => state.wrangler.exit(0));
      });
      return state.wrangler;
    }
    throw new Error(`Unexpected command: ${command}`);
  };
  return state;
}

function assertOrdered(events, expected) {
  let previousIndex = -1;
  for (const value of expected) {
    const index = events.indexOf(value);
    assert.ok(index > previousIndex, `${value} should occur after the previous event`);
    previousIndex = index;
  }
}

function pendingUntilAbort(signal) {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
  });
}

class FakeChild extends EventEmitter {
  constructor({ ignoreSigterm = false } = {}) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.killSignals = [];
    this.ignoreSigterm = ignoreSigterm;
  }

  kill(signal = 'SIGTERM') {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.killSignals.push(signal);
    if (signal === 'SIGTERM' && this.ignoreSigterm) return true;
    queueMicrotask(() => this.exit(null, signal));
    return true;
  }

  exit(code = 0, signal = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}
