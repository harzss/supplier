import { expect, test } from '@playwright/test';

const bffOrigin = 'http://127.0.0.1:3201';

interface Shop {
  id: string;
}

interface PublishTaskPage {
  total: number;
}

interface PublishDraft {
  clientRequestId: string;
  revision: number;
}

interface PublishPreflightResult {
  ready: boolean;
  checks: Array<{ id: string; severity: 'blocker' | 'warning'; actionHref?: string }>;
}

test('keeps publish confirmation behind the latest pricing preview and preflight', async ({
  page,
  request,
}) => {
  const e2eUserId = process.env.SUPPLIER_E2E_USER_ID;
  expect(e2eUserId).toMatch(/^\d+$/);
  const demoHeaders = { 'x-user-id': e2eUserId! };
  await page.route(`${bffOrigin}/api/**`, async (route) => {
    await route.continue({
      headers: { ...route.request().headers(), ...demoHeaders },
    });
  });

  const draftResponse = await request.get(`${bffOrigin}/api/publish-drafts/current`, {
    headers: demoHeaders,
  });
  expect(draftResponse.ok()).toBeTruthy();
  const existingDraft = (await draftResponse.json()) as PublishDraft | null;
  if (existingDraft) {
    const deleteParams = new URLSearchParams({
      expectedRevision: String(existingDraft.revision),
      expectedClientRequestId: existingDraft.clientRequestId,
    });
    const deleteDraftResponse = await request.delete(
      `${bffOrigin}/api/publish-drafts/current?${deleteParams.toString()}`,
      { headers: demoHeaders },
    );
    expect(deleteDraftResponse.ok()).toBeTruthy();
  }

  const connectResponse = await request.post(`${bffOrigin}/api/shops/connect`, {
    headers: demoHeaders,
    data: { platform: 'douyin', shopName: 'E2E 发布预检店' },
  });
  expect(connectResponse.ok()).toBeTruthy();
  const shop = (await connectResponse.json()) as Shop;

  const tasksBeforeResponse = await request.get(
    `${bffOrigin}/api/publish-tasks?page=1&pageSize=1`,
    { headers: demoHeaders },
  );
  expect(tasksBeforeResponse.ok()).toBeTruthy();
  const tasksBefore = (await tasksBeforeResponse.json()) as PublishTaskPage;

  const publishRequests: string[] = [];
  page.on('request', (browserRequest) => {
    const url = new URL(browserRequest.url());
    if (
      browserRequest.method() === 'POST' &&
      url.origin === bffOrigin &&
      url.pathname === '/api/publish-tasks'
    ) {
      publishRequests.push(browserRequest.url());
    }
  });

  await page.goto('/products?id=mock-1001#publish', { waitUntil: 'domcontentloaded' });
  await page.getByRole('checkbox', { name: /E2E 发布预检店/ }).check();

  const pricingButton = page.getByRole('button', { name: '试算售价与保本价' });
  const preflightButton = page.getByRole('button', { name: '检查发布条件' });
  await expect(preflightButton).toBeDisabled();
  await expect(
    page.getByText('请先完成售价与利润试算；任何定价策略变化都会要求重新确认。'),
  ).toBeVisible();

  await pricingButton.click();
  await expect(page.getByText('建议售价')).toBeVisible();
  await expect(page.getByText('保本价', { exact: true })).toBeVisible();
  await expect(page.getByText('预计单件利润')).toBeVisible();
  await expect(page.getByText('预计毛利率')).toBeVisible();
  await expect(preflightButton).toBeEnabled();

  const [readyResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url() === `${bffOrigin}/api/publish-tasks/preflight`,
    ),
    preflightButton.click(),
  ]);
  expect(readyResponse.ok()).toBeTruthy();
  const readyResult = (await readyResponse.json()) as PublishPreflightResult;
  expect(readyResult.ready).toBe(true);

  const preflightResult = page.getByRole('region', { name: '发布条件检查结果' });
  await expect(preflightResult).toContainText('发布条件已通过');
  await expect(preflightResult).toContainText('提交时服务端仍会再次完整校验。');
  await expect(page.getByRole('button', { name: '确认发布到 1 个店铺' })).toBeVisible();

  const tasksAfterReadyResponse = await request.get(
    `${bffOrigin}/api/publish-tasks?page=1&pageSize=1`,
    { headers: demoHeaders },
  );
  expect(tasksAfterReadyResponse.ok()).toBeTruthy();
  const tasksAfterReady = (await tasksAfterReadyResponse.json()) as PublishTaskPage;
  expect(tasksAfterReady.total).toBe(tasksBefore.total);
  const firstDraftResponse = await request.get(`${bffOrigin}/api/publish-drafts/current`, {
    headers: demoHeaders,
  });
  expect(firstDraftResponse.ok()).toBeTruthy();
  const firstDraft = (await firstDraftResponse.json()) as PublishDraft | null;
  expect(firstDraft).not.toBeNull();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(
    page.getByText('已恢复服务端草稿。为防止价格或货源变化，请重新试算并检查发布条件。'),
  ).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /E2E 发布预检店/ })).toBeChecked();
  await expect(page.getByRole('spinbutton', { name: '加价比例' })).toHaveValue('50');
  await expect(page.getByRole('button', { name: '确认发布到 1 个店铺' })).toHaveCount(0);
  await expect(preflightButton).toBeDisabled();
  await expect(
    page.getByText('请先完成售价与利润试算；任何定价策略变化都会要求重新确认。'),
  ).toBeVisible();

  await pricingButton.click();
  await expect(preflightButton).toBeEnabled();
  const [restoredReadyResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url() === `${bffOrigin}/api/publish-tasks/preflight`,
    ),
    preflightButton.click(),
  ]);
  expect(restoredReadyResponse.ok()).toBeTruthy();
  const restoredReadyResult = (await restoredReadyResponse.json()) as PublishPreflightResult;
  expect(restoredReadyResult.ready).toBe(true);
  await expect(page.getByRole('button', { name: '确认发布到 1 个店铺' })).toBeVisible();
  const noOpDraftResponse = await request.get(`${bffOrigin}/api/publish-drafts/current`, {
    headers: demoHeaders,
  });
  expect(noOpDraftResponse.ok()).toBeTruthy();
  const noOpDraft = (await noOpDraftResponse.json()) as PublishDraft;
  expect(noOpDraft.revision).toBe(firstDraft!.revision);
  expect(noOpDraft.clientRequestId).toBe(firstDraft!.clientRequestId);

  await page.getByRole('spinbutton', { name: '加价比例' }).fill('55');
  await expect(preflightResult).toHaveCount(0);
  await expect(page.getByRole('button', { name: '确认发布到 1 个店铺' })).toHaveCount(0);
  await expect(preflightButton).toBeDisabled();

  await pricingButton.click();
  await expect(preflightButton).toBeEnabled();

  const disconnectResponse = await request.post(
    `${bffOrigin}/api/shops/${encodeURIComponent(shop.id)}/disconnect`,
    { headers: demoHeaders },
  );
  expect(disconnectResponse.ok()).toBeTruthy();

  const [blockedResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url() === `${bffOrigin}/api/publish-tasks/preflight`,
    ),
    preflightButton.click(),
  ]);
  expect(blockedResponse.ok()).toBeTruthy();
  const blockedResult = (await blockedResponse.json()) as PublishPreflightResult;
  expect(blockedResult.ready).toBe(false);
  expect(blockedResult.checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'shop.target_unavailable',
        severity: 'blocker',
        actionHref: '/settings#shops',
      }),
    ]),
  );

  await expect(preflightResult).toContainText('发现 1 项发布阻断');
  await expect(preflightResult).toContainText(
    '目标店铺不可用、不是当前用户的销售店铺或尚未完成有效授权',
  );
  await expect(preflightResult.getByRole('link', { name: '去处理 →' })).toHaveAttribute(
    'href',
    '/settings#shops',
  );
  await expect(page.getByRole('button', { name: '确认发布到 1 个店铺' })).toHaveCount(0);

  const tasksAfterBlockedResponse = await request.get(
    `${bffOrigin}/api/publish-tasks?page=1&pageSize=1`,
    { headers: demoHeaders },
  );
  expect(tasksAfterBlockedResponse.ok()).toBeTruthy();
  const tasksAfterBlocked = (await tasksAfterBlockedResponse.json()) as PublishTaskPage;
  expect(tasksAfterBlocked.total).toBe(tasksBefore.total);
  expect(publishRequests).toEqual([]);

  const savedDraftResponse = await request.get(`${bffOrigin}/api/publish-drafts/current`, {
    headers: demoHeaders,
  });
  expect(savedDraftResponse.ok()).toBeTruthy();
  const savedDraft = (await savedDraftResponse.json()) as PublishDraft | null;
  expect(savedDraft).not.toBeNull();
  expect(savedDraft!.revision).toBeGreaterThan(firstDraft!.revision);
  expect(savedDraft!.clientRequestId).not.toBe(firstDraft!.clientRequestId);
  const deleteParams = new URLSearchParams({
    expectedRevision: String(savedDraft!.revision),
    expectedClientRequestId: savedDraft!.clientRequestId,
  });
  const deleteDraftResponse = await request.delete(
    `${bffOrigin}/api/publish-drafts/current?${deleteParams.toString()}`,
    { headers: demoHeaders },
  );
  expect(deleteDraftResponse.ok()).toBeTruthy();

  const recreateDraftResponse = await request.put(`${bffOrigin}/api/publish-drafts/current`, {
    headers: demoHeaders,
    data: {
      expectedRevision: 0,
      sourceProductId: 'mock-1001',
      targetShopIds: [],
      pricingStrategy: { mode: 'fixed_markup', markupRatio: 0.55 },
      aiOptions: { rewriteTitle: true },
    },
  });
  expect(recreateDraftResponse.ok()).toBeTruthy();
  const recreatedDraft = (await recreateDraftResponse.json()) as PublishDraft;
  expect(recreatedDraft.revision).toBe(firstDraft!.revision);
  expect(recreatedDraft.clientRequestId).not.toBe(firstDraft!.clientRequestId);

  const staleDeleteParams = new URLSearchParams({
    expectedRevision: String(recreatedDraft.revision),
    expectedClientRequestId: firstDraft!.clientRequestId,
  });
  const staleDeleteResponse = await request.delete(
    `${bffOrigin}/api/publish-drafts/current?${staleDeleteParams.toString()}`,
    { headers: demoHeaders },
  );
  expect(staleDeleteResponse.status()).toBe(409);
  expect(await staleDeleteResponse.json()).toMatchObject({
    code: 'PUBLISH_DRAFT_VERSION_CONFLICT',
  });

  const recreatedDeleteParams = new URLSearchParams({
    expectedRevision: String(recreatedDraft.revision),
    expectedClientRequestId: recreatedDraft.clientRequestId,
  });
  const recreatedDeleteResponse = await request.delete(
    `${bffOrigin}/api/publish-drafts/current?${recreatedDeleteParams.toString()}`,
    { headers: demoHeaders },
  );
  expect(recreatedDeleteResponse.ok()).toBeTruthy();
});
