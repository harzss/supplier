import { expect, test, type Page, type Route } from '@playwright/test';

const bffOrigin = 'http://127.0.0.1:3201';
const productId = '11';
const taskId = '501';
const itemId = '701';
const beforeFingerprint = 'a'.repeat(64);
const ruleFingerprint = 'b'.repeat(64);
const desiredFingerprint = 'c'.repeat(64);

type TaskState = 'preview' | 'unknown' | 'succeeded';

test('edits a complete SKU set and fences an unknown write behind verification', async ({
  page,
}) => {
  let taskState: TaskState = 'preview';
  let previewRequest: Record<string, unknown> | null = null;
  const unexpectedRequests: string[] = [];

  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(`${bffOrigin}/api/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (method === 'GET' && url.pathname === '/api/me/activation') {
      await json(route, {
        totalSteps: 4,
        completedSteps: 4,
        currentStep: null,
        nextHref: '/',
        steps: [],
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/product-batches/candidates') {
      const offline = url.searchParams.get('status') === 'offline';
      await json(route, {
        items: offline ? [skuCandidate()] : [],
        total: offline ? 1 : 0,
        page: 1,
        pageSize: 50,
      });
      return;
    }
    if (
      method === 'GET' &&
      url.pathname === `/api/product-batches/products/${productId}/sku-edit-context`
    ) {
      await json(route, skuEditContext());
      return;
    }
    if (method === 'GET' && url.pathname === '/api/product-batches') {
      await json(route, { items: [], total: 0, page: 1, pageSize: 5 });
      return;
    }
    if (method === 'POST' && url.pathname === '/api/product-batches/previews') {
      previewRequest = request.postDataJSON() as Record<string, unknown>;
      taskState = 'preview';
      await json(route, productBatchTask(taskState, String(previewRequest.clientRequestId)));
      return;
    }
    if (method === 'GET' && url.pathname === `/api/product-batches/${taskId}`) {
      await json(route, productBatchTask(taskState, requestClientId(previewRequest)));
      return;
    }
    if (method === 'POST' && url.pathname === `/api/product-batches/${taskId}/execute`) {
      taskState = 'unknown';
      await json(route, productBatchTask(taskState, requestClientId(previewRequest)));
      return;
    }
    if (
      method === 'POST' &&
      url.pathname === `/api/product-batches/${taskId}/items/${itemId}/verify-skus`
    ) {
      taskState = 'succeeded';
      await json(route, productBatchTask(taskState, requestClientId(previewRequest)));
      return;
    }

    unexpectedRequests.push(`${method} ${url.pathname}`);
    await route.fulfill({ status: 501, body: 'Unexpected mocked E2E request' });
  });

  await page.goto('/published/batch', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /批量改 SKU/ }).click();
  await page.getByRole('checkbox', { name: '选择 M87 SKU 回归商品' }).check();
  await page.getByRole('button', { name: '配置 SKU' }).click();

  const sheet = page.getByRole('dialog', { name: '编辑 SKU 结构' });
  await expect(sheet).toBeVisible();
  expect(await sheet.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await expectNoPageOverflow(page);
  await expectTouchTarget(page.getByRole('button', { name: '新增 SKU' }));
  await expectTouchTarget(page.getByLabel('SKU 1 的 1688 规格'));

  await page.getByLabel('SKU 1 的 1688 规格').selectOption({ label: '蓝色货源' });
  await page.getByLabel('SKU 1 的颜色').selectOption({ label: '红色' });
  await page.getByRole('button', { name: '新增 SKU' }).click();
  await page.getByLabel('SKU 3 的颜色').selectOption({ label: '白色' });
  await page.getByRole('spinbutton', { name: '新增 SKU 3 售价' }).fill('25.90');
  await expectTouchTarget(page.getByRole('spinbutton', { name: '新增 SKU 3 售价' }));

  const saveButton = page.getByRole('button', { name: '保存到批量预览' });
  await expectTouchTarget(saveButton);
  await saveButton.click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('button', { name: '重新编辑' })).toBeFocused();

  await page.getByRole('button', { name: '预览批量改 SKU 1 件商品' }).click();
  await expect(page).toHaveURL(new RegExp(`[?&]task=${taskId}(?:&|$)`));
  expect(previewRequest).not.toBeNull();
  expect(previewRequest).toMatchObject({
    action: 'edit_sku',
    publishedProductIds: [productId],
    skuTargets: [
      {
        publishedProductId: productId,
        expectedMutationRevision: 3,
        expectedPlatformSkuFingerprint: beforeFingerprint,
        expectedRuleFingerprint: ruleFingerprint,
        rows: expect.arrayContaining([
          expect.objectContaining({
            rowId: 'existing:sku-white',
            isNew: false,
            platformSkuId: 'sku-white',
            platformSkuKey: 'stable-white',
            sourceSpecId: 'spec-blue',
            priceCents: 1990,
            properties: [expect.objectContaining({ valueId: '103', valueName: '红色' })],
          }),
          expect.objectContaining({
            rowId: 'new:spec-white',
            isNew: true,
            platformSkuId: null,
            platformSkuKey: null,
            sourceSpecId: 'spec-white',
            priceCents: 2590,
          }),
        ]),
      },
    ],
  });

  await page.getByRole('button', { name: '确认批量改 SKU 1 件商品' }).click();
  await expect(page.getByText('1 个 SKU 写入结果未知')).toBeVisible();
  await expect(page.getByRole('button', { name: /重试/ })).toHaveCount(0);
  const verifyButton = page.getByRole('button', { name: '核验平台 SKU' });
  await expect(verifyButton).toBeVisible();
  await verifyButton.click();

  await expect(page.getByRole('button', { name: '核验平台 SKU' })).toHaveCount(0);
  await expect(page.locator('.batch-task-status[data-status="succeeded"]')).toHaveText('全部完成');
  await expect(page.getByText('SKU 写入结果未知')).toHaveCount(0);
  expect(unexpectedRequests).toEqual([]);
});

async function json(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    headers: {
      'access-control-allow-origin': 'http://127.0.0.1:3200',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <= window.innerWidth &&
          document.body.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
}

async function expectTouchTarget(locator: ReturnType<Page['getByRole']>): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, 'expected a visible touch target').not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

function requestClientId(value: Record<string, unknown> | null): string {
  const clientRequestId = value?.clientRequestId;
  expect(clientRequestId).toEqual(expect.any(String));
  return String(clientRequestId);
}

function skuCandidate() {
  return {
    publishedProductId: productId,
    title: 'M87 SKU 回归商品',
    mainImage: null,
    shopId: '3',
    shopName: '演示店铺',
    platform: 'douyin',
    platformProductId: 'platform-11',
    status: 'offline',
    salePrice: 19.9,
    priceRange: [19.9, 20.9],
    skuCount: 2,
    titleEditable: true,
    titleEditReason: null,
    titleVerificationTaskId: null,
    titleVerificationItemId: null,
    onlineEligible: true,
    onlineReason: null,
    onlineVerificationTaskId: null,
    onlineVerificationItemId: null,
    offlineVerificationTaskId: null,
    offlineVerificationItemId: null,
    priceEditable: true,
    priceEditReason: null,
    sourceProductId: '16880011',
    sourceAvailability: 'available',
    sourceTotalStock: 21,
    sourceSkuCount: 3,
    sourceInventoryVersion: 4,
    inventorySyncStatus: 'synced',
    syncedInventoryVersion: 4,
    inventoryLastSyncedAt: '2026-08-07T00:00:00.000Z',
    inventorySyncError: null,
    inventorySyncEligible: true,
    inventorySyncReason: null,
    cleanupEligible: false,
    cleanupReason: '只有在线商品可以进入滞销安全下架',
    cleanupEvidence: null,
    sourceChangeEligible: true,
    sourceChangeReason: null,
    currentSourceRouteCount: 2,
    skuEditEligible: true,
    skuEditReason: null,
    skuVerificationTaskId: null,
    skuVerificationItemId: null,
    mutationRevision: 3,
    publishedAt: '2026-08-07T00:00:00.000Z',
  };
}

function skuEditContext() {
  return {
    publishedProductId: productId,
    expectedMutationRevision: 3,
    expectedPlatformSkuFingerprint: beforeFingerprint,
    expectedRuleFingerprint: ruleFingerprint,
    editable: true,
    blockers: [],
    dimensions: [
      {
        propertyId: '100',
        propertyName: '颜色',
        values: [
          { valueId: '101', valueName: '白色' },
          { valueId: '102', valueName: '黑色' },
        ],
      },
    ],
    rows: [
      {
        rowId: 'existing:sku-white',
        platformSkuId: 'sku-white',
        platformSkuKey: 'stable-white',
        sourceSpecId: 'spec-white',
        properties: [
          {
            propertyId: '100',
            propertyName: '颜色',
            valueId: '101',
            valueName: '白色',
            remark: null,
          },
        ],
        priceCents: 1990,
        stock: 9,
        isNew: false,
        skuPictureUrls: [],
      },
      {
        rowId: 'existing:sku-black',
        platformSkuId: 'sku-black',
        platformSkuKey: 'stable-black',
        sourceSpecId: 'spec-black',
        properties: [
          {
            propertyId: '100',
            propertyName: '颜色',
            valueId: '102',
            valueName: '黑色',
            remark: null,
          },
        ],
        priceCents: 2090,
        stock: 7,
        isNew: false,
        skuPictureUrls: [],
      },
    ],
    sourceSkus: [
      {
        sourceSpecId: 'spec-white',
        sourceSpecName: '白色货源',
        costPrice: 8,
        stock: 9,
        usedByPlatformSkuKey: 'stable-white',
      },
      {
        sourceSpecId: 'spec-black',
        sourceSpecName: '黑色货源',
        costPrice: 8.5,
        stock: 7,
        usedByPlatformSkuKey: 'stable-black',
      },
      {
        sourceSpecId: 'spec-blue',
        sourceSpecName: '蓝色货源',
        costPrice: 9,
        stock: 5,
        usedByPlatformSkuKey: null,
      },
    ],
    rules: {
      maxDimensions: 3,
      maxCombinations: 100,
      maxValuesPerDimension: 20,
      supportsDimensionReordering: true,
      supportsCustomDimensions: false,
      allSkuPicturesRequired: false,
      dimensions: [
        {
          propertyId: '100',
          propertyName: '颜色',
          required: true,
          supportsCustomValues: true,
          supportsRemark: true,
          requiresPagedValues: false,
          values: [
            { valueId: '101', valueName: '白色' },
            { valueId: '102', valueName: '黑色' },
            { valueId: '103', valueName: '红色' },
          ],
          unsupportedReasons: [],
        },
      ],
      unsupportedReasons: [],
    },
  };
}

function productBatchTask(state: TaskState, clientRequestId: string) {
  const now = '2026-08-07T08:00:00.000Z';
  const preview = state === 'preview';
  const succeeded = state === 'succeeded';
  return {
    taskId,
    clientRequestId,
    action: 'edit_sku',
    status: preview ? 'preview' : succeeded ? 'succeeded' : 'failed',
    previewRevision: 1,
    cancelRequestedAt: null,
    confirmedAt: preview ? null : now,
    startedAt: preview ? null : now,
    finishedAt: preview ? null : now,
    createdAt: now,
    updatedAt: now,
    summary: {
      total: 1,
      pending: preview ? 1 : 0,
      running: 0,
      retryWait: 0,
      succeeded: succeeded ? 1 : 0,
      failed: state === 'unknown' ? 1 : 0,
      skipped: 0,
      cancelled: 0,
      completed: preview ? 0 : 1,
      progressPercent: preview ? 0 : 100,
    },
    items: [
      {
        itemId,
        publishedProductId: productId,
        title: 'M87 SKU 回归商品',
        mainImage: null,
        shopId: '3',
        shopName: '演示店铺',
        platform: 'douyin',
        platformProductId: 'platform-11',
        beforeTitle: 'M87 SKU 回归商品',
        desiredTitle: null,
        actualTitle: null,
        beforeStatus: 'offline',
        desiredStatus: 'offline',
        actualStatus: succeeded ? 'offline' : null,
        beforePrice: 19.9,
        desiredPrice: 19.9,
        beforePriceRange: [19.9, 20.9],
        desiredPriceRange: [19.9, 25.9],
        actualPriceRange: succeeded ? [19.9, 25.9] : null,
        skuCount: succeeded ? 3 : 2,
        beforeInventory: null,
        desiredInventory: null,
        actualInventory: null,
        beforeInventoryVersion: null,
        desiredInventoryVersion: null,
        cleanupEvidence: null,
        beforeSourceProductId: '16880011',
        desiredSourceProductId: '16880011',
        actualSourceProductId: succeeded ? '16880011' : null,
        beforeSourceTitle: '回归货源',
        desiredSourceTitle: '回归货源',
        sourceRouteCount: 3,
        sourceCostRange: [8, 9],
        beforeSkuFingerprint: beforeFingerprint,
        desiredSkuFingerprint: desiredFingerprint,
        actualSkuFingerprint: succeeded ? desiredFingerprint : null,
        skuAddedCount: 1,
        skuChangedCount: 1,
        skuDeletedCount: 0,
        retryable: state === 'unknown',
        status: preview ? 'pending' : succeeded ? 'succeeded' : 'failed',
        attempts: preview ? 0 : 1,
        maxAttempts: 3,
        errorCode: state === 'unknown' ? 'SKU_WRITE_STARTED' : null,
        errorMessage: state === 'unknown' ? '平台响应中断，写入结果未知' : null,
        result: null,
        startedAt: preview ? null : now,
        finishedAt: preview ? null : now,
      },
    ],
  };
}
