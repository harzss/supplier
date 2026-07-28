import { Injectable } from '@nestjs/common';
import sharp from 'sharp';

const IMAGE_WIDTH = 750;
const HORIZONTAL_PADDING = 56;
const CONTENT_WIDTH = IMAGE_WIDTH - HORIZONTAL_PADDING * 2;

type DetailBlockType = 'summary' | 'heading' | 'paragraph' | 'bullet';

interface DetailBlock {
  type: DetailBlockType;
  text: string;
}

@Injectable()
export class DetailImageRenderer {
  async render(html: string): Promise<Buffer> {
    const blocks = parseDetailBlocks(html);
    if (!blocks.some((block) => block.type === 'heading')) {
      throw new Error('AI 详情 HTML 缺少可渲染段落');
    }

    const { elements, height } = layoutBlocks(blocks);
    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${IMAGE_WIDTH}" height="${height}" viewBox="0 0 ${IMAGE_WIDTH} ${height}">`,
      '<rect width="100%" height="100%" fill="#fffdf9"/>',
      '<rect width="100%" height="10" fill="#ff6b35"/>',
      `<g font-family="PingFang SC, Noto Sans CJK SC, Microsoft YaHei, Arial, sans-serif">${elements.join('')}</g>`,
      '</svg>',
    ].join('');

    return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  }
}

function parseDetailBlocks(html: string): DetailBlock[] {
  const blocks: DetailBlock[] = [];
  const tags = /<(h2|p|li)([^>]*)>([\s\S]*?)<\/\1>/gi;
  for (const match of html.matchAll(tags)) {
    const tag = match[1]?.toLowerCase();
    const attributes = match[2] ?? '';
    const text = decodeHtml((match[3] ?? '').replace(/<[^>]*>/g, '')).trim();
    if (!text) continue;
    const type: DetailBlockType =
      tag === 'h2'
        ? 'heading'
        : tag === 'li'
          ? 'bullet'
          : attributes.includes('supplier-detail-summary')
            ? 'summary'
            : 'paragraph';
    blocks.push({ type, text });
  }
  return blocks;
}

function layoutBlocks(blocks: DetailBlock[]): { elements: string[]; height: number } {
  const elements: string[] = [];
  let y = 70;
  let seenHeading = false;

  for (const block of blocks) {
    if (block.type === 'summary') {
      const lines = wrapText(block.text, CONTENT_WIDTH, 30);
      elements.push(
        `<rect x="${HORIZONTAL_PADDING - 16}" y="${y - 38}" width="${CONTENT_WIDTH + 32}" height="${lines.length * 44 + 28}" rx="18" fill="#fff1e8"/>`,
      );
      for (const line of lines) {
        elements.push(textElement(HORIZONTAL_PADDING, y, line, 30, '#7c3f27', 500));
        y += 44;
      }
      y += 32;
      continue;
    }

    if (block.type === 'heading') {
      if (seenHeading) {
        elements.push(
          `<line x1="${HORIZONTAL_PADDING}" y1="${y}" x2="${IMAGE_WIDTH - HORIZONTAL_PADDING}" y2="${y}" stroke="#f0e7df" stroke-width="2"/>`,
        );
        y += 50;
      }
      const lines = wrapText(block.text, CONTENT_WIDTH - 24, 36);
      elements.push(
        `<rect x="${HORIZONTAL_PADDING}" y="${y - 31}" width="8" height="34" rx="4" fill="#ff6b35"/>`,
      );
      for (const line of lines) {
        elements.push(textElement(HORIZONTAL_PADDING + 24, y, line, 36, '#26211e', 700));
        y += 50;
      }
      y += 12;
      seenHeading = true;
      continue;
    }

    const isBullet = block.type === 'bullet';
    const x = HORIZONTAL_PADDING + (isBullet ? 24 : 0);
    const maxWidth = CONTENT_WIDTH - (isBullet ? 24 : 0);
    const lines = wrapText(block.text, maxWidth, 28);
    if (isBullet) {
      elements.push(`<circle cx="${HORIZONTAL_PADDING + 6}" cy="${y - 9}" r="5" fill="#ff8b5f"/>`);
    }
    for (const line of lines) {
      elements.push(textElement(x, y, line, 28, '#514943', 400));
      y += 44;
    }
    y += isBullet ? 10 : 22;
  }

  return { elements, height: Math.max(500, Math.ceil(y + 46)) };
}

function wrapText(text: string, maxWidth: number, fontSize: number): string[] {
  const lines: string[] = [];
  let line = '';
  let width = 0;

  for (const character of Array.from(text)) {
    const characterWidth = estimatedCharacterWidth(character, fontSize);
    if (line && width + characterWidth > maxWidth) {
      lines.push(line);
      line = character;
      width = characterWidth;
    } else {
      line += character;
      width += characterWidth;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function estimatedCharacterWidth(character: string, fontSize: number): number {
  if (/\s/.test(character)) return fontSize * 0.35;
  return /^[\x00-\xff]$/.test(character) ? fontSize * 0.58 : fontSize;
}

function textElement(
  x: number,
  y: number,
  value: string,
  fontSize: number,
  fill: string,
  fontWeight: number,
): string {
  return `<text x="${x}" y="${y}" font-size="${fontSize}" font-weight="${fontWeight}" fill="${fill}">${escapeXml(value)}</text>`;
}

function decodeHtml(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
