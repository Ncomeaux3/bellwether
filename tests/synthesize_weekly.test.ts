import { describe, expect, it } from 'vitest';
import { synthesizeWeekly, type ChangeForSynthesis } from '../src/agents/synthesize_weekly.js';
import { synthCostMicros } from '../src/agents/_client.js';
import type { WeeklySynthesisData } from '../src/schema/synthesis.js';

const CHANGES: ChangeForSynthesis[] = [
  { id: 101, competitor: 'Acme', observed_at: '2026-08-10T00:00:00.000Z', change_type: 'price_increase', json_path: 'tiers[0].monthly_price_usd', before: '19', after: '25' },
  { id: 202, competitor: 'Beta', observed_at: '2026-08-11T00:00:00.000Z', change_type: 'tier_added', json_path: 'tiers[2]', before: null, after: 'Team' },
];

function data(over: Partial<WeeklySynthesisData> = {}): WeeklySynthesisData {
  return {
    annotations: [
      { index: 0, implication: 'Acme raised its Pro tier.', so_what: 'Buyers should budget more.', confidence: 'high' },
      { index: 1, implication: 'Beta added a Team tier.', so_what: 'New mid-market option.', confidence: 'medium' },
    ],
    digest_markdown: '## This week\nAcme raised prices; Beta added a tier.',
    top: [{ index: 0, headline: 'Acme raises Pro tier price' }],
    ...over,
  };
}

/** Returns a scripted sequence of parse() results; records prompts seen. */
function fakeClient(results: Array<{ parsed_output: unknown; usage?: { input_tokens: number; output_tokens: number } }>) {
  const prompts: string[] = [];
  let i = 0;
  return {
    prompts,
    messages: {
      countTokens: async () => ({ input_tokens: 1_000 }),
      parse: async (args: { messages: Array<{ content: string }> }) => {
        prompts.push(args.messages.map(m => m.content).join('\n'));
        const r = results[Math.min(i++, results.length - 1)]!;
        return { parsed_output: r.parsed_output, usage: r.usage ?? { input_tokens: 1_000, output_tokens: 200 } };
      },
    },
  };
}

/** A client whose parse() throws, to model a transient API failure. */
function throwingClient(error: unknown) {
  let calls = 0;
  return {
    get calls() { return calls; },
    messages: {
      countTokens: async () => ({ input_tokens: 1_000 }),
      parse: async () => { calls += 1; throw error; },
    },
  };
}

describe('synthCostMicros', () => {
  it('prices at sonnet rates', () => {
    expect(synthCostMicros(1000, 200)).toBe(6000);
  });
});

describe('synthesizeWeekly', () => {
  it('returns validated data with change ids mapped by index', async () => {
    const client = fakeClient([{ parsed_output: data() }]);
    const r = await synthesizeWeekly(CHANGES, [], { client });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.attempts).toBe(1);
    expect(r.changeIdByIndex.get(0)).toBe(101);
    expect(r.changeIdByIndex.get(1)).toBe(202);
    expect(r.costMicros).toBe(6_000);
  });

  it('retries exactly once on an out-of-range index, naming it in the correction prompt', async () => {
    const badTop = data({ top: [{ index: 5, headline: 'Nonexistent change' }] });
    const client = fakeClient([{ parsed_output: badTop }, { parsed_output: data() }]);
    const r = await synthesizeWeekly(CHANGES, [], { client });
    expect(r.ok).toBe(true);
    expect(client.prompts).toHaveLength(2);
    expect(client.prompts[1]).toContain('do not exist');
  });

  it('gives up as unindexed after the retry also references a bad index', async () => {
    const badTop = data({ top: [{ index: 5, headline: 'Nonexistent change' }] });
    const client = fakeClient([{ parsed_output: badTop }, { parsed_output: badTop }]);
    const r = await synthesizeWeekly(CHANGES, [], { client });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('unindexed');
  });

  it('rethrows a transient API error rather than recording a bad synthesis', async () => {
    const { APIError } = await import('@anthropic-ai/sdk');
    const client = throwingClient(new APIError(529, undefined, 'overloaded', undefined));
    await expect(synthesizeWeekly(CHANGES, [], { client: client as never })).rejects.toThrow();
    expect(client.calls).toBe(1);   // no retry loop on a transient failure
  });

  it('rejects a top list with more than 5 entries', async () => {
    const tooManyTop = data({
      top: Array.from({ length: 6 }, (_, i) => ({ index: 0, headline: `Headline ${i}` })),
    });
    const client = fakeClient([{ parsed_output: tooManyTop }, { parsed_output: tooManyTop }]);
    const r = await synthesizeWeekly(CHANGES, [], { client });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid');
  });
});
