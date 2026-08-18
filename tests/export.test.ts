import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/ops/db.js';
import { migrate } from '../src/ops/migrate.js';
import { seedCompetitors } from '../src/config/seed.js';
import { collect } from '../src/workflow/collect.js';
import { ExportGuardError, exportData } from '../src/workflow/export.js';
import type { CompetitorConfig } from '../src/config/types.js';

let dir: string;
let out: string;
let db: DB;

const CONFIG: CompetitorConfig[] = [
  { slug: 'acme', name: 'Acme', homepage: 'https://acme.test',
    sources: [{ kind: 'pricing', url: 'https://acme.test/pricing', canaryString: 'Enterprise', cadenceHours: 24 }] },
  { slug: 'beta', name: 'Beta', homepage: 'https://beta.test',
    sources: [{ kind: 'pricing', url: 'https://beta.test/pricing', canaryString: 'Enterprise', cadenceHours: 24 }] },
];

const GOOD = '<html><h2>Pro</h2><p>$20</p><h2>Enterprise</h2></html>';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bw-export-'));
  out = join(dir, 'data');
  mkdirSync(out, { recursive: true });
  db = openDb(join(dir, 'test.db'));
  migrate(db, join(process.cwd(), 'migrations'));
  seedCompetitors(db, CONFIG);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function read(name: string): any {
  return JSON.parse(readFileSync(join(out, name), 'utf8'));
}

async function populate() {
  await collect(db, {}, {
    fetcher: async () => ({ ok: true, httpStatus: 200, body: GOOD, error: null }),
    now: () => new Date('2026-08-18T12:00:00.000Z'),
  });
}

describe('exportData', () => {
  it('writes board.json and status.json', async () => {
    await populate();
    const stats = exportData(db, out);

    expect(stats.files.sort()).toEqual(['board.json', 'status.json']);
    expect(stats.competitors).toBe(2);
  });

  it('describes each competitor and source in board.json', async () => {
    await populate();
    exportData(db, out);
    const board = read('board.json');

    expect(board.competitors).toHaveLength(2);
    const acme = board.competitors.find((c: any) => c.slug === 'acme');
    expect(acme.name).toBe('Acme');
    expect(acme.sources[0].state).toBe('ok');
    expect(acme.sources[0].last_ok_at).toBe('2026-08-18T12:00:00.000Z');
    expect(acme.sources[0].distinct_states).toBe(1);
  });

  it('reports a degraded source as degraded', async () => {
    await collect(db, {}, {
      fetcher: async () => ({ ok: true, httpStatus: 200, body: '<html>nothing</html>', error: null }),
      now: () => new Date('2026-08-18T12:00:00.000Z'),
    });
    exportData(db, out);

    const board = read('board.json');
    expect(board.competitors[0].sources[0].state).toBe('degraded');
    expect(board.competitors[0].sources[0].degraded_reason).toMatch(/canary/i);
  });

  it('reports a source whose last fetch failed as failing', async () => {
    await collect(db, {}, {
      fetcher: async () => ({ ok: false, httpStatus: 503, body: null, error: 'HTTP 503' }),
      now: () => new Date('2026-08-18T12:00:00.000Z'),
    });
    exportData(db, out);

    expect(read('board.json').competitors[0].sources[0].state).toBe('failing');
  });

  it('counts healthy sources in status.json', async () => {
    await populate();
    exportData(db, out);
    const status = read('status.json');

    expect(status.total_sources).toBe(2);
    expect(status.healthy_sources).toBe(2);
    expect(status.cost_micros_month).toBe(0);
  });

  it('refuses to publish when there are no competitors', () => {
    const empty = openDb(join(dir, 'empty.db'));
    migrate(empty, join(process.cwd(), 'migrations'));

    expect(() => exportData(empty, out)).toThrow(ExportGuardError);
    empty.close();
  });

  it('refuses to publish fewer competitors than last time', async () => {
    await populate();
    exportData(db, out);

    db.prepare("UPDATE competitors SET active = 0 WHERE slug = 'beta'").run();
    expect(() => exportData(db, out)).toThrow(/fewer competitors/i);
  });

  it('refuses to publish a file that shrank by more than half', async () => {
    await populate();
    exportData(db, out);
    writeFileSync(join(out, 'status.json'), JSON.stringify({ padding: 'x'.repeat(20_000) }));

    expect(() => exportData(db, out)).toThrow(/shrank/i);
  });

  it('leaves the previous files untouched when a guard trips', async () => {
    await populate();
    exportData(db, out);
    const before = readFileSync(join(out, 'board.json'), 'utf8');

    db.prepare("UPDATE competitors SET active = 0 WHERE slug = 'beta'").run();
    expect(() => exportData(db, out)).toThrow();

    expect(readFileSync(join(out, 'board.json'), 'utf8')).toBe(before);
  });
});
