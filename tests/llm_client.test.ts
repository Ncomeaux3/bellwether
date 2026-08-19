import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import {
  BudgetExceededError, assertWithinBudget, costMicros,
  guardTokens, llmEnabled, monthlySpendMicros, TOKEN_BUDGET,
} from '../src/agents/_client.js';

let dir: string; let db: DB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-llm-'));
  db = openDb(join(dir, 'test.db'));
  migrate(db, join(process.cwd(), 'migrations'));
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function addExtraction(costMicrosValue: number, createdAt: string, isBackfill = 0) {
  db.prepare(`INSERT INTO extractions
    (normalized_hash, source_kind, data_json, extraction_confidence, is_backfill,
     model, prompt_version, cost_micros, created_at)
    VALUES (?, 'pricing', '{}', 'high', ?, 'claude-haiku-4-5', 'v', ?, ?)`)
    .run(Math.random().toString(36).slice(2), isBackfill, costMicrosValue, createdAt);
}

describe('llmEnabled', () => {
  it('is off when LLM_ENABLED is false', () => {
    expect(llmEnabled({ LLM_ENABLED: 'false' } as NodeJS.ProcessEnv)).toBe(false);
  });
  it('is on when LLM_ENABLED is true', () => {
    expect(llmEnabled({ LLM_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });
  it('defaults to off when unset — spending must be opted into', () => {
    expect(llmEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('costMicros', () => {
  it('prices Haiku 4.5 at $1/Mtok in and $5/Mtok out', () => {
    // 1M input = $1.00 = 1_000_000 micros; 1M output = $5.00 = 5_000_000 micros.
    expect(costMicros(1_000_000, 0)).toBe(1_000_000);
    expect(costMicros(0, 1_000_000)).toBe(5_000_000);
    expect(costMicros(6_000, 600)).toBe(9_000);  // 6000 + 3000
  });
});

describe('monthlySpendMicros', () => {
  const now = () => new Date('2026-08-18T12:00:00.000Z');

  it('sums this month only', () => {
    addExtraction(1_000, '2026-08-02T00:00:00.000Z');
    addExtraction(2_000, '2026-08-17T00:00:00.000Z');
    addExtraction(9_999, '2026-07-31T23:59:59.000Z');
    expect(monthlySpendMicros(db, now())).toBe(3_000);
  });

  it('excludes backfill rows — bulk history has its own budget', () => {
    addExtraction(1_000, '2026-08-02T00:00:00.000Z');
    addExtraction(500_000, '2026-08-03T00:00:00.000Z', 1);
    expect(monthlySpendMicros(db, now())).toBe(1_000);
  });

  it('is zero on an empty database', () => {
    expect(monthlySpendMicros(db, now())).toBe(0);
  });
});

describe('assertWithinBudget', () => {
  const deps = { now: () => new Date('2026-08-18T12:00:00.000Z'), env: {} as NodeJS.ProcessEnv };

  it('passes below the ceiling', () => {
    addExtraction(1_000_000, '2026-08-02T00:00:00.000Z');   // $1.00
    expect(() => assertWithinBudget(db, deps)).not.toThrow();
  });

  it('throws at the ceiling', () => {
    addExtraction(5_000_000, '2026-08-02T00:00:00.000Z');   // $5.00
    expect(() => assertWithinBudget(db, deps)).toThrow(BudgetExceededError);
  });

  it('honours an override ceiling', () => {
    addExtraction(1_500_000, '2026-08-02T00:00:00.000Z');
    const env = { BELLWETHER_MONTHLY_BUDGET_USD: '1.00' } as NodeJS.ProcessEnv;
    expect(() => assertWithinBudget(db, { ...deps, env })).toThrow(BudgetExceededError);
  });

  it('names the spend and the cap so the operator can act', () => {
    addExtraction(5_000_000, '2026-08-02T00:00:00.000Z');
    expect(() => assertWithinBudget(db, deps)).toThrow(/5\.00.*5\.00|\$5\.00/);
  });
});

describe('guardTokens', () => {
  const counter = (n: number) => ({ messages: { countTokens: async () => ({ input_tokens: n }) } });

  it('accepts text under budget', async () => {
    expect(await guardTokens(counter(6_000), 'x')).toEqual({ ok: true, tokens: 6_000 });
  });

  it('rejects text over budget rather than sending it', async () => {
    const r = await guardTokens(counter(TOKEN_BUDGET + 1), 'x');
    expect(r.ok).toBe(false);
  });

  it('accepts text exactly at the budget', async () => {
    expect((await guardTokens(counter(TOKEN_BUDGET), 'x')).ok).toBe(true);
  });
});
