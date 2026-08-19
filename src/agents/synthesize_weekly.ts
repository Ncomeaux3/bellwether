import { APIError } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { SYNTH_PROMPT_VERSION, WeeklySynthesis, type WeeklySynthesisData } from '../schema/synthesis.js';
import { SYNTH_MODEL, synthCostMicros } from './_client.js';
import type { ExtractClient } from './extract_pricing.js';

export const SYSTEM = `You write the Bellwether digest: a short, factual brief on SaaS pricing
changes, for readers who track competitor pricing professionally.

Rules:
- Every claim must come from the change list you are given. Never invent a
  number, a company, or a date. Reference changes only by their index.
- annotations: one per change, in the same order. implication states what
  changed in plain terms; so_what states why a buyer or competitor would care.
- digest_markdown: at most five short sections, ranked by how much money the
  change moves for a typical customer. Cross-time patterns (a vendor's second
  raise this year, an industry-wide direction) are the most valuable content —
  the prior digests are provided so you can see them.
- Sentence case. No hype, no adjectives where a number will do.
- confidence is "low" when the change's meaning is ambiguous from the data.`;

export interface ChangeForSynthesis {
  id: number;
  competitor: string;
  observed_at: string;
  change_type: string;
  json_path: string;
  before: string | null;
  after: string | null;
}

export type SynthesizeResult =
  | { ok: true; data: WeeklySynthesisData; changeIdByIndex: Map<number, number>;
      inputTokens: number; outputTokens: number; costMicros: number; attempts: number }
  | { ok: false; reason: 'invalid' | 'unindexed'; detail: string };

export interface SynthesizeDeps { client: ExtractClient; maxAttempts?: number }

/** One schema-constrained call. Every retry and refusal is code (spec 5.1/13). */
export async function synthesizeWeekly(
  changes: ChangeForSynthesis[],
  priorDigests: string[],
  deps: SynthesizeDeps,
): Promise<SynthesizeResult> {
  const maxAttempts = deps.maxAttempts ?? 2;

  const payload = [
    'Confirmed changes (reference by index):',
    ...changes.map((c, i) =>
      `[${i}] ${c.competitor} ${c.observed_at.slice(0, 10)} ${c.change_type} ${c.json_path}: ` +
      `${c.before ?? 'none'} -> ${c.after ?? 'none'}`),
    '',
    priorDigests.length ? 'Prior digests, newest first:' : 'No prior digests.',
    ...priorDigests.map((d, i) => `--- digest ${i + 1} ---\n${d.slice(0, 2000)}`),
  ].join('\n');

  let lastDetail = 'no attempt made';
  let lastReason: 'invalid' | 'unindexed' = 'invalid';
  let correction = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Awaited<ReturnType<ExtractClient['messages']['parse']>>;
    try {
      response = await deps.client.messages.parse({
        model: SYNTH_MODEL,
        max_tokens: 4_000,
        system: SYSTEM,
        messages: [{ role: 'user', content: `${correction}${payload}` }],
        output_config: { format: zodOutputFormat(WeeklySynthesis) },
      });
    } catch (err) {
      // Transient API errors propagate — never recorded as a bad synthesis.
      if (err instanceof APIError) throw err;
      lastReason = 'invalid';
      lastDetail = err instanceof Error ? err.message.split('\n')[0]! : String(err);
      correction = `Your previous answer did not match the schema (${lastDetail}). Return valid JSON.\n\n`;
      continue;
    }

    const parsed = WeeklySynthesis.safeParse(response.parsed_output);
    if (!parsed.success) {
      lastReason = 'invalid';
      lastDetail = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      correction = `Your previous answer did not match the schema (${lastDetail}). Return valid JSON.\n\n`;
      continue;
    }

    // The one grounding rule that matters here: every index must exist.
    const indexes = [...parsed.data.annotations.map(a => a.index), ...parsed.data.top.map(t => t.index)];
    const bad = indexes.filter(i => i >= changes.length);
    if (bad.length > 0) {
      lastReason = 'unindexed';
      lastDetail = `referenced nonexistent change index(es) ${bad.join(', ')} of ${changes.length}`;
      correction = `You referenced change indexes that do not exist (${lastDetail}). Only use indexes 0..${changes.length - 1}.\n\n`;
      continue;
    }

    const usage = response.usage ?? { input_tokens: 0, output_tokens: 0 };
    return {
      ok: true,
      data: parsed.data,
      changeIdByIndex: new Map(changes.map((c, i) => [i, c.id])),
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      costMicros: synthCostMicros(usage.input_tokens, usage.output_tokens),
      attempts: attempt,
    };
  }

  return { ok: false, reason: lastReason, detail: lastDetail };
}

export { SYNTH_PROMPT_VERSION };
