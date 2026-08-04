import { describe, expect, it } from 'vitest';
import { buildTitleMessages, parseAndFilterTitles, validateTitleForPlatform } from './title.prompt';

describe('buildTitleMessages', () => {
  it('builds system + user prompt for douyin', () => {
    const msgs = buildTitleMessages({
      originalTitle: '纯棉夏季短袖 T 恤',
      category: '女装/T恤',
      sellingPoints: ['100% 纯棉', '透气'],
      targetPlatform: 'douyin',
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toContain('抖音小店');
    expect(msgs[0]!.content).toContain('8～30 个汉字');
    expect(msgs[1]!.content).toContain('纯棉夏季短袖');
  });
});

describe('parseAndFilterTitles', () => {
  it('parses plain JSON', () => {
    const r = parseAndFilterTitles(
      JSON.stringify({ titles: ['夏季轻薄纯棉短袖T恤', '透气吸汗短T恤女装'] }),
      'douyin',
    );
    expect(r.titles).toEqual(['夏季轻薄纯棉短袖T恤', '透气吸汗短T恤女装']);
  });

  it('parses fenced code blocks', () => {
    const raw = '好的，结果：\n```json\n{"titles": ["夏季轻薄纯棉短袖", "通勤宽松圆领短袖"]}\n```';
    const r = parseAndFilterTitles(raw, 'douyin');
    expect(r.titles).toEqual(['夏季轻薄纯棉短袖', '通勤宽松圆领短袖']);
  });

  it('rejects titles exceeding length limit', () => {
    const long = 'A'.repeat(61);
    const r = parseAndFilterTitles(
      JSON.stringify({ titles: [long, '夏季轻薄纯棉短袖'] }),
      'douyin',
    );
    expect(r.titles).toEqual(['夏季轻薄纯棉短袖']);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]!.reason).toContain('60 个字符');
  });

  it('rejects forbidden words', () => {
    const r = parseAndFilterTitles(
      JSON.stringify({ titles: ['全网最便宜纯棉短袖', '舒适透气纯棉短袖上衣'] }),
      'douyin',
    );
    expect(r.titles).toEqual(['舒适透气纯棉短袖上衣']);
    expect(r.rejected[0]!.reason).toContain('最');
  });

  it('handles malformed JSON gracefully', () => {
    const r = parseAndFilterTitles('not json', 'douyin');
    expect(r.titles).toEqual([]);
    expect(r.rejected).toHaveLength(1);
  });

  it('reuses platform rules for a user-selected publish title', () => {
    expect(validateTitleForPlatform('舒适透气纯棉短袖上衣', 'douyin')).toBeNull();
    expect(validateTitleForPlatform('短袖', 'douyin')).toContain('16 个字符');
    expect(validateTitleForPlatform('全网最便宜纯棉T恤', 'douyin')).toContain('禁用词');
    expect(validateTitleForPlatform('A'.repeat(60), 'douyin')).toBeNull();
    expect(validateTitleForPlatform('A'.repeat(61), 'douyin')).toContain('60 个字符');
    expect(validateTitleForPlatform('好'.repeat(31), 'douyin')).toContain('30 个汉字');
    expect(validateTitleForPlatform('🙂'.repeat(30), 'pdd')).toBeNull();
    expect(validateTitleForPlatform('🙂'.repeat(31), 'pdd')).toContain('30 字');
  });
});
