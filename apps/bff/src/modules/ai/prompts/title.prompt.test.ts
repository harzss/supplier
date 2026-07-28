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
    expect(msgs[0]!.content).toContain('30 字');
    expect(msgs[1]!.content).toContain('纯棉夏季短袖');
  });
});

describe('parseAndFilterTitles', () => {
  it('parses plain JSON', () => {
    const r = parseAndFilterTitles(
      JSON.stringify({ titles: ['夏季纯棉短袖T恤', '透气吸汗短T恤女装'] }),
      'douyin',
    );
    expect(r.titles).toEqual(['夏季纯棉短袖T恤', '透气吸汗短T恤女装']);
  });

  it('parses fenced code blocks', () => {
    const raw = '好的，结果：\n```json\n{"titles": ["A", "B"]}\n```';
    const r = parseAndFilterTitles(raw, 'douyin');
    expect(r.titles).toEqual(['A', 'B']);
  });

  it('rejects titles exceeding length limit', () => {
    const long = 'A'.repeat(50);
    const r = parseAndFilterTitles(JSON.stringify({ titles: [long, 'OK'] }), 'douyin');
    expect(r.titles).toEqual(['OK']);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]!.reason).toContain('30 字');
  });

  it('rejects forbidden words', () => {
    const r = parseAndFilterTitles(
      JSON.stringify({ titles: ['最便宜的T恤', '舒适T恤'] }),
      'douyin',
    );
    expect(r.titles).toEqual(['舒适T恤']);
    expect(r.rejected[0]!.reason).toContain('最');
  });

  it('handles malformed JSON gracefully', () => {
    const r = parseAndFilterTitles('not json', 'douyin');
    expect(r.titles).toEqual([]);
    expect(r.rejected).toHaveLength(1);
  });

  it('reuses platform rules for a user-selected publish title', () => {
    expect(validateTitleForPlatform('舒适纯棉T恤', 'douyin')).toBeNull();
    expect(validateTitleForPlatform('全网最便宜纯棉T恤', 'douyin')).toContain('禁用词');
    expect(validateTitleForPlatform('A'.repeat(31), 'douyin')).toContain('30 字');
  });
});
