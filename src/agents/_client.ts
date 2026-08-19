import Anthropic from '@anthropic-ai/sdk';
import type { DB } from '../ops/db.js';

export const EXTRACT_MODEL = 'claude-haiku-4-5';

/** Spec 9.2. Figma's raw page is 2.3 MB and is the reason this exists. */
export const TOKEN_BUDGET = 20_000;

/** Claude Haiku 4.5: $1.00 per Mtok input, $5.00 per Mtok output. */
const INPUT_MICROS_PER_TOKEN = 1;      // $1.00 / 1e6 tokens = 1 micro-dollar
const OUTPUT_MICROS_PER_TOKEN = 5;

const DEFAULT_MONTHLY_BUDGET_USD = 5;

export class BudgetExceededError extends Error {
  constructor(spentMicros: number, capMicros: number) {
    super(
      `Monthly LLM budget exhausted: $${(spentMicros / 1e6).toFixed(2)} spent of ` +
      `$${(capMicros / 1e6).toFixed(2)} cap. Raise BELLWETHER_MONTHLY_BUDGET_USD in .env ` +
      `or wait for the calendar month to roll over.`,
    );
    this.name = 'BudgetExceededError';
  }
}

/**
 * Spec 15.1. Defaults to OFF: spending money is opted into, never inherited
 * from a missing variable. CI runs in this mode.
 */
export function llmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LLM_ENABLED === 'true';
}

export function costMicros(inputTokens: number, outputTokens: number): number {
  return inputTokens * INPUT_MICROS_PER_TOKEN + outputTokens * OUTPUT_MICROS_PER_TOKEN;
}

/** Spec 15.2: recurring spend only — is_backfill rows have their own budget. */
export function monthlySpendMicros(db: DB, now: Date = new Date()): number {
  const monthStart = `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`;
  const row = db.prepare(`
    SELECT COALESCE(SUM(cost_micros), 0) AS total FROM (
      SELECT cost_micros, created_at FROM extractions WHERE is_backfill = 0
      UNION ALL
      SELECT cost_micros, created_at FROM digests
    ) WHERE created_at >= ?
  `).get(monthStart) as { total: number };
  return row.total;
}

export interface BudgetDeps { now?: () => Date; env?: NodeJS.ProcessEnv }

/**
 * Called before every LLM request. Refuses rather than overspending.
 *
 * A blank/whitespace-only override is treated as unset (falls back to the
 * default), same as a missing variable — an operator who genuinely wants a
 * zero cap can write "0", which is unambiguous. A non-numeric override also
 * falls back to the default rather than producing a NaN cap.
 */
export function assertWithinBudget(db: DB, deps: BudgetDeps = {}): void {
  const env = deps.env ?? process.env;
  const now = (deps.now ?? (() => new Date()))();
  const rawBudget = env.BELLWETHER_MONTHLY_BUDGET_USD?.trim();
  const capUsd = rawBudget ? Number(rawBudget) : DEFAULT_MONTHLY_BUDGET_USD;
  const capMicros = Math.round((Number.isFinite(capUsd) ? capUsd : DEFAULT_MONTHLY_BUDGET_USD) * 1e6);
  const spent = monthlySpendMicros(db, now);
  if (spent >= capMicros) throw new BudgetExceededError(spent, capMicros);
}

export interface TokenCounter {
  messages: { countTokens(args: unknown): Promise<{ input_tokens: number }> };
}

/**
 * Spec 9.2. Uses the real countTokens endpoint, so the check is measured
 * rather than estimated. An over-budget request is never sent.
 */
export async function guardTokens(
  client: TokenCounter,
  text: string,
): Promise<{ ok: boolean; tokens: number }> {
  const { input_tokens } = await client.messages.countTokens({
    model: EXTRACT_MODEL,
    messages: [{ role: 'user', content: text }],
  });
  return { ok: input_tokens <= TOKEN_BUDGET, tokens: input_tokens };
}

let cached: Anthropic | undefined;

/** Constructed lazily so no test and no LLM_ENABLED=false run ever needs a key. */
export function anthropic(): Anthropic {
  cached ??= new Anthropic();
  return cached;
}
