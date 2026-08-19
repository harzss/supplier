import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  PublicDocumentSection,
  PublicDocumentShell,
  PublicTodo,
} from '@/components/public-document-shell';
import { isLegalPagesEnabled } from '@/lib/environment';

export const metadata: Metadata = {
  title: '帮助与常见问题 · Supplier',
  description: 'Supplier 邀请制审核测试版的上手步骤、功能边界与支持方式。',
  robots: { index: false, follow: false },
};

const START_STEPS = [
  ['01', '接受邀请并设置密码', '只使用收到邀请的邮箱；公开注册保持关闭。'],
  ['02', '等待平台 Gate 通过', '抖店、1688 和服务市场真实账号未验收前，不连接或执行。'],
  ['03', '按批准脚本核对预览', '只使用运营批准的货源、类目、SKU 和测试数据。'],
  ['04', '小步执行并回读', '仅在维护窗口验证一个真实动作，以平台回读作为完成证据。'],
] as const;

export default function HelpPage() {
  if (!isLegalPagesEnabled) notFound();

  return (
    <PublicDocumentShell
      eyebrow="Help / Invitation Preview"
      title="帮助与常见问题"
      summary="围绕第一次安全使用来组织，不把未开放能力包装成可用功能。遇到结果未知时，先停下来核对，而不是重复点击。"
      updatedAt="2026-08-19"
    >
      <PublicDocumentSection number="01" title="目标验收流程（尚未全部开放）">
        <ol className="public-document-steps">
          {START_STEPS.map(([number, title, description]) => (
            <li key={number}>
              <span>{number}</span>
              <div>
                <h3>{title}</h3>
                <p>{description}</p>
              </div>
            </li>
          ))}
        </ol>
      </PublicDocumentSection>

      <PublicDocumentSection number="02" title="当前开放边界">
        <ul>
          <li>邀请制、单店、低流量；采购付款与售后动作保留人工确认。</li>
          <li>公开注册、批量经营、自动采购、自动退款、自动扫描与 AI 主图默认关闭。</li>
          <li>预览不应产生平台副作用；真实动作必须通过平台回读确认。</li>
          <li>Token 失效、超时、结果未知或迟到结果进入人工处置，禁止盲目重试。</li>
        </ul>
      </PublicDocumentSection>

      <PublicDocumentSection number="03" title="常见问题">
        <div className="public-document-faq">
          <details>
            <summary>为什么不能自己注册？</summary>
            <p>当前需要先完成真实账号、数据隔离和平台联调，因此只开放受邀账号。</p>
          </details>
          <details>
            <summary>测试期会自动扣费吗？</summary>
            <p>
              当前候选没有 Supplier
              购买入口或自动续费能力。第三方平台、模型和正式商业规则尚未验收，执行任何可能计费的测试前必须单独确认。
            </p>
          </details>
          <details>
            <summary>页面显示“结果未知”怎么办？</summary>
            <p>停止重复提交，保留请求时间与业务编号，通过平台订单或商品详情回读后再处置。</p>
          </details>
          <details>
            <summary>为什么某些批量或自动化功能不可用？</summary>
            <p>这些能力尚未通过真实平台、租户隔离和失败恢复 Gate，关闭是当前安全边界。</p>
          </details>
          <details>
            <summary>如何查看隐私和注销规则？</summary>
            <p>
              查看<Link href="/privacy">隐私政策草案</Link>与
              <Link href="/account-deletion">账号注销说明</Link>。
            </p>
          </details>
        </div>
      </PublicDocumentSection>

      <PublicDocumentSection number="04" title="获取支持">
        <p>
          邀请管理员目前只能收集测试故障意向，不构成正式客服、隐私权利或注销受理渠道。沟通故障时不得通过聊天或截图发送密码、Token、Secret、身份证件或完整收货信息。
        </p>
        <PublicTodo>
          上线可达的独立客服入口、服务时间、工单编号、故障公告页和 P0
          升级联系人，并完成真实提交与响应演练。
        </PublicTodo>
      </PublicDocumentSection>
    </PublicDocumentShell>
  );
}
