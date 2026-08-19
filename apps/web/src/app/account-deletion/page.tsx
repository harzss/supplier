import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  PublicDocumentSection,
  PublicDocumentShell,
  PublicTodo,
} from '@/components/public-document-shell';
import { isLegalPagesEnabled } from '@/lib/environment';

export const metadata: Metadata = {
  title: '账号注销说明 · Supplier',
  description: 'Supplier 邀请制审核测试版的人工停用与注销准备流程。',
  robots: { index: false, follow: false },
};

export default function AccountDeletionPage() {
  if (!isLegalPagesEnabled) notFound();

  return (
    <PublicDocumentShell
      eyebrow="Account / Manual Process"
      title="账号注销说明"
      summary="当前没有已验收的注销受理入口或自动删除能力。本页只展示待实现流程，避免把停用、解绑或联系管理员误写成已提交注销。"
      updatedAt="2026-08-19"
    >
      <PublicDocumentSection number="01" title="当前状态：尚不可受理">
        <p>
          当前联系邀请管理员只能表达停用或注销意向，不能生成正式请求、启动数据删除或证明处理完成。管理员不得要求用户在聊天中发送密码、Token、Secret
          或证件原图，也不得口头承诺删除时限。
        </p>
        <PublicTodo>实现站内注销申请、身份二次验证、工单编号、状态查询和正式受理渠道。</PublicTodo>
      </PublicDocumentSection>

      <PublicDocumentSection number="02" title="提交前检查">
        <ul>
          <li>确认没有正在发布、采购、同步、退款、物流或售后的任务。</li>
          <li>核对未完成订单、退款、对账、应付款和需要保留的审计证据。</li>
          <li>在对应平台撤销或停用不再需要的店铺与买家账号授权。</li>
          <li>确认需要导出或交接的数据，以及依法或按平台规则必须保留的数据。</li>
        </ul>
      </PublicDocumentSection>

      <PublicDocumentSection number="03" title="停用、注销与删除的区别">
        <div className="public-document-data-grid">
          <div>
            <h3>停止访问</h3>
            <p>账号无法继续登录或执行新动作，但历史业务数据尚未删除。</p>
          </div>
          <div>
            <h3>撤销授权</h3>
            <p>停止 Supplier 继续代表用户调用平台接口，不等同于删除本地业务记录。</p>
          </div>
          <div>
            <h3>账号注销</h3>
            <p>完成身份、订单、售后、结算和留存核验后终止账号关系。</p>
          </div>
          <div>
            <h3>数据删除或匿名化</h3>
            <p>按逐类数据规则执行，并保留删除范围、时间和例外依据的证据。</p>
          </div>
        </div>
      </PublicDocumentSection>

      <PublicDocumentSection number="04" title="当前不能承诺的事项">
        <p>
          目前尚未完成正式受理、自动化注销、每类数据保存期限、法定留存例外、删除完成时限和可下载删除凭证，因此不能承诺“提交后立即删除全部数据”。未来流程必须把实际完成范围与未删除原因告知申请人。
        </p>
        <PublicTodo>
          法务确认留存规则；工程实现可审计的级联删除/匿名化；客服完成验收脚本和超时升级流程。
        </PublicTodo>
      </PublicDocumentSection>
    </PublicDocumentShell>
  );
}
