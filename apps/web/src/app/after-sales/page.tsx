import { Suspense } from 'react';
import {
  AfterSaleWorkbench,
  AfterSaleWorkbenchPageSkeleton,
} from '@/components/after-sale-workbench/after-sale-workbench';

export default function AfterSalesPage() {
  return (
    <Suspense fallback={<AfterSaleWorkbenchPageSkeleton />}>
      <AfterSaleWorkbench />
    </Suspense>
  );
}
