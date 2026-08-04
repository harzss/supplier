export async function persistCrawledProduct(prisma, product, inventory, now) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.sourceProduct.findUnique({
      where: { productId1688: product.productId1688 },
      select: { availability: true, inventoryFingerprint: true, inventoryVersion: true },
    });
    const inventoryChanged = existing?.inventoryFingerprint !== inventory.fingerprint;
    const inventoryVersion = inventoryChanged
      ? (existing?.inventoryVersion ?? 0) + 1
      : (existing?.inventoryVersion ?? 1);
    const stored = await tx.sourceProduct.upsert({
      where: { productId1688: product.productId1688 },
      create: {
        ...mapProductToDb(product, inventory, inventoryVersion, now),
        availabilityChangedAt: now,
      },
      update: {
        ...mapProductToDb(product, inventory, inventoryVersion, now),
        ...(existing?.availability !== inventory.availability
          ? { availabilityChangedAt: now }
          : {}),
      },
      select: { id: true },
    });
    await queueInventorySync(tx, stored.id, inventory.fingerprint, inventoryVersion, now);
    return stored;
  });
}

export async function persistOfflineProduct(prisma, productId1688, inventory, now) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.sourceProduct.findUnique({
      where: { productId1688 },
      select: {
        id: true,
        availability: true,
        inventoryFingerprint: true,
        inventoryVersion: true,
      },
    });
    if (!existing) return null;
    const inventoryChanged = existing.inventoryFingerprint !== inventory.fingerprint;
    const inventoryVersion = inventoryChanged
      ? existing.inventoryVersion + 1
      : existing.inventoryVersion;
    await tx.sourceProduct.update({
      where: { id: existing.id },
      data: {
        availability: inventory.availability,
        totalStock: inventory.totalStock,
        inventoryFingerprint: inventory.fingerprint,
        inventoryVersion,
        syncedAt: now,
        ...(existing.availability !== inventory.availability ? { availabilityChangedAt: now } : {}),
      },
    });
    await queueInventorySync(tx, existing.id, inventory.fingerprint, inventoryVersion, now);
    return { id: existing.id };
  });
}

export async function queueInventorySync(
  tx,
  sourceProductId,
  targetFingerprint,
  targetVersion,
  now,
) {
  const targetChanged = [
    { inventoryTargetFingerprint: null },
    { inventoryTargetFingerprint: { not: targetFingerprint } },
    { inventoryTargetVersion: { not: targetVersion } },
  ];
  await tx.publishedProduct.updateMany({
    where: { sourceProductId, status: 'online', OR: targetChanged },
    data: {
      inventorySyncStatus: 'pending',
      inventoryTargetFingerprint: targetFingerprint,
      inventoryTargetVersion: targetVersion,
      inventorySyncAttempts: 0,
      inventoryNextRunAt: now,
      inventoryLockedAt: null,
      inventoryLockedBy: null,
      inventorySyncError: null,
    },
  });
  await tx.publishedProduct.updateMany({
    where: { sourceProductId, status: { not: 'online' }, OR: targetChanged },
    data: {
      inventoryTargetFingerprint: targetFingerprint,
      inventoryTargetVersion: targetVersion,
    },
  });
}

function mapProductToDb(product, inventory, inventoryVersion, syncedAt) {
  return {
    productId1688: product.productId1688,
    supplierId: product.supplierId,
    title: product.title,
    price: product.price,
    priceMin: product.priceMin,
    priceMax: product.priceMax,
    mainImage: product.mainImage,
    detailImages: product.detailImages ?? [],
    categoryPath: product.categoryPath,
    categoryL1: product.categoryL1,
    categoryL2: product.categoryL2,
    skuList: product.skuList ?? [],
    attributes: { ...(product.attributes ?? {}), signals: product.signals ?? {} },
    monthlySold: product.monthlySold ?? 0,
    isCrossBorder: product.isCrossBorder ?? false,
    isOnePieceDrop: product.isOnePieceDrop ?? false,
    availability: inventory.availability,
    totalStock: inventory.totalStock,
    inventoryFingerprint: inventory.fingerprint,
    inventoryVersion,
    syncedAt,
  };
}
