import { Suspense } from 'react';
import { AuditTestUnavailable } from '@/components/audit-test-unavailable';
import { ProductBatchWorkbench } from '@/components/product-batch-workbench';
import { isAuditTestMode } from '@/lib/environment';

export default function ProductBatchPage() {
  if (isAuditTestMode) {
    return (
      <AuditTestUnavailable
        title="批量经营本轮暂未开放"
        description="本轮只验收单商品发布、订单、采购和履约。批量上下架、标题、价格、库存与完整 SKU 编辑将在真实平台专项验收后开放。"
        backHref="/published"
        backLabel="返回铺货中心"
      />
    );
  }
  return (
    <Suspense fallback={<p className="text-sm text-zinc-400">正在打开批量经营工作台…</p>}>
      <ProductBatchWorkbench />
    </Suspense>
  );
}
