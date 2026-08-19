import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  PublicDocumentSection,
  PublicDocumentShell,
  PublicTodo,
} from '@/components/public-document-shell';
import { isLegalPagesEnabled } from '@/lib/environment';

export const metadata: Metadata = {
  title: '隐私政策草案 · Supplier',
  description: 'Supplier 邀请制审核测试版的数据处理边界说明。',
  robots: { index: false, follow: false },
};

const DATA_CATEGORIES = [
  ['账号与身份', '受邀邮箱、Supabase 身份标识、账号状态和当前权益状态。'],
  ['店铺与平台授权', '店铺标识、授权状态、权限范围及为调用平台接口所需的加密凭证。'],
  ['商品与经营数据', '1688 货源、商品、SKU、价格、库存、发布状态和经营分析数据。'],
  ['订单与履约', '订单、金额、售后、采购与物流信息；订单收件联系方式按应用设计使用密文字段保存。'],
  [
    '安全与审计',
    '请求结果、操作类型、错误码、脱敏网络标识和安全事件；不在审计记录中保存请求正文、Token、Cookie 或密钥。',
  ],
  [
    'AI 与模型使用',
    '用户主动提交的生成任务、生成结果、模型和用量；使用 BYOK 时，模型密钥由服务端加密保存。',
  ],
] as const;

export default function PrivacyPage() {
  if (!isLegalPagesEnabled) notFound();

  return (
    <PublicDocumentShell
      eyebrow="Privacy / Draft 0.1"
      title="隐私政策草案"
      summary="用清楚、可核对的方式说明 Supplier 在邀请制测试期间处理哪些数据、为什么处理，以及哪些内容仍需在正式提审前确认。"
      updatedAt="2026-08-19"
    >
      <PublicDocumentSection number="01" title="适用范围">
        <p>
          本草案适用于 Supplier 抖店 + 1688
          邀请制审核测试版。当前只面向受邀测试账号，不代表已经公开商用、通过平台审核或开放多平台自动经营。
        </p>
        <PublicTodo>
          补充运营主体全称、统一社会信用代码、注册地址、隐私联系人和正式生效日期。
        </PublicTodo>
      </PublicDocumentSection>

      <PublicDocumentSection number="02" title="处理的数据">
        <div className="public-document-data-grid">
          {DATA_CATEGORIES.map(([title, description]) => (
            <div key={title}>
              <h3>{title}</h3>
              <p>{description}</p>
            </div>
          ))}
        </div>
        <p>
          用户资料中的普通联系电话字段与订单收件联系方式不是同一数据结构，当前不能笼统宣称“所有手机号均已字段级加密”。正式政策必须按真实存储与使用路径逐项核验。
        </p>
      </PublicDocumentSection>

      <PublicDocumentSection number="03" title="处理目的与必要性">
        <ul>
          <li>完成身份验证、邀请制访问、账号安全和租户隔离。</li>
          <li>连接受控店铺与买家账号，执行用户明确发起的商品、订单和履约操作。</li>
          <li>计算利润与风险、保存任务状态、恢复中断操作并避免重复发布、采购或发货。</li>
          <li>排查故障、审计高风险操作、处理售后与安全事件。</li>
          <li>仅在用户主动选择时调用模型生成标题、详情或图片相关内容。</li>
        </ul>
      </PublicDocumentSection>

      <PublicDocumentSection number="04" title="服务提供方与数据流向">
        <p>
          当前技术链路使用 Supabase 提供数据库、认证与对象存储，Cloudflare 提供 Web 与网关能力；常驻
          BFF 计划部署在 Railway。抖店、1688
          及用户选择的模型服务商仅在相应功能被主动使用时接收完成请求所需的数据。
        </p>
        <p>
          当前产品设计没有主动出售业务数据或把业务数据建立为通用模型训练集的功能；但第三方服务商的留存、训练和合同边界尚未完成法务核验，因此本草案不作最终承诺。
        </p>
        <PublicTodo>
          逐项核验服务商主体、数据地域、跨境情形、委托处理条款和第三方 SDK/API 清单。
        </PublicTodo>
      </PublicDocumentSection>

      <PublicDocumentSection number="05" title="保存、保护与删除">
        <ul>
          <li>
            当前 staging 公开入口使用 HTTPS；候选代码为平台 OAuth Token、订单收件敏感字段和 BYOK
            密钥提供服务端加密路径。生产密钥管理、轮换和恢复仍待独立验收。
          </li>
          <li>
            审计日志配置默认值为 180
            天；这不是已获批准的正式留存政策，也不能外推到订单、商品、授权或其他业务数据。
          </li>
          <li>后台任务保留状态和幂等证据，用于识别迟到结果并防止重复副作用。</li>
          <li>账号注销与业务数据删除尚无已验收闭环，候选流程见账号注销说明。</li>
        </ul>
        <PublicTodo>
          由产品、法务和平台规则共同确定每类数据的保存期限、法定留存例外与销毁证据。
        </PublicTodo>
      </PublicDocumentSection>

      <PublicDocumentSection number="06" title="你的权利">
        <p>
          正式政策需要说明用户依法享有的查询、更正、复制、删除、撤回授权和注销权利，以及每项权利的身份核验和处理例外。当前尚无可达的正式隐私请求渠道或端到端处理证据，本页面不能受理申请。
        </p>
        <PublicTodo>
          上线正式隐私邮箱或站内入口、受理编号、处理时限和申诉升级机制，并完成真实请求演练。
        </PublicTodo>
      </PublicDocumentSection>

      <PublicDocumentSection number="07" title="未成年人、变更与联系">
        <p>
          Supplier
          面向具备经营能力的商家和授权操作人员，不面向未成年人。重要政策变更应在生效前通过站内或约定渠道通知，并保留版本记录。
        </p>
        <PublicTodo>补充未成年人误用处置、正式联系渠道、版本号和历史版本入口。</PublicTodo>
      </PublicDocumentSection>
    </PublicDocumentShell>
  );
}
