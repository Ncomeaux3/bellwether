import { describe, expect, it } from 'vitest';
import { extractPricing, SYSTEM } from '../src/agents/extract_pricing.js';
import { TOKEN_BUDGET } from '../src/agents/_client.js';
import type { PricingSnapshotData } from '../src/schema/pricing.js';

const SOURCE = 'Free $0/mo. Pro $20/mo. Enterprise contact sales.';

function data(over: Partial<PricingSnapshotData> = {}): PricingSnapshotData {
  return {
    currency: 'USD',
    tiers: [{
      name: 'Pro', monthly_price_usd: 20, annual_price_usd: null,
      billing_unit: 'per_seat', included_seats: null,
      is_free: false, is_enterprise: false, headline_features: [],
    }],
    usage_rates: [], notes: null, extraction_confidence: 'high', ...over,
  };
}

/** Returns a scripted sequence of parse() results; records prompts seen. */
function fakeClient(results: Array<{ parsed_output: unknown; usage?: { input_tokens: number; output_tokens: number } }>, tokens = 6_000) {
  const prompts: string[] = [];
  let i = 0;
  return {
    prompts,
    messages: {
      countTokens: async () => ({ input_tokens: tokens }),
      parse: async (args: { messages: Array<{ content: string }> }) => {
        prompts.push(args.messages.map(m => m.content).join('\n'));
        const r = results[Math.min(i++, results.length - 1)]!;
        return { parsed_output: r.parsed_output, usage: r.usage ?? { input_tokens: 6_000, output_tokens: 600 } };
      },
    },
  };
}

/** A client whose parse() throws, to model the SDK's own schema validation. */
function throwingClient(error: unknown, tokens = 6_000) {
  let calls = 0;
  return {
    get calls() { return calls; },
    messages: {
      countTokens: async () => ({ input_tokens: tokens }),
      parse: async () => { calls += 1; throw error; },
    },
  };
}

describe('extractPricing on an empty slice', () => {
  it('refuses without spending a request', async () => {
    // Two real archived Supabase captures are JS-only shells that strip to
    // nothing. The API rejects an empty user message with a 400, which would
    // abort an entire backfill batch.
    let calls = 0;
    const client = {
      messages: {
        countTokens: async () => { calls += 1; return { input_tokens: 0 }; },
        parse: async () => { calls += 1; throw new Error('should never be called'); },
      },
    };

    const result = await extractPricing('   \n  ', { client: client as never });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('invalid');
    expect(result.detail).toContain('empty');
    expect(calls).toBe(0);
  });
});

describe('extractPricing when the SDK itself rejects the answer', () => {
  it('degrades to invalid instead of killing the run', async () => {
    // The real crash: a Supabase capture answered with more usage_rates than
    // the schema allowed. `messages.parse` throws, so the safeParse fallback
    // never ran and the exception escaped all the way out of a 114-capture
    // backfill.
    const client = throwingClient(new Error('Failed to parse structured output: [\n {...}\n]'));

    const result = await extractPricing(SOURCE, { client: client as never });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('invalid');
    expect(result.detail).toContain('Failed to parse structured output');
    expect(client.calls).toBe(2);   // retried with a correction before giving up
  });

  it('rethrows a transient API error rather than calling it invalid', async () => {
    // extract.ts records an `invalid` historical result as PERMANENTLY
    // unextractable and never retries it. Converting a 529 into that would
    // discard a capture over a blip, so APIError must propagate.
    const { APIError } = await import('@anthropic-ai/sdk');
    const client = throwingClient(new APIError(529, undefined, 'overloaded', undefined));

    await expect(extractPricing(SOURCE, { client: client as never })).rejects.toThrow();
    expect(client.calls).toBe(1);   // no retry loop on a transient failure
  });
});

describe('extractPricing', () => {
  it('returns validated, grounded data on the happy path', async () => {
    const client = fakeClient([{ parsed_output: data() }]);
    const r = await extractPricing(SOURCE, { client });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.tiers[0]!.monthly_price_usd).toBe(20);
    expect(r.attempts).toBe(1);
    expect(r.costMicros).toBe(9_000);   // 6000 in + 600 out
  });

  it('refuses to send an oversized request', async () => {
    const client = fakeClient([{ parsed_output: data() }], TOKEN_BUDGET + 1);
    const r = await extractPricing(SOURCE, { client });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('oversized');
    expect(r.detail).toContain(String(TOKEN_BUDGET));   // message tracks the real budget, not a stale hardcode
    expect(client.prompts).toHaveLength(0);   // never called parse
  });

  it('retries once when the model returns nothing parseable', async () => {
    const client = fakeClient([{ parsed_output: null }, { parsed_output: data() }]);
    const r = await extractPricing(SOURCE, { client });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.attempts).toBe(2);
  });

  it('gives up as invalid after the retry also fails', async () => {
    const client = fakeClient([{ parsed_output: null }, { parsed_output: null }]);
    const r = await extractPricing(SOURCE, { client });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid');
  });

  it('retries a fabricated price and names the violation in the retry prompt', async () => {
    const fabricated = data({ tiers: [{ ...data().tiers[0]!, monthly_price_usd: 99 }] });
    const client = fakeClient([{ parsed_output: fabricated }, { parsed_output: data() }]);
    const r = await extractPricing(SOURCE, { client });
    expect(r.ok).toBe(true);
    expect(client.prompts).toHaveLength(2);
    expect(client.prompts[1]).toContain('99');
  });

  it('refuses to return ungrounded data when the retry is also fabricated', async () => {
    const fabricated = data({ tiers: [{ ...data().tiers[0]!, monthly_price_usd: 99 }] });
    const client = fakeClient([{ parsed_output: fabricated }, { parsed_output: fabricated }]);
    const r = await extractPricing(SOURCE, { client });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('ungrounded');
    expect(r.detail).toContain('99');
  });

  it('retries a self-contradictory is_free/price pair and names it in the retry prompt', async () => {
    const contradictory = data({ tiers: [{ ...data().tiers[0]!, is_free: true, monthly_price_usd: null }] });
    const fixed = data({ tiers: [{ ...data().tiers[0]!, is_free: true, monthly_price_usd: 0 }] });
    const client = fakeClient([{ parsed_output: contradictory }, { parsed_output: fixed }]);
    const r = await extractPricing('Free $0/mo.', { client });
    expect(r.ok).toBe(true);
    expect(client.prompts).toHaveLength(2);
    expect(client.prompts[1]).toContain('is_free');
  });

  it('refuses to return self-contradictory data when the retry is also contradictory', async () => {
    const contradictory = data({ tiers: [{ ...data().tiers[0]!, is_free: true, monthly_price_usd: null }] });
    const client = fakeClient([{ parsed_output: contradictory }, { parsed_output: contradictory }]);
    const r = await extractPricing('Free $0/mo.', { client });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('ungrounded');
    expect(r.detail).toContain('is_free');
  });

  it('rejects output that fails Zod validation', async () => {
    const client = fakeClient([{ parsed_output: { currency: 'USD' } }, { parsed_output: { currency: 'USD' } }]);
    const r = await extractPricing(SOURCE, { client });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid');
  });

  it('sends the page text to the model', async () => {
    const client = fakeClient([{ parsed_output: data() }]);
    await extractPricing(SOURCE, { client });
    expect(client.prompts[0]).toContain(SOURCE);
  });

  it('tells the model how to handle a monthly/annual toggle', () => {
    expect(SYSTEM).toContain('monthly_price_usd');
    expect(SYSTEM).toContain('annual_price_usd');
    expect(SYSTEM).toMatch(/annual/i);
    expect(SYSTEM).toMatch(/Never leave\s+both null/);
  });
});
