import { Suspense } from 'react';
import {
  ExceptionCenter,
  ExceptionCenterPageSkeleton,
} from '@/components/exception-center/exception-center';

export default function ExceptionsPage() {
  return (
    <Suspense fallback={<ExceptionCenterPageSkeleton />}>
      <ExceptionCenter />
    </Suspense>
  );
}
