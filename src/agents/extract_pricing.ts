import { APIError } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { PricingSnapshot, type PricingSnapshotData } from '../schema/pricing.js';
import { consistencyViolations, groundingViolations } from '../tools/ground.js';
import { EXTRACT_MODEL, TOKEN_BUDGET, costMicros, guardTokens, type TokenCounter } from './_client.js';

export const SYSTEM = `You extract pricing facts from a SaaS pricing page.

Rules:
- Report only what the page states. Never infer, never estimate, never fill a gap.
- monthly_price_usd is null when the tier says "contact sales" or shows no price.
  null is NOT zero. Use 0 only when the page states the tier costs nothing.
- Pages often show both monthly and annual prices for the same tier — a
  "Pay monthly / Pay annually" toggle, two columns, or "$19/mo billed
  annually". When both are present, record the monthly figure in
  monthly_price_usd and the annual figure in annual_price_usd. Never leave
  both null because two prices were present — a visible number always
  beats null.
- Use null only when the tier genuinely shows no price at all: "Contact
  sales", "Talk to us", "Custom pricing".
- A per-seat price like "$19/user/month" is still the monthly price: put
  19 in monthly_price_usd and record the per-seat framing in billing_unit,
  not by leaving the price null.
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

  // An empty slice can never yield pricing, and the API rejects an empty user
  // message with a 400 that aborts the whole batch — two real archived
  // Supabase captures are JS-only shells that strip to nothing. Refuse here
  // rather than spending a request to be told no.
  if (text.trim() === '') {
    return { ok: false, reason: 'invalid', detail: 'normalized slice is empty — the capture carries no extractable text' };
  }

  const budget = await guardTokens(deps.client, text);
  if (!budget.ok) {
    return { ok: false, reason: 'oversized', detail: `${budget.tokens} tokens exceeds the ${TOKEN_BUDGET} budget` };
  }

  let lastDetail = 'no attempt made';
  let lastReason: 'invalid' | 'ungrounded' = 'invalid';
  let correction = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // The SDK validates parsed_output against the schema itself and THROWS on
    // a mismatch, so the safeParse below never sees that case — it was dead
    // code for exactly the failure it was written to absorb. A real archived
    // Supabase capture answered with more usage_rates than the schema allows
    // and killed a 114-capture backfill mid-run.
    //
    // An APIError is rethrown deliberately. It is transient (529, auth, rate
    // limit), and converting it to `invalid` would let extract.ts record the
    // snapshot as PERMANENTLY unextractable over a blip.
    let response: Awaited<ReturnType<ExtractClient['messages']['parse']>>;
    try {
      response = await deps.client.messages.parse({
        model: EXTRACT_MODEL,
        max_tokens: 4_000,
        system: SYSTEM,
        messages: [{ role: 'user', content: `${correction}Pricing page text:\n\n${text}` }],
        output_config: { format: zodOutputFormat(PricingSnapshot) },
      });
    } catch (err) {
      if (err instanceof APIError) throw err;
      lastReason = 'invalid';
      lastDetail = err instanceof Error ? err.message.split('\n')[0]! : String(err);
      correction = `Your previous answer did not match the schema (${lastDetail}). Return valid JSON.\n\n`;
      continue;
    }

    const parsed = PricingSnapshot.safeParse(response.parsed_output);
    if (!parsed.success) {
      lastReason = 'invalid';
      lastDetail = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      correction = `Your previous answer did not match the schema (${lastDetail}). Return valid JSON.\n\n`;
      continue;
    }

    const violations = [...groundingViolations(parsed.data, text), ...consistencyViolations(parsed.data)];
    if (violations.length > 0) {
      lastReason = 'ungrounded';
      lastDetail = violations.join('; ');
      correction =
        `Your previous answer invented values not present in the page, or contradicted itself: ${lastDetail}. ` +
        `Use only numbers that literally appear in the text below, and keep is_free consistent with monthly_price_usd.\n\n`;
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
