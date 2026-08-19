#!/usr/bin/env node

import { readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGE_MARKERS = {
  privacy: '处理的数据',
  terms: '账号、授权与操作责任',
  help: '目标验收流程',
  'account-deletion': '当前状态：尚不可受理',
};

const AUTH_MARKERS = ['登录邮箱', 'GoTrueClient', '正在验证会话'];
const NOINDEX = 'name="robots" content="noindex, nofollow"';
const PROTECTED_SSR_MARKER = '正在验证会话';

export function verifyLegalPageBuild({ enabled, pages }) {
  const errors = [];
  for (const [route, marker] of Object.entries(PAGE_MARKERS)) {
    const html = pages[route];
    if (typeof html !== 'string') {
      errors.push(`${route}: build artifact is missing`);
      continue;
    }

    if (!enabled) {
      if (html.includes(marker)) errors.push(`${route}: disabled build exposes draft content`);
      continue;
    }

    if (!html.includes(marker)) errors.push(`${route}: enabled build is missing review content`);
    if (!html.includes(NOINDEX)) errors.push(`${route}: enabled draft is missing noindex`);
    for (const authMarker of AUTH_MARKERS) {
      if (html.includes(authMarker)) {
        errors.push(`${route}: enabled draft contains authenticated-app marker ${authMarker}`);
      }
    }
  }

  if (errors.length > 0) throw new Error(errors.join('\n'));
  return { enabled, routes: Object.keys(PAGE_MARKERS).length };
}

export function verifyLegalPageAssets({ enabled, pages, assets, protectedIndex }) {
  const errors = [];
  if (!protectedIndex.includes(PROTECTED_SSR_MARKER)) {
    errors.push('protected index is missing the server-rendered Auth session marker');
  }

  const linkedAssets = new Set();
  for (const html of Object.values(pages)) {
    for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
      linkedAssets.add(match[1]);
    }
  }
  if (enabled) {
    for (const source of linkedAssets) {
      const asset = assets[source];
      if (typeof asset !== 'string') {
        errors.push(`linked script is missing from build output: ${source}`);
        continue;
      }
      for (const marker of AUTH_MARKERS) {
        if (asset.includes(marker)) {
          errors.push(`linked script contains authenticated-app marker ${marker}: ${source}`);
        }
      }
    }
  }

  if (errors.length > 0) throw new Error([...new Set(errors)].join('\n'));
  return { protectedSsr: true, linkedAssets: linkedAssets.size };
}

async function main() {
  const configured = process.env.NEXT_PUBLIC_LEGAL_PAGES_ENABLED?.trim();
  if (configured && !['true', 'false'].includes(configured)) {
    throw new Error('NEXT_PUBLIC_LEGAL_PAGES_ENABLED must be true or false.');
  }
  const enabled = configured === 'true';
  const outputDirectory = resolve(process.env.WEB_OUT_DIR ?? 'out');
  const pages = {};
  for (const route of Object.keys(PAGE_MARKERS)) {
    pages[route] = await readFile(resolve(outputDirectory, `${route}.html`), 'utf8');
  }
  const result = verifyLegalPageBuild({ enabled, pages });
  const sources = new Set(
    Object.values(pages).flatMap((html) =>
      [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]),
    ),
  );
  const assets = {};
  for (const source of sources) {
    assets[source] = await readFile(resolve(outputDirectory, `.${source}`), 'utf8');
  }
  const protectedIndex = await readFile(resolve(outputDirectory, 'index.html'), 'utf8');
  const assetResult = verifyLegalPageAssets({ enabled, pages, assets, protectedIndex });
  let pruned = 0;
  if (!enabled) {
    for (const route of Object.keys(PAGE_MARKERS)) {
      for (const extension of ['html', 'txt']) {
        await unlink(resolve(outputDirectory, `${route}.${extension}`));
        pruned += 1;
      }
    }
  }
  console.log(
    `Legal-page build gate passed (${result.enabled ? 'review-enabled' : 'disabled'}, ${result.routes}/${result.routes}, ${assetResult.linkedAssets} linked assets, protected SSR${pruned ? `, pruned ${pruned} disabled artifacts` : ''}).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Legal-page build gate failed.');
    process.exitCode = 1;
  });
}
