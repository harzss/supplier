import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  PublicDocumentSection,
  PublicDocumentShell,
  PublicTodo,
} from '@/components/public-document-shell';
import { isLegalPagesEnabled } from '@/lib/environment';

export const metadata: Metadata = {
  title: '用户协议草案 · Supplier',
  description: 'Supplier 邀请制审核测试版的使用边界与双方责任。',
  robots: { index: false, follow: false },
};

export default function TermsPage() {
  if (!isLegalPagesEnabled) notFound();

  return (
    <PublicDocumentShell
      eyebrow="Terms / Draft 0.1"
      title="用户协议草案"
      summary="先把邀请测试期间能做什么、不能做什么、谁对外部平台动作负责说清楚，再进入真实业务联调。"
      updatedAt="2026-08-19"
    >
      <PublicDocumentSection number="01" title="测试资格与协议主体">
        <p>
          当前版本仅供受邀商家、审核人员和授权协作者测试。账号不得转借、出售或用于未授权主体的店铺、买家账号和订单。
        </p>
        <PublicTodo>补充运营主体、签约主体、协议生效方式、版本号及适用地域。</PublicTodo>
      </PublicDocumentSection>

      <PublicDocumentSection number="02" title="服务范围">
        <p>
          当前目标范围为单个抖店销售店、受控 1688
          买家账号，以及选品、利润试算、人工确认发布、订单回流、人工付款采购、物流和售后异常处置。未通过真实验收的批量、自动采购、自动退款、AI
          主图、多店与多平台能力保持隐藏或关闭。
        </p>
        <p>任何页面、演示或测试结果都不构成“平台必然审核通过”“商品必然上架”或“经营收益保证”。</p>
      </PublicDocumentSection>

      <PublicDocumentSection number="03" title="账号、授权与操作责任">
        <ul>
          <li>用户应确保提交的主体、店铺、商品、订单、收货和付款信息真实且已获得合法授权。</li>
          <li>用户应保护邮箱、密码、平台授权和设备，不得绕过权限、限流、停权或人工确认。</li>
          <li>
            采购付款、退款、退货、替代货源等高风险动作在当前范围内由用户人工确认并承担相应经营责任。
          </li>
          <li>
            发现 Token
            失效、结果未知、重复单、退款或物流不一致时，应停止继续操作并按异常中心提示核对。
          </li>
        </ul>
      </PublicDocumentSection>

      <PublicDocumentSection number="04" title="内容、知识产权与平台规则">
        <p>
          用户应拥有商品图片、文案、商标和资质的使用权，并遵守抖店、1688 及适用类目的规则。AI
          生成内容必须经过人工确认；是否需要显著或元数据标识，以当前法律和平台规则为准。
        </p>
        <PublicTodo>由法务确认用户内容授权、生成内容权属、侵权通知与反通知流程。</PublicTodo>
      </PublicDocumentSection>

      <PublicDocumentSection number="05" title="费用与第三方服务">
        <p>
          当前候选没有 Supplier 购买入口或自动续费扣款能力，受邀测试资格本身不产生软件订阅费。模型
          API、1688、销售平台及其他第三方费用仍须在真实账号与合同中逐项核验。
        </p>
        <p>正式套餐、试用、续费和退款规则尚未生效；任何后续收费方案都应在购买前明确展示。</p>
      </PublicDocumentSection>

      <PublicDocumentSection number="06" title="可用性、暂停与终止">
        <p>
          当前为审核测试版，尚未承诺正式 SLA。系统可能因维护、平台
          API、Supabase、Cloudflare、Railway
          或网络异常暂时不可用。为防止错单、重复采购或越权，系统可以暂停高风险能力；暂停后的可读范围、数据导出、凭证清理和申诉入口尚未完成验收。
        </p>
        <PublicTodo>
          确定正式支持时段、服务目标、维护通知、升级路径、赔偿上限和不可抗力边界。
        </PublicTodo>
      </PublicDocumentSection>

      <PublicDocumentSection number="07" title="违约、责任与争议">
        <p>
          禁止利用服务实施违法经营、欺诈、垃圾信息、侵权、未授权数据获取或破坏平台稳定性的行为。发生重大安全或合规风险时，可立即限制相关能力并保留审计证据。
        </p>
        <PublicTodo>
          补充责任限制、赔偿、通知送达、适用法律、管辖与争议解决条款，并完成正式法务审查。
        </PublicTodo>
      </PublicDocumentSection>
    </PublicDocumentShell>
  );
}
