#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { access, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readSupervisorConfiguration, repositoryRoot } from './staging-local-supervisor.mjs';

const scriptPath = fileURLToPath(import.meta.url);
export const LAUNCH_AGENT_LABEL = 'com.supplier.staging-local';
const DEFAULT_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

export function buildLaunchAgentPlist({
  repoRoot,
  nodePath,
  accountId,
  gatewayOrigin,
  homeDirectory,
  executablePath,
}) {
  const supervisorPath = join(repoRoot, 'scripts/staging-local-supervisor.mjs');
  const values = {
    label: LAUNCH_AGENT_LABEL,
    nodePath,
    supervisorPath,
    repoRoot,
    accountId,
    gatewayOrigin,
    homeDirectory,
    executablePath,
  };
  for (const [name, value] of Object.entries(values)) {
    if (!value) throw new Error(`${name} is required to build the LaunchAgent`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(LAUNCH_AGENT_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(supervisorPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(repoRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLOUDFLARE_ACCOUNT_ID</key>
    <string>${xmlEscape(accountId)}</string>
    <key>STAGING_GATEWAY_URL</key>
    <string>${xmlEscape(gatewayOrigin)}</string>
    <key>HOME</key>
    <string>${xmlEscape(homeDirectory)}</string>
    <key>PATH</key>
    <string>${xmlEscape(executablePath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
`;
}

export async function installLaunchAgent({
  environment = process.env,
  repoRoot = repositoryRoot,
  nodePath = process.execPath,
  homeDirectory = homedir(),
  uid = process.getuid?.(),
  pathValue = environment.PATH,
  accessFile = access,
  statFile = stat,
  makeDirectory = mkdir,
  write = writeFile,
  move = rename,
  launchctl = runLaunchctl,
} = {}) {
  if (!Number.isInteger(uid) || uid < 0) throw new Error('A numeric user id is required');
  const { accountId, gatewayOrigin } = readSupervisorConfiguration(environment);
  const supervisorPath = join(repoRoot, 'scripts/staging-local-supervisor.mjs');
  const bffEnvironmentPath = join(repoRoot, 'apps/bff/.env.staging.local');
  const environmentFileStat = await statFile(bffEnvironmentPath);
  if (!environmentFileStat.isFile()) {
    throw new Error('apps/bff/.env.staging.local must be a regular file');
  }
  const environmentFilePermissions = environmentFileStat.mode & 0o777;
  if ((environmentFilePermissions & ~0o600) !== 0) {
    throw new Error('apps/bff/.env.staging.local permissions must be 0600 or stricter');
  }
  await Promise.all([
    accessFile(supervisorPath),
    accessFile(join(repoRoot, 'apps/bff/dist/main.js')),
    accessFile(join(repoRoot, 'deploy/cloudflare/staging-gateway/wrangler.jsonc')),
    accessFile(join(repoRoot, 'node_modules/wrangler/bin/wrangler.js')),
  ]);

  const executablePath = mergeExecutablePath(dirname(nodePath), pathValue);
  const launchAgentsDirectory = join(homeDirectory, 'Library/LaunchAgents');
  const plistPath = join(launchAgentsDirectory, `${LAUNCH_AGENT_LABEL}.plist`);
  const temporaryPath = `${plistPath}.${process.pid}.tmp`;
  const plist = buildLaunchAgentPlist({
    repoRoot,
    nodePath,
    accountId,
    gatewayOrigin,
    homeDirectory,
    executablePath,
  });

  await makeDirectory(launchAgentsDirectory, { recursive: true, mode: 0o700 });
  await write(temporaryPath, plist, { encoding: 'utf8', mode: 0o600 });
  await move(temporaryPath, plistPath);

  const domain = `gui/${uid}`;
  await launchctl(['bootout', domain, plistPath], { allowFailure: true });
  await launchctl(['bootstrap', domain, plistPath]);
  return plistPath;
}

function mergeExecutablePath(nodeDirectory, configuredPath) {
  const parts = [nodeDirectory, ...(configuredPath?.split(':') ?? []), ...DEFAULT_PATH.split(':')];
  return [...new Set(parts.filter(Boolean))].join(':');
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

async function runLaunchctl(args, { allowFailure = false } = {}) {
  const result = spawnSync('/bin/launchctl', args, {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.error) throw new Error(`launchctl ${args[0]} failed: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`launchctl ${args[0]} failed with status ${result.status}`);
  }
}

async function main() {
  try {
    const plistPath = await installLaunchAgent();
    console.log(`Installed ${LAUNCH_AGENT_LABEL} at ${plistPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'LaunchAgent installation failed');
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  void main();
}
