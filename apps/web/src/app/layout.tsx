import type { Metadata } from 'next';
import './globals.css';
import { AppRoot } from '@/components/app-root';

export const metadata: Metadata = {
  title: 'Supplier - 更简单的 1688 分销经营工具',
  description: '连接 1688 货源、选品铺货、订单采购、物流售后与利润分析的一体化商家工作台。',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <AppRoot>{children}</AppRoot>
      </body>
    </html>
  );
}
