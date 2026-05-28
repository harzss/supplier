#!/usr/bin/env node
/**
 * 一键测试 LLM 接入是否可用。
 *
 * 用法：
 *   1. 在 apps/bff/.env 填入任意一个 API Key（DEEPSEEK_API_KEY / DASHSCOPE_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY）
 *   2. node scripts/test-llm.mjs
 *
 * 推荐用 DeepSeek：
 *   注册 https://platform.deepseek.com/  → API Keys → 复制
 *   新用户有免费额度，本测试约消耗 ¥0.001
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');

// ---- 加载 .env ----
function loadEnv(path) {
  try {
    const text = readFileSync(path, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // 文件不存在则忽略
  }
}
loadEnv(join(ROOT, 'apps/bff/.env'));
loadEnv(join(ROOT, '.env'));

// ---- 加载 LLM Client ----
const distPath = join(ROOT, 'packages/llm-client/dist/index.js');
let llm;
try {
  llm = await import(distPath);
} catch (e) {
  console.error('❌ llm-client 还没编译，先跑：');
  console.error('   pnpm --filter @supplier/llm-client build');
  process.exit(1);
}

const { LlmClient, createDeepSeek, createDashScope, createOpenAi, createAnthropic } = llm;

// ---- 装配客户端 ----
const primary = new Map();
const fallback = new Map();
const configured = [];

if (process.env.DEEPSEEK_API_KEY) {
  primary.set('deepseek-v3', createDeepSeek(process.env.DEEPSEEK_API_KEY));
  configured.push('DeepSeek');
}
if (process.env.DASHSCOPE_API_KEY) {
  const ds = createDashScope(process.env.DASHSCOPE_API_KEY);
  primary.set('qwen-plus', ds);
  primary.set('qwen-max', ds);
  configured.push('DashScope (Qwen)');
}
if (process.env.OPENAI_API_KEY) {
  const oa = createOpenAi(process.env.OPENAI_API_KEY);
  primary.set('gpt-4o-mini', oa);
  primary.set('gpt-4o', oa);
  configured.push('OpenAI');
}
if (process.env.ANTHROPIC_API_KEY) {
  const an = createAnthropic(process.env.ANTHROPIC_API_KEY);
  primary.set('claude-haiku-4', an);
  primary.set('claude-sonnet-4', an);
  configured.push('Anthropic');
}

if (configured.length === 0) {
  console.error('❌ 没找到任何 LLM API Key。');
  console.error('');
  console.error('请把 Key 填到 apps/bff/.env，例如：');
  console.error('  DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx');
  console.error('');
  console.error('推荐 DeepSeek（注册即送 ¥10 额度）：');
  console.error('  https://platform.deepseek.com/api_keys');
  process.exit(1);
}

console.log(`✓ 已配置: ${configured.join(', ')}`);

// ---- 测试调用 ----
const client = new LlmClient({ primary, fallback, maxRetries: 1, retryBaseMs: 200 });

const model = primary.has('deepseek-v3')
  ? 'deepseek-v3'
  : primary.has('qwen-plus')
    ? 'qwen-plus'
    : primary.has('gpt-4o-mini')
      ? 'gpt-4o-mini'
      : primary.has('claude-haiku-4')
        ? 'claude-haiku-4'
        : null;

if (!model) {
  console.error('❌ 没有可用的便宜模型');
  process.exit(1);
}

console.log(`→ 用 ${model} 生成 5 条抖音小店标题...`);
const t0 = Date.now();

try {
  const result = await client.chat({
    model,
    messages: [
      {
        role: 'system',
        content:
          '你是抖音小店标题优化专家。要求：30 字以内，前 12 字含核心词；禁用极限词与医疗用语；输出 JSON: {"titles": ["...", ...]}',
      },
      {
        role: 'user',
        content: '原标题：纯棉夏季短袖T恤\n类目：女装/T恤\n卖点：100%纯棉；透气吸汗\n生成 5 条候选，仅 JSON。',
      },
    ],
    temperature: 0.8,
    maxTokens: 400,
    jsonMode: true,
    timeoutMs: 30_000,
  });

  console.log(`✓ 用时 ${Date.now() - t0}ms`);
  console.log(`✓ 成本 ¥${result.usage.costCny}（in=${result.usage.inputTokens} out=${result.usage.outputTokens}）`);
  console.log('');
  console.log('--- 模型输出 ---');
  console.log(result.content);
  console.log('');

  try {
    const parsed = JSON.parse(result.content.replace(/```(?:json)?\s*/g, '').replace(/```/g, ''));
    if (Array.isArray(parsed.titles)) {
      console.log('--- 解析后 ---');
      parsed.titles.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
    }
  } catch {
    // 解析失败也无所谓，原始输出已经打印
  }

  console.log('');
  console.log('✓ LLM 接入测试通过');
} catch (err) {
  console.error('❌ 调用失败:', err.message);
  if (err.providerRaw) console.error('  raw:', String(err.providerRaw).slice(0, 300));
  process.exit(1);
}
