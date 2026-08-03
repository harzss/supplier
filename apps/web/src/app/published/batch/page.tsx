import { Suspense } from 'react';
import { ProductBatchWorkbench } from '@/components/product-batch-workbench';

export default function ProductBatchPage() {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-400">正在打开批量经营工作台…</p>}>
      <ProductBatchWorkbench />
    </Suspense>
  );
}
