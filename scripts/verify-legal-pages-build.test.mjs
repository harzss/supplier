import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyLegalPageAssets, verifyLegalPageBuild } from './verify-legal-pages-build.mjs';

const disabledPages = {
  privacy: '<html><meta name="robots" content="noindex" /><h1>404</h1></html>',
  terms: '<html><h1>404</h1></html>',
  help: '<html><h1>404</h1></html>',
  'account-deletion': '<html><h1>404</h1></html>',
};

const enabledPages = {
  privacy: '<meta name="robots" content="noindex, nofollow" /><h2>处理的数据</h2>',
  terms: '<meta name="robots" content="noindex, nofollow" /><h2>账号、授权与操作责任</h2>',
  help: '<meta name="robots" content="noindex, nofollow" /><h2>目标验收流程</h2>',
  'account-deletion':
    '<meta name="robots" content="noindex, nofollow" /><h2>当前状态：尚不可受理</h2>',
};

test('accepts a disabled build only when draft content is absent', () => {
  assert.deepEqual(verifyLegalPageBuild({ enabled: false, pages: disabledPages }), {
    enabled: false,
    routes: 4,
  });
  assert.throws(
    () =>
      verifyLegalPageBuild({
        enabled: false,
        pages: { ...disabledPages, privacy: '<h2>处理的数据</h2>' },
      }),
    /disabled build exposes draft content/,
  );
});

test('accepts an enabled review build only with content, noindex, and no auth bundle markers', () => {
  assert.deepEqual(verifyLegalPageBuild({ enabled: true, pages: enabledPages }), {
    enabled: true,
    routes: 4,
  });
  assert.throws(
    () =>
      verifyLegalPageBuild({
        enabled: true,
        pages: { ...enabledPages, help: `${enabledPages.help}登录邮箱` },
      }),
    /authenticated-app marker/,
  );
  assert.throws(
    () =>
      verifyLegalPageBuild({
        enabled: true,
        pages: { ...enabledPages, terms: '<h2>账号、授权与操作责任</h2>' },
      }),
    /missing noindex/,
  );
});

test('scans linked scripts and preserves server-rendered authentication on protected pages', () => {
  const pages = Object.fromEntries(
    Object.entries(enabledPages).map(([route, html]) => [
      route,
      `${html}<script src="/_next/static/chunks/layout.js"></script>`,
    ]),
  );
  assert.deepEqual(
    verifyLegalPageAssets({
      enabled: true,
      pages,
      assets: { '/_next/static/chunks/layout.js': 'lightweight public route shell' },
      protectedIndex: '<main>正在验证会话</main>',
    }),
    { protectedSsr: true, linkedAssets: 1 },
  );
  assert.throws(
    () =>
      verifyLegalPageAssets({
        enabled: true,
        pages,
        assets: { '/_next/static/chunks/layout.js': '登录邮箱' },
        protectedIndex: '<main>正在验证会话</main>',
      }),
    /linked script contains authenticated-app marker/,
  );
  assert.throws(
    () =>
      verifyLegalPageAssets({
        enabled: true,
        pages,
        assets: { '/_next/static/chunks/layout.js': 'lightweight public route shell' },
        protectedIndex: '<main>正在加载安全工作区</main>',
      }),
    /server-rendered Auth session marker/,
  );
});
