import { describe, expect, it } from 'vitest';
import { buildDetailMessages, parseDetailContent } from './detail.prompt';

describe('buildDetailMessages', () => {
  it('limits the model to known product facts and structured JSON', () => {
    const messages = buildDetailMessages({
      title: '纯棉短袖 T 恤',
      category: '女装/T恤',
      sellingPoints: ['一件代发'],
      attributes: { material: '棉' },
      targetPlatform: 'douyin',
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toContain('不得编造');
    expect(messages[1]!.content).toContain('material：棉');
  });
});

describe('parseDetailContent', () => {
  it('renders at least three structured sections into escaped HTML', () => {
    const result = parseDetailContent(
      JSON.stringify({
        summary: '日常好搭配',
        sections: [
          { heading: '核心卖点', body: '版型简洁', bullets: ['通勤百搭'] },
          { heading: '材质参数', body: '已知材质为棉', bullets: [] },
          { heading: '适用场景', body: '适合日常穿着 <script>', bullets: ['居家 & 出行'] },
        ],
      }),
    );

    expect(result.sections).toHaveLength(3);
    expect(result.detailHtml).toContain('<section>');
    expect(result.detailHtml).not.toContain('<script>');
    expect(result.detailHtml).toContain('居家 &amp; 出行');
  });

  it('replaces forbidden claims and records compliance flags', () => {
    const result = parseDetailContent(
      JSON.stringify({
        summary: '最值得购买',
        sections: [
          { heading: '第一选择', body: '官方认证品质', bullets: [] },
          { heading: '参数', body: '信息以页面为准', bullets: [] },
          { heading: '场景', body: '适合日常使用', bullets: [] },
        ],
      }),
    );

    expect(result.detailHtml).not.toContain('第一');
    expect(result.detailHtml).not.toContain('官方认证');
    expect(result.complianceFlags.length).toBeGreaterThan(0);
  });

  it('rejects responses with fewer than three valid sections', () => {
    expect(() =>
      parseDetailContent(
        JSON.stringify({ summary: '摘要', sections: [{ heading: '卖点', body: '内容' }] }),
      ),
    ).toThrow('有效段落不足 3 个');
  });
});
