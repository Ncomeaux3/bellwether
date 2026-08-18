import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { seedCompetitors } from '../src/config/seed.js';
import { COMPETITORS } from '../src/config/competitors.public.js';
import type { CompetitorConfig } from '../src/config/types.js';

let dir: string;
let db: DB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-seed-'));
  db = openDb(join(dir, 'test.db'));
  migrate(db, join(process.cwd(), 'migrations'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const sample: CompetitorConfig[] = [
  {
    slug: 'acme',
    name: 'Acme',
    homepage: 'https://acme.test',
    sources: [
      { kind: 'pricing', url: 'https://acme.test/pricing', canaryString: 'Enterprise', cadenceHours: 24 },
    ],
  },
];

describe('seedCompetitors', () => {
  it('inserts competitors and their sources', () => {
    const stats = seedCompetitors(db, sample);
    expect(stats).toEqual({ competitors: 1, sources: 1 });

    const row = db.prepare('SELECT slug, name FROM competitors').get() as { slug: string; name: string };
    expect(row.slug).toBe('acme');
  });

  it('is idempotent — running twice does not duplicate rows', () => {
    seedCompetitors(db, sample);
    seedCompetitors(db, sample);

    const c = db.prepare('SELECT COUNT(*) AS n FROM competitors').get() as { n: number };
    const s = db.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number };
    expect(c.n).toBe(1);
    expect(s.n).toBe(1);
  });

  it('updates a changed canary string in place', () => {
    seedCompetitors(db, sample);
    const changed: CompetitorConfig[] = [{
      ...sample[0]!,
      sources: [{ ...sample[0]!.sources[0]!, canaryString: 'Business' }],
    }];
    seedCompetitors(db, changed);

    const row = db.prepare('SELECT canary_string FROM sources').get() as { canary_string: string };
    expect(row.canary_string).toBe('Business');
  });

  it('never clears degraded_reason as a side effect of reseeding', () => {
    seedCompetitors(db, sample);
    db.prepare("UPDATE sources SET degraded_reason = 'canary missing'").run();
    seedCompetitors(db, sample);

    const row = db.prepare('SELECT degraded_reason FROM sources').get() as { degraded_reason: string | null };
    expect(row.degraded_reason).toBe('canary missing');
  });
});

describe('COMPETITORS', () => {
  it('contains the six sources verified server-rendered in spec 11.1', () => {
    expect(COMPETITORS).toHaveLength(6);
    expect(COMPETITORS.map(c => c.slug).sort()).toEqual(
      ['figma', 'linear', 'notion', 'postman', 'sentry', 'supabase']
    );
  });

  it('gives every source an https url and a non-empty canary', () => {
    for (const c of COMPETITORS) {
      for (const s of c.sources) {
        expect(s.url.startsWith('https://')).toBe(true);
        expect(s.canaryString.length).toBeGreaterThan(0);
      }
    }
  });
});
