import { Suspense } from 'react';
import { SourceImportWorkbench } from '@/components/source-import-workbench';

export default function SourceImportPage() {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-400">正在打开 1688 采集工作台…</p>}>
      <SourceImportWorkbench />
    </Suspense>
  );
}
