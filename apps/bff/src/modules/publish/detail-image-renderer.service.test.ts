import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { DetailImageRenderer } from './detail-image-renderer.service';

describe('DetailImageRenderer', () => {
  it('renders structured detail HTML into a 750px-wide PNG', async () => {
    const renderer = new DetailImageRenderer();
    const image = await renderer.render(
      [
        '<div class="supplier-detail">',
        '<p class="supplier-detail-summary">日常好搭配 &amp; 信息真实</p>',
        '<section><h2>核心卖点</h2><p>版型简洁，适合日常穿着。</p><ul><li>通勤百搭</li></ul></section>',
        '<section><h2>材质参数</h2><p>已知材质为棉。</p></section>',
        '<section><h2>适用场景</h2><p>购买前请确认规格。</p></section>',
        '</div>',
      ].join(''),
    );

    const metadata = await sharp(image).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(750);
    expect(metadata.height).toBeGreaterThan(500);
  });

  it('rejects HTML without structured headings', async () => {
    await expect(new DetailImageRenderer().render('<p>只有一段正文</p>')).rejects.toThrow(
      '缺少可渲染段落',
    );
  });
});
