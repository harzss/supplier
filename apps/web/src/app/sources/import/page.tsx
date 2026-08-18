import { Suspense } from 'react';
import { AuditTestUnavailable } from '@/components/audit-test-unavailable';
import { SourceImportWorkbench } from '@/components/source-import-workbench';
import { isAuditTestMode } from '@/lib/environment';

export default function SourceImportPage() {
  if (isAuditTestMode) {
    return (
      <AuditTestUnavailable
        title="批量货源采集本轮暂未开放"
        description="审核测试版先使用已核验的受控货源完成真实发布与履约；最多 100 件的批量采集将在两个 1688 买家数据口径和配额验证完成后开放。"
        backHref="/sources"
        backLabel="返回我的货源"
      />
    );
  }
  return (
    <Suspense fallback={<p className="text-sm text-zinc-400">正在打开 1688 采集工作台…</p>}>
      <SourceImportWorkbench />
    </Suspense>
  );
}
