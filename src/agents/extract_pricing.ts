import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { PricingSnapshot, type PricingSnapshotData } from '../schema/pricing.js';
import { groundingViolations } from '../tools/ground.js';
import { EXTRACT_MODEL, costMicros, guardTokens, type TokenCounter } from './_client.js';

const SYSTEM = `You extract pricing facts from a SaaS pricing page.

Rules:
- Report only what the page states. Never infer, never estimate, never fill a gap.
- monthly_price_usd is null when the tier says "contact sales" or shows no price.
  null is NOT zero. Use 0 only when the page states the tier costs nothing.
- currency is the ISO code the page prices in ("USD", "EUR", ...). Do not convert.
- usage_rates is for consumption pricing (per GB, per event, per seat-hour).
- headline_features: at most 8, verbatim from the page.
- extraction_confidence is "low" when the page is ambiguous or you had to guess.`;

export interface ExtractClient extends TokenCounter {
  messages: TokenCounter['messages'] & {
    parse(args: unknown): Promise<{
      parsed_output: unknown;
      usage?: { input_tokens: number; output_tokens: number };
    }>;
  };
}

export interface ExtractDeps { client: ExtractClient; maxAttempts?: number }

export type ExtractResult =
  | { ok: true; data: PricingSnapshotData; inputTokens: number; outputTokens: number; costMicros: number; attempts: number }
  | { ok: false; reason: 'oversized' | 'invalid' | 'ungrounded'; detail: string };

/**
 * One schema-constrained call, wrapped in two deterministic guards: the token
 * budget before, and the grounding assertion after. The model never decides
 * control flow — every retry and refusal here is code (spec 5.1).
 */
export async function extractPricing(text: string, deps: ExtractDeps): Promise<ExtractResult> {
  const maxAttempts = deps.maxAttempts ?? 2;

  const budget = await guardTokens(deps.client, text);
  if (!budget.ok) {
    return { ok: false, reason: 'oversized', detail: `${budget.tokens} tokens exceeds the ${20_000} budget` };
  }

  let lastDetail = 'no attempt made';
  let lastReason: 'invalid' | 'ungrounded' = 'invalid';
  let correction = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await deps.client.messages.parse({
      model: EXTRACT_MODEL,
      max_tokens: 4_000,
      system: SYSTEM,
      messages: [{ role: 'user', content: `${correction}Pricing page text:\n\n${text}` }],
      output_config: { format: zodOutputFormat(PricingSnapshot) },
    });

    const parsed = PricingSnapshot.safeParse(response.parsed_output);
    if (!parsed.success) {
      lastReason = 'invalid';
      lastDetail = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      correction = `Your previous answer did not match the schema (${lastDetail}). Return valid JSON.\n\n`;
      continue;
    }

    const violations = groundingViolations(parsed.data, text);
    if (violations.length > 0) {
      lastReason = 'ungrounded';
      lastDetail = violations.join('; ');
      correction =
        `Your previous answer invented values not present in the page: ${lastDetail}. ` +
        `Use only numbers that literally appear in the text below.\n\n`;
      continue;
    }

    const usage = response.usage ?? { input_tokens: budget.tokens, output_tokens: 0 };
    return {
      ok: true,
      data: parsed.data,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      costMicros: costMicros(usage.input_tokens, usage.output_tokens),
      attempts: attempt,
    };
  }

  return { ok: false, reason: lastReason, detail: lastDetail };
}
