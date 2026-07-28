import type { LlmModel } from '@supplier/shared-types';

/**
 * 单价：人民币 / 1K token
 * 注：价格随供应商调整，定期校准；只用于内部成本核算，不暴露给用户。
 */
interface ModelPrice {
  inputPerKToken: number;
  outputPerKToken: number;
}

const PRICES: Record<LlmModel, ModelPrice> = {
  'gpt-4o': { inputPerKToken: 0.018, outputPerKToken: 0.072 },
  'gpt-4o-mini': { inputPerKToken: 0.0011, outputPerKToken: 0.0043 },
  'claude-sonnet-4': { inputPerKToken: 0.022, outputPerKToken: 0.108 },
  'claude-haiku-4': { inputPerKToken: 0.0072, outputPerKToken: 0.036 },
  'deepseek-v3': { inputPerKToken: 0.0014, outputPerKToken: 0.0028 },
  'qwen-max': { inputPerKToken: 0.04, outputPerKToken: 0.12 },
  'qwen-plus': { inputPerKToken: 0.0008, outputPerKToken: 0.002 },
  'qwen-vl-max': { inputPerKToken: 0.02, outputPerKToken: 0.02 },
};

export function calcCostCny(model: LlmModel, inputTokens: number, outputTokens: number): number {
  const price = PRICES[model];
  if (!price) return 0;
  return Number(
    (
      (price.inputPerKToken * inputTokens) / 1000 +
      (price.outputPerKToken * outputTokens) / 1000
    ).toFixed(6),
  );
}
